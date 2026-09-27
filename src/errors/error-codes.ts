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
  /**
   * Unique-constraint conflict on a live row — raised by the `add()`
   * conflict-reporting CTE via `pg_raise` (PG-originated) or thrown as
   * `DuplicateRecordError` when the conflicting row is not identifiable.
   * HTTP 409.
   */
  ERR04: "ERR04",
  /**
   * Unique-constraint conflict on a soft-deleted row (`deleted_at` set) —
   * the row must be restored, never duplicated. PG-originated via
   * `pg_raise`; the existing row's `uuid` travels in the error `detail`.
   * HTTP 409.
   */
  ERR05: "ERR05",
  /**
   * Bulk operation timeout — a `*Many` operation exceeded its wall-clock
   * budget (`DalConfig.bulkTimeoutMs` or `BulkOptions.timeoutMs`) and the
   * transaction was rolled back. TS-originated `BulkTimeoutError` (JS
   * deadline between statements) or PG `57014` (`SET LOCAL
   * statement_timeout` killing a slow statement inside the bulk tx).
   * HTTP 408.
   */
  ERR06: "ERR06",
  /**
   * Statement timeout — logical code for PostgreSQL `57014`
   * (`query_canceled`, raised when a statement exceeds `statement_timeout`:
   * the per-connection `DalConfig.statementTimeoutMs`, or `SET LOCAL` inside
   * a bulk transaction). PG never emits `ERR07` itself — the boundary maps
   * `57014` to this code. HTTP 500 (typed; 504 is reserved for
   * DB-unreachable).
   */
  ERR07: "ERR07",
  /**
   * Raw unique violation — PostgreSQL `23505` that did NOT come through the
   * DAL conflict CTEs (i.e. a constraint not declared as `@Unique` in the
   * entity metadata: manual indexes, deferred/partial constraints). The
   * boundary maps `23505` to this code — poor detail, and a signal that a
   * `@Unique` group may be missing from the entity declaration.
   * HTTP 409.
   */
  ERR08: "ERR08",
  /**
   * Illegal match selector on a single-row write — `matchBy` references a
   * property that is not `@Unique`/`@Key`, a composite `@Unique` group is
   * supplied partially, or the payload carries no identity field at all.
   * TS-originated `MatchSelectorError`, thrown pre-SQL. HTTP 422.
   */
  ERR09: "ERR09",
  /**
   * Incoherent or ambiguous identity — the supplied identity fields do not
   * converge on a single row: e.g. `id`+`uuid` point at different rows, or
   * the match hit more than one row (in-statement `pg_raise` guard aborts
   * the write atomically). HTTP 412.
   */
  ERR10: "ERR10",
} as const;

export type DalErrorCode = (typeof DalErrorCodes)[keyof typeof DalErrorCodes];
