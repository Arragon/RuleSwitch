import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.unit.test.ts", "apps/**/*.unit.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
