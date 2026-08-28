import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: ["@ruleswitch/core"] })
    ],
    build: {
      rollupOptions: {
        input: resolve(root, "src/main/index.ts")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@ruleswitch/core", "zod"] })],
    build: {
      rollupOptions: {
        input: resolve(root, "src/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        "@ruleswitch/ui": resolve(root, "../../packages/ui/src")
      }
    },
    build: {
      rollupOptions: {
        input: resolve(root, "src/renderer/index.html")
      }
    }
  }
});
