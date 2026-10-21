// Dedicated vitest config for the process-crash drill child. Excluded from
// the default unit/integration globs because the child kills its own process
// by design — it is only ever launched by the crash matrix test.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/crash/*.child.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
    pool: "forks"
  }
});
