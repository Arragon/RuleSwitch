import { describe, expect, it } from "vitest";

import { TRANSACTION_STATES } from "../contracts";
import {
  assertTransactionTransition,
  canTransitionTransaction,
  isTerminalTransactionState,
  TERMINAL_TRANSACTION_STATES,
  TRANSACTION_TRANSITIONS
} from "../transactions";

describe("ApplyTransaction state machine", () => {
  it("defines the successful apply path explicitly", () => {
    const successPath = [
      "PREPARING",
      "STAGED",
      "PREFLIGHT",
      "BACKED_UP",
      "APPLYING",
      "VERIFYING",
      "COMMITTED"
    ] as const;

    for (let index = 1; index < successPath.length; index += 1) {
      const from = successPath[index - 1];
      const to = successPath[index];
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      if (from !== undefined && to !== undefined) {
        expect(canTransitionTransaction(from, to)).toBe(true);
      }
    }
  });

  it("defines failure, rollback, and recovery transitions", () => {
    expect(canTransitionTransaction("APPLYING", "FAILED")).toBe(true);
    expect(canTransitionTransaction("FAILED", "ROLLING_BACK")).toBe(true);
    expect(canTransitionTransaction("ROLLING_BACK", "ROLLED_BACK")).toBe(true);
    expect(canTransitionTransaction("FAILED", "RECOVERY_REQUIRED")).toBe(true);
    expect(canTransitionTransaction("ROLLING_BACK", "RECOVERY_REQUIRED")).toBe(true);
  });

  it("rejects skipped, reversed, and self transitions", () => {
    expect(canTransitionTransaction("PREPARING", "APPLYING")).toBe(false);
    expect(canTransitionTransaction("VERIFYING", "BACKED_UP")).toBe(false);
    expect(canTransitionTransaction("STAGED", "STAGED")).toBe(false);
    expect(() => assertTransactionTransition("PREPARING", "COMMITTED")).toThrow(
      "Invalid ApplyTransaction transition"
    );
  });

  it("makes every terminal state transition-free", () => {
    expect(TERMINAL_TRANSACTION_STATES).toEqual([
      "COMMITTED",
      "ROLLED_BACK",
      "RECOVERY_REQUIRED"
    ]);

    for (const state of TRANSACTION_STATES) {
      const terminal = TERMINAL_TRANSACTION_STATES.includes(state);
      expect(isTerminalTransactionState(state)).toBe(terminal);
      if (terminal) {
        expect(TRANSACTION_TRANSITIONS[state]).toEqual([]);
      }
    }
  });
});
