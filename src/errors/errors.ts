/**
 * DAL error classes — framework-agnostic, no HTTP coupling.
 *
 * These errors extend `Error` with stable `code` fields so consumers (BE, US)
 * can map them to HTTP responses, NATS errors, or any other boundary at their
 * own layer. The DAL itself never imports HTTP/NATS types.
 */

import { DalErrorCodes } from "./error-codes.js";

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

/**
 * Thrown when an auditable-entity write (update/upsert-ON-CONFLICT/delete/restore/hardDelete)
 * is attempted without a `version` field in the payload.
 *
 * Code: `ERR02`. TS-originated. HTTP 400.
 */
export class MissingVersionError extends DalError {
  readonly code = DalErrorCodes.ERR02;
  /** Structured per-row detail for bulk ops (entity, table, missing count, rows[]). */
  readonly detail?: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.detail = detail;
  }
}

/**
 * Thrown when an auditable-entity write matches zero rows AND a disambiguation
 * SELECT confirms the row no longer exists (was hard-deleted by another writer).
 *
 * Code: `ERR03`. TS-originated. HTTP 404.
 *
 * Distinct from `NotFoundError` (which is for finders): `ERR03` specifically
 * means "the row existed when you read it but is now gone".
 */
export class RecordVanishedError extends DalError {
  readonly code = DalErrorCodes.ERR03;
  constructor(message: string) {
    super(message);
  }
}

/**
 * TS wrapper for the PG-originated `ERR01` optimistic concurrency violation.
 *
 * The DAL does NOT throw this class in the happy/conflict path — PostgreSQL
 * raises `RAISE EXCEPTION ... USING ERRCODE = 'ERR01'` and node-postgres
 * propagates it as a `DatabaseError` with `err.code === 'ERR01'`. This class
 * is provided only for ergonomic `instanceof` checks if a consumer wants to
 * normalize PG errors into TS errors at a boundary.
 *
 * Code: `ERR01`. PG-originated. HTTP 409.
 */
export class OptimisticLockError extends DalError {
  readonly code = DalErrorCodes.ERR01;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Unique-constraint conflict on a live row.
 *
 * Normally PG-originated: the `add()` conflict-reporting CTE calls
 * `pg_raise('ERR04', ...)`, and node-postgres propagates it as a
 * `DatabaseError` with `err.code === 'ERR04'` and a jsonb `err.detail`
 * (`{ entity, table, uuid, constraint }`). The DAL throws this class only
 * when the conflict cannot be attributed to any identifiable row (unique
 * group whose attempted values are all DB-generated, e.g. a payload-less
 * `uuid`). Provided in both cases for ergonomic `instanceof` checks.
 *
 * Code: `ERR04`. HTTP 409.
 */
export class DuplicateRecordError extends DalError {
  readonly code = DalErrorCodes.ERR04;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Unique-constraint conflict on a soft-deleted row — the row exists with
 * `deleted_at` set and must be restored, never duplicated.
 *
 * PG-originated via `pg_raise('ERR05', ...)`; the existing row's `uuid`
 * travels in the error `detail` so consumers can offer a direct restore.
 * This class is provided for ergonomic `instanceof` checks.
 *
 * Code: `ERR05`. HTTP 409.
 */
export class DeletedRecordConflictError extends DalError {
  readonly code = DalErrorCodes.ERR05;
  constructor(message: string) {
    super(message);
  }
}

/**
 * Thrown when a bulk write exceeds its wall-clock budget
 * (`DalConfig.bulkTimeoutMs` or `BulkOptions.timeoutMs`). The surrounding
 * transaction is rolled back — no partial writes survive.
 *
 * Code: `ERR06`. TS-originated (the JS deadline fires between
 * statements; a slow single statement is bounded by `SET LOCAL
 * statement_timeout` → PG `57014` query_canceled). HTTP 408.
 */
export class BulkTimeoutError extends DalError {
  readonly code = DalErrorCodes.ERR06;
  constructor(message: string) {
    super(message);
  }
}
