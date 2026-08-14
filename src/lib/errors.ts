export const ERROR_CODES = [
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "RATE_LIMITED",
  "PROBLEM_NOT_FOUND",
  "ATTEMPT_NOT_FOUND",
  "ATTEMPT_NOT_OWNED",
  "ATTEMPT_ALREADY_SUBMITTED",
  "ATTEMPT_NOT_EDITABLE",
  "BRANCH_CONFLICT",
  "GITHUB_UNAVAILABLE",
  "DATABASE_UNAVAILABLE",
  "INVALID_MANIFEST",
  "INVALID_ARTIFACT_PATH",
  "ARTIFACT_TOO_LARGE",
  "VERIFICATION_FAILED",
  "PR_POLICY_FAILED",
  "INVALID_INPUT",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class InferFundError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { retryable?: boolean; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "InferFundError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }

  toJSON(): {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function toInferFundError(error: unknown): InferFundError {
  if (error instanceof InferFundError) return error;
  return new InferFundError(
    "INTERNAL_ERROR",
    "An unexpected internal error occurred.",
    { retryable: true },
  );
}
