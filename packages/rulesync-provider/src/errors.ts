export type RulesyncProviderErrorCode =
  | "DETECTION_REQUIRED"
  | "INVALID_SOURCE_RESOURCE"
  | "SOURCE_STALE"
  | "STAGED_OUTPUT_NOT_FOUND"
  | "REQUEST_CONTEXT_MISMATCH"
  | "UNSAFE_LOGICAL_PATH";

export class RulesyncProviderError extends Error {
  readonly code: RulesyncProviderErrorCode;

  constructor(code: RulesyncProviderErrorCode, message: string) {
    super(message);
    this.name = "RulesyncProviderError";
    this.code = code;
  }
}
