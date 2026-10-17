import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/db/**"],
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
