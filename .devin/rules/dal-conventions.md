# DAL Conventions

## Dependency Boundary

- The DAL (`@primebrick/dal-pg`) is a **LEAF dependency**.
- It **MUST NOT** import from `primebrick-be-v3` or `primebrick-us-v3` (or any other Primebrick application/service package).
- The DAL only depends on:
  - `pg` — PostgreSQL® client
  - `pg-query-stream` — streaming query support
  - `reflect-metadata` — decorator metadata reflection
- No other runtime dependencies are permitted. Keep the dependency surface minimal.

## Naming Conventions

- **snake_case everywhere**:
  - Database column names
  - TypeScript® entity properties
  - JSON keys in serialized output and query input
- Do not mix camelCase into entity definitions, column mappings, or JSON payloads.
- Table names are snake_case and typically singular unless the domain dictates otherwise.

## Write Operations

- **Explicit ops only**: `add` (insert), `update`, `delete` (soft), `restore`, `hardDelete`, `clone`.
- **Single-record `upsert` is REMOVED** — do not reintroduce it. Callers must pick `add` or `update` explicitly.
- **`upsertMany` is PARKED (commented out)** — its `ON CONFLICT DO UPDATE` branch overwrites without a
  version guard. Do NOT re-enable it (or its tests/SDK wrapper refs) until the guarded-vs-sync-import
  semantics is decided with the user.
- **Optimistic concurrency**: auditable entities require the caller-observed `version` on `update`,
  `delete`, `restore` — and on EVERY row of `updateMany`, `deleteMany`, `restoreMany` (`expected_version`
  in the temp table). Missing → `ERR02`; stale → `ERR01`; vanished → `ERR03`.
- **`RETURNING *`** on single writes — the DB returns the full resulting row(s), hydrated into entity shape.
  Callers MUST consume the returned row instead of re-reading it (no "read after write" round-trips).
- **Bulk operations return `BulkResult` = `{ received, affected }`** (never `void`, never entity rows).
  `received` = rows submitted; `affected` = rows actually written. Any per-row failure rolls the whole
  operation back — `affected < received` is impossible on success.
- **`reserved`-style domain flags are NOT a DAL concern** — generic bulk methods stay agnostic. Callers
  that need them (e.g. config entries) do a set-based pre-check and then call the `*Many` method.

## Default Options

- **`throwIfNotFound: true`** by default.
  - Finder methods throw `NotFoundError` when zero rows are returned and the caller expects at least one.
  - Callers may opt out by explicitly passing `throwIfNotFound: false`.
- **`deletedRecords: "EXCLUDED"`** by default.
  - Soft-delete queries exclude records marked as deleted by default.
  - Other supported values (e.g. `"INCLUDED"`, `"ONLY"`) must be passed explicitly by the caller.

## Bulk Operation Strategy

- **TEMP TABLE strategy** for ALL `*Many` writes (`addMany`, `updateMany`, `deleteMany`, `restoreMany`).
  - A temporary table mirroring the relevant columns (match key + written cols + `expected_version`)
    is created inside a dedicated transaction client.
  - Source rows are bulk-inserted into it, then the target table is written in a single set-based
    statement joined on the match key AND `target.version = tmp.expected_version` (auditable entities).
  - Failed rows are diagnosed INSIDE the same transaction (pre-write) and reported via one
    `pg_raise` — `ERR01` (stale) / `ERR03` (vanished), DETAIL jsonb `{entity, table, stale, rows[≤10]}`.
  - The whole operation is atomic: any offender rolls everything back. No partial persistence.
- **Timeout semantics**: `BulkOptions.timeoutMs` → `SET LOCAL statement_timeout` (statement-level);
  `DalConfig.bulkTimeoutMs` (30min default) is the whole-operation wall-clock budget — exceeding it
  throws `BulkTimeoutError` (`ERR06`) and rolls back. PG `57014` (statement_timeout kill) maps to
  logical `ERR07` at the HTTP boundary.
- This avoids per-row round-trips and leverages PostgreSQL®'s set-based execution.
- **`addMany` conflicts**: a single `pg_raise` carries `{entity, table, conflicts, rows[≤10]}` —
  each row with `uuid`, `input_uuid`, `code` (`ERR04` live row / `ERR05` soft-deleted row),
  `deleted`, `constraint`, `keys` (the attempted unique-key values). Top-level code is `ERR05`
  only when EVERY conflict hits a soft-deleted row.

## Numeric Handling

- **bigint** is handled via `INT8_OID` — values are returned as **native `bigint`**, not strings or numbers.
  - This preserves full 64-bit precision and avoids silent truncation.
- **Metadata-driven numeric handling**: the DAL inspects entity/column metadata to determine the correct JS type for each numeric column (e.g. `int` -> `number`, `bigint` -> `bigint`, `numeric`/`decimal` -> `number` or `string` per column config).
- Do not hard-code type conversions in query paths; route them through the metadata layer.

## Audit

- **Audit is optional** and **port-based**.
  - The DAL accepts an optional audit port (an interface/handler) at construction or per-call.
  - When provided, audit events are emitted in a **fire-and-forget** manner — the DAL does not block, await, or fail the primary operation on audit errors.
  - When no audit port is configured, audit is a no-op.
- Audit must never become a hard dependency or a point of failure for the main data path.

## Error Handling

- Errors are **framework-agnostic**.
- Each error exposes a **stable error code** (string identifier) that callers can branch on.
- Errors **MUST NOT** carry HTTP status codes or be coupled to any web framework.
  HTTP mapping lives in `@primebrick/sdk` `mapDalError` (pure, no `node:*`) — shared by BE and US.
