# DAL Testing Guide — @primebrick/dal

How to write and run tests against the DAL.

## Test infrastructure

- **Framework:** Vitest
- **Database:** Real PostgreSQL® (no mocks, no in-memory substitutes)
- **Test runner config:** `vitest.config.ts` (main), `test/benchmark.vitest.config.ts` (benchmarks)

## Environment setup

Create a `.env` file in the DAL repo root:

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/primebrick_test
```

The test pool reads `DATABASE_URL` via `dotenv/config`. Without it, tests will throw immediately.

## Running tests

```bash
pnpm test              # run all tests once
pnpm test:watch        # watch mode
pnpm test:benchmark    # run benchmarks (100, 1K, 10K records)
```

For 1M record benchmarks (long-running):

```bash
BENCH_1M=1 pnpm test:benchmark
```

## Test entities

### SimpleTestEntity (`test/entities/simple-test-entity.ts`)

Minimal entity for basic CRUD, finder, and bulk operation tests:
- `id` (bigint identity PK)
- `uuid` (uuid unique)
- `name` (varchar 255)
- `description` (text, nullable)
- Full audit fields (created_at/by, updated_at/by, version)
- Soft-delete fields (deleted_at/by)

### TypeTestEntity (`test/entities/type-test-entity.ts`)

Type-rich entity for the type mapping matrix:
- `int_col` (integer)
- `bigint_col` (bigint — native bigint)
- `bool_col` (boolean)
- `varchar_col` (varchar 100)
- `text_col` (text, nullable)
- `numeric_col` (numeric 15,2 — returns as number)
- `big_numeric_col` (numeric 38,0 — returns as string)
- `decimal_col` (decimal 10,4)
- `timestamp_col` (timestamptz — returns as JS Date)
- `date_col` (date — returns as JS Date)
- `jsonb_col` (jsonb, nullable)
- Full audit + soft-delete fields

## Setup helpers (`test/helpers/setup.ts`)

### `getTestPool()`

Returns a shared `pg.Pool` connected to the test database. Throws if `DATABASE_URL` is not set.

### `setupTestSchema()`

Idempotent DDL setup — creates test tables with `CREATE TABLE IF NOT EXISTS`. Safe to run multiple times. Called in `beforeAll`.

### `truncateTestTables()`

Truncates all test tables with `TRUNCATE ... RESTART IDENTITY CASCADE`. Called in `beforeEach` for test isolation.

### `closeTestPool()`

Closes the shared pool. Called in `afterAll`.

### `dropTestSchema()`

Drops test tables entirely. Not used in normal test runs — useful for full teardown.

## Test isolation

Each test file follows this pattern:

```typescript
beforeAll(async () => {
  pool = getTestPool();
  await setupTestSchema();
  repo = new Repository(pool);
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await truncateTestTables();
});
```

`TRUNCATE RESTART IDENTITY CASCADE` ensures:
- All rows are deleted
- Identity sequences are reset to 1
- No cross-test contamination

## Test files

| File | Coverage |
|------|----------|
| `repository-crud.test.ts` | Basic CRUD: add, findById, findByUUID, find, findAll, findByPage, count, update, delete, restore, hardDelete, upsert |
| `repository-bulk.test.ts` | Bulk ops: addMany, upsertMany, deleteMany, updateMany (TEMP TABLE) |
| `repository-types.test.ts` | Type mapping matrix: int, bigint, boolean, varchar, text, numeric, decimal, date, timestamp, jsonb |
| `repository-streaming.test.ts` | Streaming via pg-query-stream: AsyncIterable, empty result, large result |
| `repository-negative.test.ts` | Failure paths: NotFoundError, ValidationError, UnknownColumnError, silent failures (empty arrays), error code stability |
| `repository-benchmark.test.ts` | Benchmarks: addMany, upsertMany, updateMany at 100/1K/10K (and 1M with BENCH_1M=1) |

## Type test matrix

The type test matrix in `repository-types.test.ts` verifies correct PG ↔ JS type mapping:

| PG type | JS type | Notes |
|---------|---------|-------|
| `integer` | `number` | |
| `bigint` | `bigint` | Native bigint via INT8_OID parser |
| `boolean` | `boolean` | |
| `varchar(n)` | `string` | |
| `text` | `string` / `null` | Nullable |
| `numeric(15,2)` | `number` | Fits in Number.MAX_SAFE_INTEGER |
| `numeric(38,0)` | `string` | Overflows Number — returned as string |
| `decimal(10,4)` | `number` | |
| `timestamptz` | `Date` | JS Date object |
| `date` | `Date` | JS Date object, time component stripped |
| `jsonb` | `object` / `null` | Parsed JSON |

## Negative / failure path testing

The DAL tests both positive paths (things work) and negative paths (things fail correctly):

- **NotFoundError** — finders throw when rows don't exist (default behavior)
- **ValidationError** — empty inputs, invalid page numbers
- **UnknownColumnError** — non-existent properties in write ops
- **Silent failures** — empty arrays in bulk ops return `[]` (no error)
- **Error code stability** — every error has a stable `code` field

## bigint configuration

For `bigint` columns to return as native `bigint`, the `pg` module must be configured with the INT8 type parser. Add this to your application's pool setup:

```typescript
import pg from "pg";
pg.types.setTypeParser(pg.types.builtins.INT8, (val: string) => BigInt(val));
```

The test suite expects this to be configured. If it's not, `bigint_col` will return as a string instead of a native bigint.
