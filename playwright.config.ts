import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: {
    timeout: 20_000
  },
  reporter: "line",
  use: {
    trace: "retain-on-failure"
  }
});