- Error categories include (non-exhaustive):
  - `NotFoundError` — expected row(s) not found
  - `MultipleRowsError` — more rows than expected
  - `UnknownColumnError` — column not declared in entity metadata
  - `ValidationError` — input validation failure
  - `OptimisticLockError`/`ERR01` — stale version (PG-raised on guarded writes)
  - `MissingVersionError`/`ERR02` — auditable write missing `version`
  - `RecordVanishedError`/`ERR03` — row gone between read and write
  - `ERR04`/`ERR05` — unique conflict vs live / soft-deleted row (PG `pg_raise`)
  - `BulkTimeoutError`/`ERR06` — bulk op exceeded the wall-clock budget (rolled back)
  - `ERR07` — logical code for PG `57014` `query_canceled` (statement_timeout)
  - `ERR08` — logical code for raw PG `23505` on a constraint not declared as `@Unique`
  - `MatchSelectorError`/`ERR09` — illegal/incomplete match selector or missing identity, thrown pre-SQL (HTTP 422)
  - `IdentityConflictError`/`ERR10` — incoherent identity (e.g. `id`+`uuid` mismatch) or multi-row match guard abort (HTTP 412)
    (manual/deferred/partial index) — 409 with poor detail; its appearance signals a
    missing `@Unique` in the entity metadata
- **Unique-conflict CTEs** on `add()`/`addMany()`/`update()`: when the payload can
  affect a declared `@Unique` group, the write statement carries a conflict CTE that
  raises `ERR04`/`ERR05` with DETAIL `{entity, table, uuid, constraint, keys}` —
  `keys` = the attempted unique values (for `update()`, composite groups include
  untouched column values read from the target row). NULL attempted values never
  conflict (standard unique indexes are NULLS DISTINCT). On `update()` the conflict
  check is gated on the target row passing the version guard, so `ERR01`/`ERR03`
  always win over `ERR04`/`ERR05`.
- **Single-row writes identify exactly one row** — `update()`/`delete()`/`restore()`/
  `hardDelete()` resolve identity from the payload: `id` (`@Key`) and `uuid` present
  in the payload are ALWAYS AND-ed match conditions (incoherent pairs → `ERR10`);
  `matchBy` (string or `keyof TEntity[]`) may add `@Unique` selectors — a prop in a
  composite `@Unique` group requires every group prop in the payload. Non-unique/
  unknown/incomplete selectors → `ERR09` pre-SQL. Identity props are never SET
  columns. A `matched`/`guard` CTE aborts the statement with `ERR10` if the match
  resolves to >1 row (atomic — nothing is written).
- **Bulk `*Many` writes share the same identity contract** — `updateMany`/`deleteMany`/
  `restoreMany` resolve identity per item exactly like single-row ops: `id`/`uuid`
  present in EVERY item auto-AND into the match; `matchBy` accepts a prop or prop
  array of `@Unique` selectors (composite groups complete in every item). The
  identity must be uniform across the batch (heterogeneous → `ERR09`). Each
  temp-table item must match ≤1 target row — a set-based `GROUP BY row_ix`
  ambiguity guard raises `ERR10` and aborts the transaction before any write;
  incoherent `id`/`uuid` items are classified `ERR10` by the stale diagnose
  (partial-identity probes only against already-failed rows — never per-item
  queries on the happy path).
- **`pg_raise` is a REQUIRED database function** — it must exist on every target DB
  (init SQL + `setupTestSchema`). Without it, guarded-write/conflict raises cannot fire.
- Keep error codes stable across versions; changing a code is a breaking change.

## Entity Decorators

- Entity classes are plain classes decorated with metadata decorators:
  - `@Entity(table)` — declares a class as a DAL entity bound to a table
  - `@Column(options)` — maps a property to a DB column
  - `@Key` — marks a property as part of the primary key
  - `@Unique(name?)` — marks a property/column as unique
  - `@AuditableField` — marks a field as included in audit events
  - `@DeletableField` — marks the soft-delete flag column
- Decorators only attach metadata via `reflect-metadata`; they do not perform I/O.
- **Type inference is name-heuristic only under `tsx`/esbuild** — `emitDecoratorMetadata` (`design:type`) is not emitted at dev runtime. Consequences:
  - Implicit (undecorated) and `@Column` properties infer PG type from the column/property name (`uuid`, `id`, `version`, `*_at`, …), defaulting to `text`.
  - **Any column whose PG type is not `text` MUST declare `@Column({ pgType: ... })` explicitly** (`numeric`, `integer`, `bigint`, `boolean`, `uuid`, `inet`, `jsonb`, …). Relying on the TS property type (`number`, `boolean`, `bigint`) is NOT sufficient — it produces `text` drift in `db:meta:compare`.

## Transaction Discipline

- **Single-row write ops never auto-commit** — they execute within the caller's transaction
  context and wait for explicit `commit()` / `rollback()`. Do not add auto-commit behavior to
  single-statement convenience methods.
- **`*Many` bulk ops are the deliberate exception**: each runs on a dedicated client with its own
  `BEGIN`/`COMMIT`/`ROLLBACK` — that self-contained transaction IS the atomicity guarantee
  (all-or-nothing, `BulkResult` summary). Never split a bulk op into per-row commits.

## Documentation Language

- **All `*.md` files use English.**
- This includes rules, skills, README, API docs, and inline markdown references.
