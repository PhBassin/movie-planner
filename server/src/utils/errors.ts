export class AppError extends Error {
  public statusCode: number;
  public details?: any[];

  constructor(message: string, statusCode: number, details?: any[]) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(message, 404);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: any[]) {
    super(message, 400, details);
  }
}

export class AuthError extends AppError {
  constructor(message: string = 'Unauthorized', statusCode: number = 401) {
    super(message, statusCode);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super(message, 403);
  }
}

export class TheaterNotFoundError extends AppError {
  constructor(theaterId: string) {
    super(`Theater not found: ${theaterId}`, 404);
  }
}

/**
 * Detect a Postgres unique-constraint violation: SQLSTATE `23505`, or a
 * "duplicate key" message (re-wrapped errors can lose the code).
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === '23505') {
    return true;
  }
  return typeof e.message === 'string' && e.message.includes('duplicate key');
}
