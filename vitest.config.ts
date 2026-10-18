import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/db/**", "test/golden/**"],
        },
      },
      {
        test: {
          name: "golden",
          include: ["test/golden/**/*.golden.test.ts"],
          setupFiles: ["test/golden/setup.ts"],
          testTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "db",
          include: ["test/db/**/*.test.ts"],
          globalSetup: ["test/db/global-setup.ts"],
          fileParallelism: false,
          pool: "forks",
          maxWorkers: 1,
        },
      },
    ],
  },
});
