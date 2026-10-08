export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_CATEGORIES'
  | 'UNKNOWN_CATEGORY'
  | 'DUPLICATE_SAMPLE_ID'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'NO_VALID_DATA'
  | 'KAPPA_UNDEFINED'
  | 'LIMIT_EXCEEDED'
  | 'IMPORT_FAILED';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
