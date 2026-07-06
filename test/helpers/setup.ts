import "dotenv/config";
import pg, { Pool } from "pg";

/**
 * Test setup helper — provides:
 * - A shared pg Pool connected to the test database
 * - Idempotent DDL setup (CREATE TABLE IF NOT EXISTS) for test entities
 * - Cleanup helpers (TRUNCATE between tests)
 *
 * IMPORTANT: bigint columns return as native JS bigint (not strings) via the
 * INT8_OID type parser configured below.
 */

// Configure INT8 parser so bigint columns return as native bigint
pg.types.setTypeParser(pg.types.builtins.INT8, (val: string) => BigInt(val));

// Configure NUMERIC parser: convert to number when safe, keep as string for overflow
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (val: string) => {
  const num = Number(val);
  // Return as string if precision would be lost (very large integers)
  if (!val.includes(".") && Math.abs(num) > Number.MAX_SAFE_INTEGER) return val;
  return num;
});

let pool: Pool | null = null;

/** Get the shared test pool. Throws if DATABASE_URL is not set. */
export function getTestPool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Create a .env file in the DAL repo root with DATABASE_URL=postgresql://user:pass@host:port/dbname"
    );
  }
  pool = new Pool({ connectionString: url, max: 5 });
  return pool;
}

/** Close the shared pool — call in afterAll. */
export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Idempotent DDL setup — creates test tables if they don't exist.
 * Safe to run multiple times (uses IF NOT EXISTS).
 */
export async function setupTestSchema(): Promise<void> {
  const db = getTestPool();

  // Simple test table
  await db.query(`
    CREATE TABLE IF NOT EXISTS dal_test_simple (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      uuid        uuid NOT NULL DEFAULT gen_random_uuid(),
      name        varchar(255) NOT NULL,
      description text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      created_by  text NOT NULL DEFAULT '',
      updated_at  timestamptz NOT NULL DEFAULT now(),
      updated_by  text NOT NULL DEFAULT '',
      version     integer NOT NULL DEFAULT 1,
      deleted_at  timestamptz,
      deleted_by  text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS dal_test_simple_uuid_idx ON dal_test_simple (uuid);
  `);

  // Type-rich test table
  await db.query(`
    CREATE TABLE IF NOT EXISTS dal_test_types (
      id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      uuid            uuid NOT NULL DEFAULT gen_random_uuid(),
      int_col         integer NOT NULL,
      bigint_col      bigint NOT NULL,
      bool_col        boolean NOT NULL,
      varchar_col     varchar(100) NOT NULL,
      text_col        text,
      numeric_col     numeric(15,2) NOT NULL,
      big_numeric_col numeric(38,0) NOT NULL,
      decimal_col     decimal(10,4) NOT NULL,
      timestamp_col   timestamptz NOT NULL,
      date_col        date NOT NULL,
      jsonb_col       jsonb,
      created_at      timestamptz NOT NULL DEFAULT now(),
      created_by      text NOT NULL DEFAULT '',
      updated_at      timestamptz NOT NULL DEFAULT now(),
      updated_by      text NOT NULL DEFAULT '',
      version         integer NOT NULL DEFAULT 1,
      deleted_at      timestamptz,
      deleted_by      text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS dal_test_types_uuid_idx ON dal_test_types (uuid);
  `);

  // Benchmark: simple 5-column table
  await db.query(`
    CREATE TABLE IF NOT EXISTS test_bench_simple (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      uuid        uuid NOT NULL DEFAULT gen_random_uuid(),
      code        varchar(50) NOT NULL,
      name        varchar(200) NOT NULL,
      status      varchar(20) NOT NULL DEFAULT 'active',
      created_at  timestamptz NOT NULL DEFAULT now(),
      created_by  text NOT NULL DEFAULT '',
      updated_at  timestamptz NOT NULL DEFAULT now(),
      updated_by  text NOT NULL DEFAULT '',
      version     integer NOT NULL DEFAULT 1,
      deleted_at  timestamptz,
      deleted_by  text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS test_bench_simple_uuid_idx ON test_bench_simple (uuid);
  `);

  // Benchmark: 20+ column table with all PG primitive types
  await db.query(`
    CREATE TABLE IF NOT EXISTS test_bench_primitives (
      id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      uuid            uuid NOT NULL DEFAULT gen_random_uuid(),
      int2_val        smallint,
      int4_val        integer,
      int8_val        bigint,
      float4_val      real,
      float8_val      double precision,
      numeric_safe    numeric(15,2),
      boolean_val     boolean,
      char_val        char(1),
      varchar_val     varchar(200),
      text_val        text,
      uuid_val        uuid,
      date_val        date,
      timestamp_val   timestamp,
      timestamptz_val timestamptz,
      jsonb_val       jsonb,
      text_arr        text[],
      int4_arr        integer[],
      inet_val        inet,
      created_at      timestamptz NOT NULL DEFAULT now(),
      created_by      text NOT NULL DEFAULT '',
      updated_at      timestamptz NOT NULL DEFAULT now(),
      updated_by      text NOT NULL DEFAULT '',
      version         integer NOT NULL DEFAULT 1,
      deleted_at      timestamptz,
      deleted_by      text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS test_bench_primitives_uuid_idx ON test_bench_primitives (uuid);
  `);
}

/**
 * Truncate test tables — call before each test to ensure isolation.
 * Uses TRUNCATE ... RESTART IDENTITY CASCADE for clean state.
 */
export async function truncateTestTables(): Promise<void> {
  const db = getTestPool();
  await db.query(`
    TRUNCATE TABLE dal_test_simple, dal_test_types, test_bench_simple, test_bench_primitives RESTART IDENTITY CASCADE;
  `);
}

/**
 * Drop test tables — call for full teardown (not used in normal test runs).
 */
export async function dropTestSchema(): Promise<void> {
  const db = getTestPool();
  await db.query(`
    DROP TABLE IF EXISTS dal_test_simple CASCADE;
    DROP TABLE IF EXISTS dal_test_types CASCADE;
    DROP TABLE IF EXISTS test_bench_simple CASCADE;
    DROP TABLE IF EXISTS test_bench_primitives CASCADE;
  `);
}
