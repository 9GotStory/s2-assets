// The validation failure the registry services raise; routes answer it with 400 VALIDATION_FAILED.
// This module imports nothing, so any service can use it without an import cycle.

export class ValidationError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
    this.code = 'VALIDATION_FAILED';
  }
}
