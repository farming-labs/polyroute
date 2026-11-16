import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Rolldown } from "vite";
import { polyroute, type PolyrouteOptions } from "../src/index.js";

export const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Shared across tests and runs so wstd compiles once per machine. */
export const cacheDir = fileURLToPath(
  new URL("../node_modules/.cache/polyroute-test/", import.meta.url),
);

export interface BuiltEntry {
  file: string;
  code: string;
}

export async function buildServerEntry(
  entry: string,
  outDir: string,
  root = fixturesDir,
  options: PolyrouteOptions = {},
): Promise<BuiltEntry> {
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    cacheDir,
    plugins: [polyroute(options)],
    build: { ssr: entry, outDir, emptyOutDir: true, minify: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[];
  const chunk = outputs
    .flatMap((output) => output.output)
    .find((item): item is Rolldown.OutputChunk => item.type === "chunk" && item.isEntry);
  if (chunk === undefined) throw new Error(`The build of ${entry} produced no entry chunk.`);
  const file = path.join(outDir, chunk.fileName);
  return { file, code: await readFile(file, "utf8") };
}

export async function buildClientEntry(entry: string, outDir: string): Promise<void> {
  await build({
    root: fixturesDir,
    configFile: false,
    logLevel: "silent",
    cacheDir,
    plugins: [polyroute()],
    build: {
      outDir,
      emptyOutDir: true,
      rolldownOptions: { input: path.join(fixturesDir, entry) },
    },
  });
}
