import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["dev/测试/单元/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
