import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/integration/**/*.test.ts",
      "packages/**/*.integration.test.ts",
      "apps/**/*.integration.test.ts"
    ],
    exclude: ["**/dist/**", "**/node_modules/**"],
    passWithNoTests: true
  }
});
