// The not-found and stale refusals the registry services raise. Like validation-error.ts, this module
// imports nothing, so any service can use it without an import cycle.

export class NotFoundError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string = 'Asset not found') {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
    this.code = 'NOT_FOUND';
  }
}

export class StaleBeforeConflictError extends Error {
  statusCode: number;
  code: string;
  current_values?: Record<string, string | number | null>;
  expected_values?: Record<string, string | number | null>;

  constructor(
    message: string = 'Current asset state differs from expected before values',
    currentValues?: Record<string, string | number | null>,
    expectedValues?: Record<string, string | number | null>
  ) {
    super(message);
    this.name = 'StaleBeforeConflictError';
    this.statusCode = 409;
    this.code = 'STALE_BEFORE_CONFLICT';
    this.current_values = currentValues;
    this.expected_values = expectedValues;
  }
}
