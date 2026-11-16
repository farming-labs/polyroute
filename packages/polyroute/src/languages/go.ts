import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PolyrouteError } from "../errors.js";
import { createQueue, runTool } from "./process.js";
import type { Language, RouteBuildInput, RouteBuildResult } from "./types.js";

export const COMPONENTIZE_GO_VERSION = "v0.5.3";
export const GO_WASI_VERSION = "v0.1.2";

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
  build: (input) => enqueue(() => buildGoRoute(input)),
};

async function buildGoRoute({
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
  const output = path.join(outDir, "route.wasm");

  const result = await runTool("go", ["tool", "componentize-go", "build", "-o", output], {
    cwd: routeDir,
    missing: `Building \`${label}\` needs Go 1.27.1 or later, but \`go\` isn't on PATH. Install it from https://go.dev/dl.`,
  });
  if (result.exitCode !== 0) {
    const diagnostics = `${result.stdout}${result.stderr}`.trimEnd();
    const hint = diagnostics.includes('no such tool "componentize-go"')
      ? `\n\nAdd componentize-go to the module: ${SETUP}.`
      : "";
    throw new PolyrouteError(
      "BUILD_FAILED",
      `componentize-go couldn't build \`${label}\`:\n\n${diagnostics}${hint}`,
    );
  }

  return { wasm: await readFile(output), sources: await listGoSources(routeDir) };
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
