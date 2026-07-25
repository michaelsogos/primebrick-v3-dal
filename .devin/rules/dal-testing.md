# DAL Testing

## Test Framework

- Tests use **Vitest**.
- Tests run against a **REAL PostgreSQL® database** — **no mocks**.
  - Do not stub `pg` or the connection pool in tests.
  - Mock-based tests are not acceptable for verifying DAL behavior.

## Test Entities

- **`SimpleTestEntity`** — used for basic CRUD coverage (insert, find, update, delete, soft-delete).
- **`TypeTestEntity`** — used for the full type matrix (see below).
- Test entities live alongside the test files and use the same decorators as production entities.

## Database Setup

- Setup is **idempotent**: use `CREATE TABLE IF NOT EXISTS` for all test tables.
- Schema setup runs once per test run (or per suite) and does not assume a clean DB.

## Test Isolation

- Between tests, tables are cleared via:
  ```sql
  TRUNCATE RESTART IDENTITY CASCADE
  ```
- This resets sequences/identities and cascades to dependent tables.
- Do not rely on test ordering; each test must be independent.

## Environment

- `DATABASE_URL` **must be set** in `.env` (project root).
  - Example: `DATABASE_URL=postgres://user:pass@localhost:5432/primebrick_dal_test`
- Tests fail fast if `DATABASE_URL` is missing.

## Running Tests

- **Run tests:** `pnpm test`
- **Run benchmarks:** `pnpm test:benchmark`
- **1M record benchmarks:** set `BENCH_1M=1` env var to enable large-scale benchmarks.
  - Without this flag, benchmarks use a smaller default record count to keep CI fast.
  - Example: `BENCH_1M=1 pnpm test:benchmark`

## Type Test Matrix

- `TypeTestEntity` exercises the full type mapping across:
  - `int` (integer)
  - `bigint` (returned as native `bigint` via `INT8_OID`)
  - `boolean`
  - `varchar`
  - `text`
  - `numeric`
  - `decimal`
  - `date`
  - `timestamp`
  - `jsonb`
- Each type has round-trip tests: insert a value, read it back, assert type and value fidelity.

## Positive and Negative Paths

- Tests cover **both positive and negative paths**.
- **Negative/failure path tests** verify:
  - Correct error **types** are thrown (e.g. `NotFoundError`, `MultipleRowsError`, `UnknownColumnError`, `ValidationError`).
  - Correct error **codes** are present on the thrown errors.
  - Constraint violations and invalid inputs surface as the expected DAL error, not a raw `pg` error.
- Do not only test the happy path; every error branch must have coverage.

## Documentation Language

- All `*.md` files (including this one) use English.
