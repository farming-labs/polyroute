import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { componentizeGoHint, go } from "./go.js";
import type { RouteBuildResult } from "./types.js";

const routeFile = fileURLToPath(new URL("../../test/fixtures/go/echo/route.go", import.meta.url));

describe("componentizeGoHint", () => {
  it("points Windows users at the manual install when the wrapper's download 404s", () => {
    // The wrapper's output on a GitHub Actions Windows runner.
    const diagnostics =
      "2026/11/16 06:48:55 unexpected status for URL `https://github.com/bytecodealliance/componentize-go/releases/download/v0.5.3/componentize-go-windows-amd64.tar.gz`: 404";
    expect(componentizeGoHint(diagnostics)).toContain('"Go on Windows" in polyroute\'s README');
  });

  it("names the setup commands when componentize-go isn't a tool of the module", () => {
    expect(componentizeGoHint('go: no such tool "componentize-go"')).toContain(
      "go get -tool github.com/bytecodealliance/componentize-go@v0.5.3",
    );
  });

  it("adds nothing for a compile error, whose own output already explains it", () => {
    expect(componentizeGoHint("./route.go:12:2: undefined: wasihttp.Handle")).toBe("");
  });
});

describe("go", () => {
  let workDir: string;
  let result: RouteBuildResult;

  // A fresh CI runner starts with an empty module cache, which is where
  // componentize-go looks for the WASI WIT files.
  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "polyroute-go-"));
    const saved = { GOMODCACHE: process.env.GOMODCACHE, GOFLAGS: process.env.GOFLAGS };
    process.env.GOMODCACHE = path.join(workDir, "modcache");
    // The module cache is read-only by default, and the test removes it afterwards.
    process.env.GOFLAGS = [saved.GOFLAGS, "-modcacherw"].filter(Boolean).join(" ");
    try {
      result = await go.build({
        routeFile,
        label: "go/echo/route.go",
        cacheDir: path.join(workDir, "cache"),
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  afterAll(async () => {
    if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
  });

  it("builds a route when the Go module cache is empty", () => {
    // `\0asm`, version 0x0d, layer 1: a component, not a core module.
    expect([...result.wasm.subarray(0, 8)]).toEqual([
      0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00,
    ]);
  });
});
