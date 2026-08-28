import { App } from "@ruleswitch/ui";
import "@ruleswitch/ui/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("The RuleSwitch renderer root is unavailable.");
}

createRoot(root).render(
  <StrictMode>
    <App api={window.ruleswitch} />
  </StrictMode>
);
