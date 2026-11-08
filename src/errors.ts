import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'CONFIG_ERROR',
  'AUTH_REQUIRED',
  'AUTH_FAILED',
  'UPSTREAM_UNAUTHORIZED',
  'UPSTREAM_NOT_FOUND',
  'UPSTREAM_RATE_LIMITED',
  'UPSTREAM_ERROR',
  'UPSTREAM_INVALID_RESPONSE',
  'VALIDATION_ERROR',
  'DATE_RANGE_TOO_LARGE',
  'DUPLICATE_DETECTED',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_UNCERTAIN',
  'CONFIRMATION_REQUIRED',
  'PARTIAL_FAILURE',
  'WRITE_NOT_VERIFIED',
  'UNSUPPORTED_OPERATION',
  'SAVED_MEAL_NOT_FOUND',
  'MEAL_NOT_FOUND',
  'INTERNAL_ERROR',
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export class NutritionMcpError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      cause?: unknown;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'NutritionMcpError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}

export const toPublicError = (
  error: unknown,
): {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
} => {
  if (error instanceof NutritionMcpError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof z.ZodError) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'Input validation failed.',
      retryable: false,
      details: {
        issues: error.issues.map(({ path, message, code }) => ({ path, message, code })),
      },
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'Internal server error.',
    retryable: false,
  };
};
