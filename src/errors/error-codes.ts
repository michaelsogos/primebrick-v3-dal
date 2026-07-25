/**
 * Stable error codes for DAL optimistic concurrency control.
 *
 * These codes are used as PostgreSQL SQLSTATE values (via `RAISE EXCEPTION
 * USING ERRCODE = 'ERR01'`) and as TS `DalError.code` values. Consumers (BE,
 * US, FE) branch on the string literal (e.g. `err.code === 'ERR01'`) so that
 * PG-originated errors and TS-originated errors share the same code.
 *
 * Convention: `ERR` + 2 digits. The `ER` class is outside the SQL-standard
 * SQLSTATE classes (`00`–`99`), so PostgreSQL accepts it as a custom code.
 *
 * @see docs/user-guide/optimistic-lock.mdx for the full guide.
 */
export const DalErrorCodes = {
  /** Optimistic concurrency violation — the row exists but `version` does not match. Originates from PG `RAISE EXCEPTION`. HTTP 409. */
  ERR01: "ERR01",
  /** Missing `version` field on an auditable-entity write. TS-originated `MissingVersionError`. HTTP 400. */
  ERR02: "ERR02",
  /** Record vanished — the row was hard-deleted by another writer between read and write. TS-originated `RecordVanishedError`. HTTP 404. */
  ERR03: "ERR03",
} as const;

export type DalErrorCode = (typeof DalErrorCodes)[keyof typeof DalErrorCodes];
