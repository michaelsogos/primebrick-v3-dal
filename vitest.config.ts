import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/benchmark/**", "node_modules/**"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
