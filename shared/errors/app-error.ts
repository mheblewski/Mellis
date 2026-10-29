export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends AppError {
  readonly code = 'RESOURCE_NOT_FOUND';
  readonly httpStatus = 404;
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  readonly httpStatus = 422;
}

export class ConflictError extends AppError {
  readonly code = 'STATE_CONFLICT';
  readonly httpStatus = 409;
}

/**
 * A save based on data another caregiver changed in the meantime (live-updates.v1): nothing was written; the app shows
 * the current state and asks again.
 */
export class StaleWriteError extends AppError {
  readonly code = 'STALE_WRITE';
  readonly httpStatus = 409;
}

/** Rescue carbs were already logged for this alert (the other caregiver was faster): the title names who. */
export class RescueAlreadyLoggedError extends AppError {
  readonly code = 'RESCUE_ALREADY_LOGGED';
  readonly httpStatus = 409;
}

export class UnauthorizedError extends AppError {
  readonly code = 'UNAUTHENTICATED';
  readonly httpStatus = 401;
}

/** An outside service the request needs (speech to text) did not answer; trying again later may work. */
export class ServiceUnavailableError extends AppError {
  readonly code = 'SERVICE_UNAVAILABLE';
  readonly httpStatus = 503;
}

export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;
}
/** An error with its own problem code (sharing, setup, device auth: NOT_AN_OWNER, PAIRING_CODE_INVALID, …). */
export class CodedError extends AppError {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}
