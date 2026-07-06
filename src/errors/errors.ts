/**
 * DAL error classes — framework-agnostic, no HTTP coupling.
 *
 * These errors extend `Error` with stable `code` fields so consumers (BE, US)
 * can map them to HTTP responses, NATS errors, or any other boundary at their
 * own layer. The DAL itself never imports HTTP/NATS types.
 */

/** Generic DAL error with a stable `code` field. */
export abstract class DalError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Thrown when a finder returns zero rows and `throwIfNotFound` is true (the default). */
export class NotFoundError extends DalError {
  readonly code = "NOT_FOUND";
  constructor(message: string) {
    super(message);
  }
}

/** Thrown when a single-row finder (`findById`, `find`) returns more than one row. */
export class MultipleRowsError extends DalError {
  readonly code = "MULTIPLE_ROWS";
  constructor(message: string) {
    super(message);
  }
}

/** Thrown when a write operation (add, update) receives a property not in entity metadata. */
export class UnknownColumnError extends DalError {
  readonly code = "UNKNOWN_COLUMN";
  constructor(message: string) {
    super(message);
  }
}

/** Thrown when a validation check fails (e.g. empty updates object, missing actor). */
export class ValidationError extends DalError {
  readonly code = "VALIDATION";
  constructor(message: string) {
    super(message);
  }
}
