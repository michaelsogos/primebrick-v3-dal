import { defineConfig } from "vitest/config";

export default defineConfig({
  // Same decorator transform as vitest.config.ts — benchmark entities are
  // decorated classes (@Entity/@Column), they fail to parse without it.
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/benchmark/**/*.test.ts"],
    testTimeout: 600000,     // 10 minutes — 1M records takes time
    hookTimeout: 600000,
    fileParallelism: false,
  },
});
