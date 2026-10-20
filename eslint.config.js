import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/node_modules/**",
      "**/coverage/**",
      "test-results/**",
      "playwright-report/**",
      // Not shipped source: the static HTML design prototype (browser script,
      // not part of any build graph) and handoff artifacts / tool state.
      "prototypes/**",
      "outputs/**",
      ".mimosa/**"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Repository build tooling runs directly on Node, not in the bundler.
    files: ["tools/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly"
      }
    }
  },
  {
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "electron",
                "electron/*",
                "react",
                "react/*",
                "rulesync",
                "rulesync/*",
                "node:*",
                "fs",
                "fs/*",
                "path",
                "path/*",
                "process",
                "crypto",
                "crypto/*"
              ],
              message: "packages/core must remain platform- and provider-neutral."
            }
          ]
        }
      ]
    }
  }
);
