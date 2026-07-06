import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/benchmark/**/*.test.ts"],
    testTimeout: 600000,     // 10 minutes — 1M records takes time
    hookTimeout: 600000,
    fileParallelism: false,
  },
});
