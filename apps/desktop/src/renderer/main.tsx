import { App, AppV2 } from "@ruleswitch/ui";
import "@ruleswitch/ui/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("The RuleSwitch renderer root is unavailable.");
}

// v1 E2E smoke override pins the v1 workbench so the walking-skeleton
// regression keeps covering the frozen 7-method IPC path. The flag comes
// from the preload (sandbox-safe; renderer cannot read process.env).
const v1SmokeOverride = window.ruleswitchV1SmokeMode === true;
const v2Api = window.ruleswitchV2;
if (v2Api !== undefined && v2Api !== null && !v1SmokeOverride) {
  createRoot(root).render(
    <StrictMode>
      <AppV2 api={v2Api} />
    </StrictMode>
  );
} else {
  createRoot(root).render(
    <StrictMode>
      <App api={window.ruleswitch} />
    </StrictMode>
  );
}
