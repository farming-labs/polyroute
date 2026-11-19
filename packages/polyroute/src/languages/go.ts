import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { PolyrouteError } from "../errors.js";
import { createQueue, runTool } from "./process.js";
import type { Language, RouteBuildInput, RouteBuildResult } from "./types.js";

export const COMPONENTIZE_GO_VERSION = "v0.5.3";
export const GO_WASI_VERSION = "v0.1.3-0.20261119173204-d97e27847973";

/**
 * Requests one reused Go instance serves before the runtime replaces it.
 *
 * `cabi_realloc` in `go.bytecodealliance.org/pkg` v0.4.1 pins every buffer the
 * host allocates in the guest, such as the strings and lists an import returns,
 * and the generated bindings never unpin them. So an instance's memory grows
 * with every request, and each new pin costs more than the last.
 */
export const GO_REQUESTS_PER_INSTANCE = 1000;

const SETUP = [
  `go get go.bytecodealliance.org/wasi@${GO_WASI_VERSION}`,
  `go get -tool github.com/bytecodealliance/componentize-go@${COMPONENTIZE_GO_VERSION}`,
]
  .map((command) => `\`${command}\``)
  .join(" and ");

const enqueue = createQueue();

export const go: Language = {
  name: "Go",
  extensions: [".go"],
  handlerHint:
    "Register a handler in `init()` with `wasihttp.HandleFunc` from `go.bytecodealliance.org/wasi/wasihttp`.",
  requestsPerInstance: GO_REQUESTS_PER_INSTANCE,
  build: (input) => enqueue(() => buildGoRoute(input)),
};

export async function buildGoRoute({
  routeFile,
  label,
  cacheDir,
}: RouteBuildInput): Promise<RouteBuildResult> {
  const routeDir = path.dirname(routeFile);
  // componentize-go only finds its WIT when it runs from the module root, so
  // each Go route is a module of its own, the way a Rust route can be a crate.
  if (!existsSync(path.join(routeDir, "go.mod"))) {
    const outer = findModuleRoot(path.dirname(routeDir));
    const context =
      outer === undefined
        ? "isn't inside a Go module"
        : `is inside the Go module at \`${outer}\`, but a Go route needs a module of its own`;
    throw new PolyrouteError(
      "BUILD_FAILED",
      `\`${label}\` ${context}. Run \`go mod init <name>\` in the route's directory, then ${SETUP}.`,
    );
  }

  const id = createHash("sha256").update(routeFile).digest("hex").slice(0, 12);
  const outDir = path.join(cacheDir, "go", id);
  await mkdir(outDir, { recursive: true });
  // Builds queue within a process, but another process, such as a second
  // `vite build`, can build the same route at once. Each build writes its own
  // file, so neither reads the other's half-written output.
  const output = path.join(outDir, `route-${randomUUID()}.wasm`);

  const missing = `Building \`${label}\` needs Go 1.27.1 or later, but \`go\` isn't on PATH. Install it from https://go.dev/dl.`;

  // componentize-go finds the WASI WIT files through `go list -m`, which only
  // sees modules that are already in the module cache, so fetch them first.
  const download = await runTool("go", ["mod", "download"], { cwd: routeDir, missing });
  if (download.exitCode !== 0) {
    throw new PolyrouteError(
      "BUILD_FAILED",
      `\`go mod download\` couldn't fetch the modules \`${label}\` needs:\n\n${`${download.stdout}${download.stderr}`.trimEnd()}`,
    );
  }

  try {
    const result = await runTool("go", ["tool", "componentize-go", "build", "-o", output], {
      cwd: routeDir,
      missing,
    });
    if (result.exitCode !== 0) {
      const diagnostics = `${result.stdout}${result.stderr}`.trimEnd();
      throw new PolyrouteError(
        "BUILD_FAILED",
        `componentize-go couldn't build \`${label}\`:\n\n${diagnostics}${componentizeGoHint(diagnostics)}`,
      );
    }
    return { wasm: await readFile(output), sources: await listGoSources(routeDir) };
  } finally {
    await rm(output, { force: true });
  }
}

/** The next step for componentize-go failures whose own output doesn't say how to fix them. */
export function componentizeGoHint(diagnostics: string): string {
  if (diagnostics.includes('no such tool "componentize-go"')) {
    return `\n\nAdd componentize-go to the module: ${SETUP}.`;
  }
  // The wrapper asks for a Windows `.tar.gz`, but releases only ship a `.zip`.
  if (diagnostics.includes("componentize-go-windows-amd64.tar.gz")) {
    return `\n\ncomponentize-go ${COMPONENTIZE_GO_VERSION} can't download its own Windows binary. Put it in place by hand as described in "Go on Windows" in polyroute's README, then build again.`;
  }
  return "";
}

function findModuleRoot(dir: string): string | undefined {
  let current = dir;
  while (true) {
    if (existsSync(path.join(current, "go.mod"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The route's package files plus its go.mod and go.sum, for the dev server to watch. */
async function listGoSources(routeDir: string): Promise<string[]> {
  const entries = await readdir(routeDir);
  const sources = entries
    .filter((entry) => entry.endsWith(".go") && !entry.endsWith("_test.go"))
    .map((entry) => path.join(routeDir, entry));
  for (const file of ["go.mod", "go.sum"]) {
    const candidate = path.join(routeDir, file);
    if (existsSync(candidate)) sources.push(candidate);
  }
  return sources;
}
