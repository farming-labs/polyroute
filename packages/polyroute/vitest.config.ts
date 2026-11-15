import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 30_000,
    // The first Rust build compiles wstd and its dependencies from scratch.
    hookTimeout: 300_000,
  },
});
