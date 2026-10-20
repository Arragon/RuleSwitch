import type { DesktopApi, DesktopApiV2 } from "@ruleswitch/core";

declare global {
  interface Window {
    readonly ruleswitch: DesktopApi;
    readonly ruleswitchV2: DesktopApiV2;
    /** True when Main was launched with the v1 walking-skeleton smoke env. */
    readonly ruleswitchV1SmokeMode: boolean;
  }
}

export {};
