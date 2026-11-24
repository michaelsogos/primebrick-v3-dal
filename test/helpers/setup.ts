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

  // pg_raise(code, msg, detail) — DAL add() conflict CTE raises ERR04/ERR05
  // through it. Mirrors the global init script in primebrick-be-v3.
  await db.query(`
    CREATE OR REPLACE FUNCTION public.pg_raise(p_code text, p_message text, p_detail text DEFAULT NULL)
    RETURNS void LANGUAGE plpgsql AS $func$
    BEGIN
      RAISE EXCEPTION '%', p_message USING ERRCODE = p_code, DETAIL = p_detail;
    END;
    $func$;
  `);

  // Simple test table
  await db.query(`
    CREATE TABLE IF NOT EXISTS dal_test_simple (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      uuid        uuid NOT NULL DEFAULT uuidv7(),
      name        varchar(255) NOT NULL,
      description text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      created_by  text NOT NULL DEFAULT '',
      updated_at  timestamptz NOT NULL DEFAULT now(),
      updated_by  text NOT NULL DEFAULT '',
      version     integer NOT NULL DEFAULT 1,
      deleted_at  timestamptz,
      deleted_by  text,
      cloned_from uuid
    );
    CREATE UNIQUE INDEX IF NOT EXISTS dal_test_simple_uuid_idx ON dal_test_simple (uuid);
  `);

  // Add cloned_from column if it doesn't exist (for clone tests)
  try {
    await db.query(`ALTER TABLE dal_test_simple ADD COLUMN IF NOT EXISTS cloned_from uuid`);
  } catch {
    // Column already exists, ignore
  }

  // Mutable unique column for update() ERR04/ERR05 conflict tests
  await db.query(`ALTER TABLE dal_test_simple ADD COLUMN IF NOT EXISTS email text`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS dal_test_simple_email_idx ON dal_test_simple (email)`);

  // Audit table for dal_test_simple (for AuditLogEntity + tableName override tests)
  // Shape: uuid PK (uuidv7 default) + legacy entity_id (parent keeps surrogate id).
  await db.query(`
    CREATE TABLE IF NOT EXISTS dal_test_simple_audit (
      uuid        uuid NOT NULL DEFAULT uuidv7() PRIMARY KEY,
      entity_id   bigint NOT NULL,
      entity_uuid uuid NOT NULL,
      action      text NOT NULL,
      changed_at  timestamptz NOT NULL DEFAULT now(),
      changed_by  text NOT NULL DEFAULT '',
      version     integer NOT NULL DEFAULT 1,
      delta       jsonb
    );
  `);
  // Post-id-eradication shape on pre-existing dev databases.
  try {
    await db.query(`ALTER TABLE dal_test_simple_audit ADD COLUMN IF NOT EXISTS uuid uuid NOT NULL DEFAULT uuidv7()`);
  } catch {
    // Column already exists, ignore
  }

  // Test users table (for buildAuditTrailJoins tests)
  await db.query(`
    CREATE TABLE IF NOT EXISTS dal_test_users (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      uuid        uuid NOT NULL DEFAULT uuidv7(),
      display_name text NOT NULL,
      idp_code    text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      created_by  text NOT NULL DEFAULT '',
      updated_at  timestamptz NOT NULL DEFAULT now(),
      updated_by  text NOT NULL DEFAULT '',
      version     integer NOT NULL DEFAULT 1,
      deleted_at  timestamptz,
      deleted_by  text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS dal_test_users_uuid_idx ON dal_test_users (uuid);
  `);

  // Ref-join test table — `target_uuid` refs dal_test_simple.uuid
  await db.query(`
    CREATE TABLE IF NOT EXISTS dal_test_ref_source (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      uuid        uuid NOT NULL DEFAULT uuidv7(),
      label       text,
      target_uuid uuid,
      ghost_uuid  uuid
    );
    CREATE UNIQUE INDEX IF NOT EXISTS dal_test_ref_source_uuid_idx ON dal_test_ref_source (uuid);
  `);

  // Relation-edge test table — mirrors `crm.customer_links`: directed
  // parent→child edge + the @Relation-derived unordered-pair unique index
  // (LEAST/GREATEST expressions + type), the same DDL the schema patcher emits.
  await db.query(`
    CREATE TABLE IF NOT EXISTS dal_test_rel_links (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      uuid        uuid NOT NULL DEFAULT uuidv7(),
      parent_uuid uuid NOT NULL,
      child_uuid  uuid NOT NULL,
      type_uuid   uuid NOT NULL,
      note        text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS dal_test_rel_links_uuid_idx ON dal_test_rel_links (uuid);
    CREATE UNIQUE INDEX IF NOT EXISTS dal_test_rel_links_pair_uq ON dal_test_rel_links
      (LEAST(parent_uuid, child_uuid), GREATEST(parent_uuid, child_uuid), type_uuid);
  `);

  // Platform identity table — the dal-owned auditable display-name join
  // targets public.user_profiles statically, so the test env must provide it.
  // Minimal projection shape (id/uuid/idp_code/display_name); on a dev DB the
  // real table already satisfies IF NOT EXISTS.
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      uuid         uuid NOT NULL DEFAULT uuidv7(),
      idp_code     varchar(255) NOT NULL,
      display_name varchar(255)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_uuid_idx ON user_profiles (uuid);
  `);

  // Platform service registry — the audit-actor joins resolve `system:<code>`
  // writers through `public.service_registry` (ServiceRegistryRefEntity).
  // Minimal projection shape (uuid/code/name); the real table satisfies
  // IF NOT EXISTS on dev DBs.
  await db.query(`
    CREATE TABLE IF NOT EXISTS service_registry (
      uuid         uuid NOT NULL DEFAULT uuidv7() PRIMARY KEY,
      code         varchar(100) NOT NULL,
      name         varchar(255)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS service_registry_code_idx ON service_registry (code);
  `);

  // Type-rich test table
  await db.query(`
    CREATE TABLE IF NOT EXISTS dal_test_types (
      id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      uuid            uuid NOT NULL DEFAULT uuidv7(),
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
      uuid        uuid NOT NULL DEFAULT uuidv7(),
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
      uuid            uuid NOT NULL DEFAULT uuidv7(),
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

  // Sequence builtin tables — module-registry DDL mirrored from
  // SequenceEntity / SequenceCounterEntity (unqualified = search_path,
  // same resolution the resolver uses in tests).
  await db.query(`
    CREATE TABLE IF NOT EXISTS sequences (
      uuid            uuid PRIMARY KEY DEFAULT uuidv7(),
      name            varchar(100) NOT NULL,
      pattern         text NOT NULL,
      step            bigint NOT NULL,
      start           bigint NOT NULL,
      tz              varchar(100),
      description_key varchar(200),
      sez             varchar(200),
      sez2            varchar(200),
      sez3            varchar(200),
      binding_key     varchar(130),
      revive_every    varchar(30),
      revive_grace    varchar(30),
      revive_slot     varchar(10),
      expire_at       timestamptz,
      switch_at       timestamptz,
      default_from    timestamptz,
      revived_from    uuid,
      revived_at      timestamptz,
      revived_by      varchar(100),
      created_at      timestamptz NOT NULL DEFAULT now(),
      created_by      varchar(100),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      updated_by      varchar(100),
      version         integer NOT NULL DEFAULT 1,
      deleted_at      timestamptz,
      deleted_by      varchar(100)
    );
    -- legacy shape migration (code→name, unique index, label_key)
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sequences' AND column_name = 'code'
      ) THEN
        ALTER TABLE sequences RENAME COLUMN code TO name;
      END IF;
    END $$;
    DROP INDEX IF EXISTS sequences_code_uq;
    ALTER TABLE sequences DROP COLUMN IF EXISTS label_key;
    -- revive spec columns carry instant literals ('at'/'until' RFC3339)
    ALTER TABLE sequences
      ALTER COLUMN revive_every TYPE varchar(40),
      ALTER COLUMN revive_grace TYPE varchar(40);
    -- revive columns on already-provisioned test schemas
    ALTER TABLE sequences
      ADD COLUMN IF NOT EXISTS sez          varchar(200),
      ADD COLUMN IF NOT EXISTS sez2         varchar(200),
      ADD COLUMN IF NOT EXISTS sez3         varchar(200),
      ADD COLUMN IF NOT EXISTS binding_key  varchar(130),
      ADD COLUMN IF NOT EXISTS revive_every varchar(30),
      ADD COLUMN IF NOT EXISTS revive_grace varchar(30),
      ADD COLUMN IF NOT EXISTS revive_slot  varchar(10),
      ADD COLUMN IF NOT EXISTS expire_at    timestamptz,
      ADD COLUMN IF NOT EXISTS switch_at    timestamptz,
      ADD COLUMN IF NOT EXISTS default_from timestamptz,
      ADD COLUMN IF NOT EXISTS revived_from uuid,
      ADD COLUMN IF NOT EXISTS revived_at   timestamptz,
      ADD COLUMN IF NOT EXISTS revived_by   varchar(100);

    CREATE TABLE IF NOT EXISTS sequence_counters (
      uuid             uuid PRIMARY KEY DEFAULT uuidv7(),
      sequence_uuid    uuid NOT NULL,
      period_key       varchar(64) NOT NULL DEFAULT '',
      partition_key    varchar(255) NOT NULL DEFAULT '',
      counter          bigint NOT NULL,
      last_alloc_at    timestamptz,
      last_alloc_by    varchar(100),
      last_alloc_count bigint,
      created_at       timestamptz NOT NULL DEFAULT now(),
      created_by       varchar(100),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      updated_by       varchar(100),
      version          integer NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS sequence_counters_identity
      ON sequence_counters (sequence_uuid, period_key, partition_key);

    CREATE TABLE IF NOT EXISTS dal_test_seq (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      uuid         uuid NOT NULL DEFAULT uuidv7(),
      code         varchar(30) NOT NULL,
      label        varchar(255),
      created_at   timestamptz NOT NULL DEFAULT now(),
      created_by   varchar(100),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      updated_by   varchar(100),
      version      integer NOT NULL DEFAULT 1,
      deleted_at   timestamptz,
      deleted_by   varchar(100),
      cloned_from  uuid
    );
    CREATE UNIQUE INDEX IF NOT EXISTS dal_test_seq_uuid_idx ON dal_test_seq (uuid);
    CREATE UNIQUE INDEX IF NOT EXISTS dal_test_seq_code_idx ON dal_test_seq (code);
  `);

  // Realign uuid defaults on pre-existing test tables — CREATE TABLE
  // IF NOT EXISTS leaves stale gen_random_uuid() defaults behind.
  for (const table of [
    "dal_test_simple",
    "dal_test_users",
    "dal_test_types",
    "test_bench_simple",
    "test_bench_primitives",
    "dal_test_seq",
  ]) {
    await db.query(`ALTER TABLE ${table} ALTER COLUMN uuid SET DEFAULT uuidv7()`);
  }
}

/**
 * Truncate test tables — call before each test to ensure isolation.
 * Uses TRUNCATE ... RESTART IDENTITY CASCADE for clean state.
 */
export async function truncateTestTables(): Promise<void> {
  const db = getTestPool();
  await db.query(`
    TRUNCATE TABLE dal_test_simple, dal_test_simple_audit, dal_test_users, dal_test_types, test_bench_simple, test_bench_primitives, dal_test_ref_source, dal_test_rel_links, dal_test_seq, sequences, sequence_counters RESTART IDENTITY CASCADE;
  `);
}

/**
 * Drop test tables — call for full teardown (not used in normal test runs).
 */
export async function dropTestSchema(): Promise<void> {
  const db = getTestPool();
  await db.query(`
    DROP TABLE IF EXISTS dal_test_rel_links CASCADE;
    DROP TABLE IF EXISTS dal_test_ref_source CASCADE;
    DROP TABLE IF EXISTS dal_test_simple_audit CASCADE;
    DROP TABLE IF EXISTS dal_test_users CASCADE;
    DROP TABLE IF EXISTS dal_test_simple CASCADE;
    DROP TABLE IF EXISTS dal_test_types CASCADE;
    DROP TABLE IF EXISTS test_bench_simple CASCADE;
    DROP TABLE IF EXISTS test_bench_primitives CASCADE;
  `);
}
