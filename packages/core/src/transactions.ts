import type { TransactionState } from "./contracts";

function transitions(...states: TransactionState[]): readonly TransactionState[] {
  return Object.freeze(states);
}

export const TRANSACTION_TRANSITIONS: Readonly<
  Record<TransactionState, readonly TransactionState[]>
> = Object.freeze({
  PREPARING: transitions("STAGED", "FAILED"),
  STAGED: transitions("PREFLIGHT", "FAILED"),
  PREFLIGHT: transitions("BACKED_UP", "FAILED"),
  BACKED_UP: transitions("APPLYING", "FAILED"),
  APPLYING: transitions("VERIFYING", "FAILED"),
  VERIFYING: transitions("COMMITTED", "FAILED"),
  COMMITTED: transitions(),
  FAILED: transitions("ROLLING_BACK", "RECOVERY_REQUIRED"),
  ROLLING_BACK: transitions("ROLLED_BACK", "RECOVERY_REQUIRED"),
  ROLLED_BACK: transitions(),
  RECOVERY_REQUIRED: transitions()
});

export const TERMINAL_TRANSACTION_STATES: readonly TransactionState[] = Object.freeze([
  "COMMITTED",
  "ROLLED_BACK",
  "RECOVERY_REQUIRED"
]);

export function canTransitionTransaction(
  from: TransactionState,
  to: TransactionState
): boolean {
  return TRANSACTION_TRANSITIONS[from].includes(to);
}

export function isTerminalTransactionState(state: TransactionState): boolean {
  return TERMINAL_TRANSACTION_STATES.includes(state);
}

export function assertTransactionTransition(
  from: TransactionState,
  to: TransactionState
): void {
  if (!canTransitionTransaction(from, to)) {
    throw new Error(`Invalid ApplyTransaction transition: ${from} -> ${to}`);
  }
}
