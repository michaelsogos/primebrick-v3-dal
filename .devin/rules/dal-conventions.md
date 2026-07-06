# DAL Conventions

## Dependency Boundary

- The DAL (`@primebrick/dal-pg`) is a **LEAF dependency**.
- It **MUST NOT** import from `primebrick-be-v3` or `primebrick-us-v3` (or any other Primebrick application/service package).
- The DAL only depends on:
  - `pg` — PostgreSQL client
  - `pg-query-stream` — streaming query support
  - `reflect-metadata` — decorator metadata reflection
- No other runtime dependencies are permitted. Keep the dependency surface minimal.

## Naming Conventions

- **snake_case everywhere**:
  - Database column names
  - TypeScript entity properties
  - JSON keys in serialized output and query input
- Do not mix camelCase into entity definitions, column mappings, or JSON payloads.
- Table names are snake_case and typically singular unless the domain dictates otherwise.

## Write Operations

- **`RETURNING *`** on all writes (`insert`, `update`, `delete`, and their bulk variants).
- This ensures every write returns the full resulting row(s) so callers always have the authoritative post-write state.
- Bulk operations return arrays of the affected rows.

## Default Options

- **`throwIfNotFound: true`** by default.
  - Finder methods throw `NotFoundError` when zero rows are returned and the caller expects at least one.
  - Callers may opt out by explicitly passing `throwIfNotFound: false`.
- **`deletedRecords: "EXCLUDED"`** by default.
  - Soft-delete queries exclude records marked as deleted by default.
  - Other supported values (e.g. `"INCLUDED"`, `"ONLY"`) must be passed explicitly by the caller.

## Bulk Operation Strategy

- **TEMP TABLE strategy** for `updateMany` and `upsertMany`.
  - A temporary table mirroring the target table structure is created.
  - Source rows are bulk-inserted (e.g. via `COPY` or multi-row `INSERT`) into the temp table.
  - The target table is updated/upserted from the temp table in a single set-based statement.
  - The temp table is dropped at the end (or implicitly on session end).
- This avoids per-row round-trips and leverages PostgreSQL's set-based execution.

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
- Error categories include (non-exhaustive):
  - `NotFoundError` — expected row(s) not found
  - `MultipleRowsError` — more rows than expected
  - `UnknownColumnError` — column not declared in entity metadata
  - `ValidationError` — input validation failure
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

## Transaction Discipline

- **The DAL NEVER commits automatically.**
- Every write operation executes within the caller's transaction context.
- The DAL waits for explicit user instruction (e.g. `commit()` / `rollback()`) to finalize a transaction.
- Do not add auto-commit behavior, even for single-statement convenience methods.

## Documentation Language

- **All `*.md` files use English.**
- This includes rules, skills, README, API docs, and inline markdown references.
