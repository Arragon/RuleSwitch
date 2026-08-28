import type { DesktopApi } from "@ruleswitch/core";

declare global {
  interface Window {
    readonly ruleswitch: DesktopApi;
  }
}

export {};
