import { configDefaults, defineConfig } from "vitest/config";

const DEV_TESTS = "test/dev.test.ts";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    // The first Rust build compiles wstd and its dependencies from scratch.
    hookTimeout: 300_000,
    projects: [
      {
        extends: true,
        test: {
          name: "build",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, DEV_TESTS],
        },
      },
      {
        extends: true,
        test: {
          name: "dev",
          include: [DEV_TESTS],
          // The dev tests time a rebuild after an edit, so they run once the
          // other files' cold builds have stopped competing for the CPU.
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
