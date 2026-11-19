// Builds the compiler and the smaller deployment runtime from the same source.
import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const library = {
  darwin: "libpolyroute_wasmtime.dylib",
  linux: "libpolyroute_wasmtime.so",
  win32: "polyroute_wasmtime.dll",
}[process.platform];
if (library === undefined) {
  console.error(`Building the addon on ${process.platform} isn't supported.`);
  process.exit(1);
}
for (const [name, features] of [
  ["polyroute-wasmtime-compiler.node", ["--features", "compiler"]],
  ["polyroute-wasmtime.node", ["--no-default-features"]],
]) {
  const cargo = spawnSync("cargo", ["build", "--release", "--locked", ...features], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (cargo.error) throw cargo.error;
  if (cargo.status !== 0) process.exit(cargo.status ?? 1);
  copyFileSync(`${root}target/release/${library}`, `${root}${name}`);
  console.log(`Wrote ${root}${name}`);
}
