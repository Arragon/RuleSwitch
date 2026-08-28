import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/out/**", "**/node_modules/**", "**/coverage/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
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
