// Onboarding wizard state machine (INH-1809): pure UI-state reducer over
// Main-produced read models. Steps: connect → detect harnesses → bind
// projects → first preview (adoption-gated). Each step maps to a v2
// capability call; no business truth lives here.

import type { OverviewReadModel, ProjectDto } from "@ruleswitch/core";

export const ONBOARDING_STEPS = [
  "connect",
  "detect",
  "bind",
  "preview"
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingState {
  readonly step: OnboardingStep;
  readonly overview: OverviewReadModel | null;
  readonly detectedHarnesses: readonly { readonly harnessInstanceId: string; readonly displayName: string; readonly installed: boolean }[];
  readonly selectedHarnessIds: readonly string[];
  readonly projects: readonly ProjectDto[];
  readonly error: string | null;
  readonly adoptionRequired: boolean;
}

export type OnboardingAction =
  | { readonly type: "connected"; readonly overview: OverviewReadModel }
  | { readonly type: "connect-failed"; readonly message: string }
  | { readonly type: "harnesses-detected"; readonly harnesses: readonly { readonly harnessInstanceId: string; readonly displayName: string; readonly installed: boolean }[] }
  | { readonly type: "toggle-harness"; readonly harnessInstanceId: string }
  | { readonly type: "select-all-harnesses" }
  | { readonly type: "deselect-all-harnesses" }
  | { readonly type: "projects-loaded"; readonly projects: readonly ProjectDto[] }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "adoption-required" }
  | { readonly type: "reset" };

export function initialOnboardingState(): OnboardingState {
  return {
    step: "connect",
    overview: null,
    detectedHarnesses: [],
    selectedHarnessIds: [],
    projects: [],
    error: null,
    adoptionRequired: false
  };
}

export function reduceOnboarding(state: OnboardingState, action: OnboardingAction): OnboardingState {
  switch (action.type) {
    case "connected":
      return { ...state, step: "detect", overview: action.overview, error: null };
    case "connect-failed":
      return { ...state, error: action.message };
    case "harnesses-detected":
      return {
        ...state,
        step: "detect",
        detectedHarnesses: action.harnesses,
        selectedHarnessIds: action.harnesses.filter((harness) => harness.installed).map((harness) => harness.harnessInstanceId)
      };
    case "toggle-harness": {
      const selected = state.selectedHarnessIds.includes(action.harnessInstanceId)
        ? state.selectedHarnessIds.filter((id) => id !== action.harnessInstanceId)
        : [...state.selectedHarnessIds, action.harnessInstanceId];
      return { ...state, selectedHarnessIds: selected };
    }
    case "select-all-harnesses":
      return { ...state, selectedHarnessIds: state.detectedHarnesses.map((harness) => harness.harnessInstanceId) };
    case "deselect-all-harnesses":
      return { ...state, selectedHarnessIds: [] };
    case "projects-loaded":
      return { ...state, step: "bind", projects: action.projects };
    case "error":
      return { ...state, error: action.message };
    case "adoption-required":
      return { ...state, adoptionRequired: true, step: "preview" };
    case "reset":
      return initialOnboardingState();
  }
}

/** Zero-selection disables the next step (prototype requirement). */
export function canProceedFromDetect(state: OnboardingState): boolean {
  return state.selectedHarnessIds.length > 0;
}
