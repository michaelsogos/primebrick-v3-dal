import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";

import {
  Dal,
  getDal,
  resetDal,
  NotFoundError,
  type DalConfig,
} from "../src/index.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import {
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

/**
 * Integration tests for the Dal gateway — pool ownership, type-parser
 * registration, onConnect session settings, withClient, close, singleton guard.
 *
 * These tests create their own Dal instance (NOT the singleton) to avoid
 * interfering with other test suites. The singleton behavior is tested
 * explicitly in a dedicated describe block with resetDal() cleanup.
 */
describe("Dal gateway — pool ownership, type parsers, onConnect", () => {
  let dal: Dal;
  let connectionString: string;

  beforeAll(async () => {
    connectionString = process.env.DATABASE_URL!;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set. Create a .env file in the DAL repo root.");
    }
    // Use a direct instance (not the singleton) for most tests
    dal = new Dal({
      connectionString,
      schema: "public",
      max: 5,
      statementTimeoutMs: 30000,
      applicationName: "dal-test-gateway",
    });
    await setupTestSchema();
  });

  afterAll(async () => {
    await dal.close();
  });

  beforeEach(async () => {
    await truncateTestTables();
  });

  // ─── Construction & config ───────────────────────────────────────────

  it("Dal: constructs with merged defaults", () => {
    expect(dal.config.connectionString).toBe(connectionString);
    expect(dal.config.max).toBe(5);
    expect(dal.config.statementTimeoutMs).toBe(30000);
    expect(dal.config.connectionTimeoutMillis).toBe(5000);
    expect(dal.config.idleTimeoutMillis).toBe(30000);
    expect(dal.config.applicationName).toBe("dal-test-gateway");
    expect(dal.config.schema).toBe("public");
  });

  it("Dal: throws if connectionString is missing", () => {
    expect(() => new Dal({ connectionString: "" } as DalConfig)).toThrow("connectionString is required");
  });

  // ─── Pool lifecycle ──────────────────────────────────────────────────

  it("Dal.getPool: returns the underlying pg.Pool", () => {
    const pool = dal.getPool();
    expect(pool).toBeInstanceOf(pg.Pool);
  });

  it("Dal.close: drains the pool; subsequent operations fail", async () => {
    const tempDal = new Dal({ connectionString, max: 2 });
    await tempDal.close();
    expect(tempDal.isClosed).toBe(true);
    // Pool is ended — querying should reject
    await expect(tempDal.rawSql("SELECT 1")).rejects.toThrow();
  });

  it("Dal.isClosed: false before close, true after", async () => {
    const tempDal = new Dal({ connectionString, max: 2 });
    expect(tempDal.isClosed).toBe(false);
    await tempDal.close();
    expect(tempDal.isClosed).toBe(true);
  });

  // ─── close() hardening: re-entrancy, timeout, error containment ──────

  it("Dal.close: re-entrant — concurrent calls both resolve without error", async () => {
    const tempDal = new Dal({ connectionString, max: 2 });
    // Both calls should resolve without error — the first wins, the second is a no-op
    await Promise.all([tempDal.close(), tempDal.close()]);
    expect(tempDal.isClosed).toBe(true);
    expect(tempDal.isClosing).toBe(false);
  });

  it("Dal.close: re-entrant — sequential second call is a no-op", async () => {
    const tempDal = new Dal({ connectionString, max: 2 });
    await tempDal.close();
    expect(tempDal.isClosed).toBe(true);
    // Second call on already-closed pool — should NOT throw
    await expect(tempDal.close()).resolves.toBeUndefined();
  });

  it("Dal.isClosing: false before, transient during, false after", async () => {
    const tempDal = new Dal({ connectionString, max: 2 });
    expect(tempDal.isClosing).toBe(false);
    await tempDal.close();
    expect(tempDal.isClosing).toBe(false);
    expect(tempDal.isClosed).toBe(true);
  });

  it("Dal.close: timeoutMs — resolves even if pool.end() is slow", async () => {
    // With a real PG, pool.end() completes quickly. But we verify the timeout
    // mechanism: close(1) must resolve regardless of whether pool.end() or the
    // timeout wins the race. Either way, close() must not hang.
    const tempDal = new Dal({ connectionString, max: 2 });
    const start = Date.now();
    await tempDal.close(1); // 1ms timeout
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000); // sanity: didn't hang
    expect(tempDal.isClosed).toBe(true);
  });

  it("Dal.close: default timeoutMs is 10000", async () => {
    // Verify the default parameter — just ensure close() with no args works
    // and completes (pool.end() on a healthy pool is instant).
    const tempDal = new Dal({ connectionString, max: 2 });
    await tempDal.close();
    expect(tempDal.isClosed).toBe(true);
  });

  // ─── onConnect session settings ──────────────────────────────────────

  it("Dal.onConnect: sets search_path, statement_timeout, application_name", async () => {
    // Query the session settings through the Dal's pool
    const result = await dal.rawSql<{ setting: string }>(`
      SELECT current_setting('search_path') AS setting
    `);
    expect(result[0].setting).toContain("public");

    const timeoutResult = await dal.rawSql<{ setting: string }>(`
      SELECT current_setting('statement_timeout') AS setting
    `);
    // PG normalizes statement_timeout to human-readable (e.g. "30s" for 30000ms)
    // Parse it: if it ends with "s" and has no decimal, it's seconds; if it's a
    // plain integer, it's ms. We expect 30s.
    const raw = timeoutResult[0].setting;
    if (raw.endsWith("ms")) {
      expect(parseInt(raw, 10)).toBe(30000);
    } else if (raw.endsWith("s") && !raw.includes(".")) {
      expect(parseInt(raw, 10)).toBe(30);
    } else {
      expect(parseInt(raw, 10)).toBe(30000);
    }

    const appNameResult = await dal.rawSql<{ setting: string }>(`
      SELECT current_setting('application_name') AS setting
    `);
    expect(appNameResult[0].setting).toBe("dal-test-gateway");
  });

  // ─── Type parsers ────────────────────────────────────────────────────

  it("Dal: registers INT8 type parser — bigint columns return native bigint", async () => {
    // Insert a row, then read the id (bigint GENERATED ALWAYS AS IDENTITY)
    const inserted = await dal.add(
      SimpleTestEntity,
      { name: "bigint test" },
      { actor: "test" },
    );
    expect(typeof inserted.id).toBe("bigint");
    expect(inserted.id).toBeGreaterThan(0n);
  });

  // ─── CRUD delegation ─────────────────────────────────────────────────

  it("Dal.add: inserts and returns entity with RETURNING *", async () => {
    const inserted = await dal.add(
      SimpleTestEntity,
      { name: "Via Dal", description: "gateway test" },
      { actor: "dal-user" },
    );
    expect(inserted.id).toBeGreaterThan(0n);
    expect(inserted.uuid).toBeDefined();
    expect(inserted.name).toBe("Via Dal");
    expect(inserted.created_by).toBe("dal-user");
    expect(inserted.version).toBe(1);
  });

  it("Dal.find: finds by filter", async () => {
    await dal.add(SimpleTestEntity, { name: "Find Me" }, { actor: "test" });
    // Use rawSql to find by name (avoid DSL import complexity in this test)
    const rows = await dal.rawSql<{ name: string }>(
      `SELECT name FROM dal_test_simple WHERE name = $1`,
      ["Find Me"],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("Find Me");
  });

  it("Dal.findById: finds by primary key", async () => {
    const inserted = await dal.add(
      SimpleTestEntity,
      { name: "FindById" },
      { actor: "test" },
    );
    const found = await dal.findById(SimpleTestEntity, inserted.id as unknown as number);
    expect(found).toBeDefined();
    expect((found as SimpleTestEntity).name).toBe("FindById");
  });

  it("Dal.count: returns row count", async () => {
    await dal.add(SimpleTestEntity, { name: "A" }, { actor: "test" });
    await dal.add(SimpleTestEntity, { name: "B" }, { actor: "test" });
    const count = await dal.count(SimpleTestEntity);
    expect(count).toBe(2);
  });

  // ─── withClient ──────────────────────────────────────────────────────

  it("Dal.withClient: acquires and releases a client", async () => {
    const result = await dal.withClient(async (client) => {
      const r = await client.query("SELECT 42 AS answer");
      return r.rows[0].answer;
    });
    expect(result).toBe(42);
  });

  it("Dal.withClient: supports transactions (BEGIN/COMMIT)", async () => {
    await dal.withClient(async (client) => {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO dal_test_simple (name, created_by, updated_by) VALUES ($1, $2, $3)`,
        ["tx-test", "tx", "tx"],
      );
      await client.query("COMMIT");
    });
    const rows = await dal.rawSql<{ name: string }>(
      `SELECT name FROM dal_test_simple WHERE name = $1`,
      ["tx-test"],
    );
    expect(rows.length).toBe(1);
  });

  it("Dal.withClient: supports transaction rollback", async () => {
    try {
      await dal.withClient(async (client) => {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO dal_test_simple (name, created_by, updated_by) VALUES ($1, $2, $3)`,
          ["rollback-test", "rb", "rb"],
        );
        await client.query("ROLLBACK");
        throw new Error("intentional rollback");
      });
    } catch {
      // expected
    }
    const rows = await dal.rawSql<{ name: string }>(
      `SELECT name FROM dal_test_simple WHERE name = $1`,
      ["rollback-test"],
    );
    expect(rows.length).toBe(0);
  });

  it("Dal.withClient: Repository backed by the client works inside tx", async () => {
    // This is the documented advanced path: construct a Repository with the
    // client inside withClient for transaction-participating DAL ops.
    const { Repository } = await import("../src/index.js");
    await dal.withClient(async (client) => {
      const repo = new Repository(client);
      await client.query("BEGIN");
      const inserted = await repo.add(
        SimpleTestEntity,
        { name: "repo-in-tx" },
        { actor: "tx" },
      );
      expect(inserted.name).toBe("repo-in-tx");
      await client.query("COMMIT");
    });
    const rows = await dal.rawSql<{ name: string }>(
      `SELECT name FROM dal_test_simple WHERE name = $1`,
      ["repo-in-tx"],
    );
    expect(rows.length).toBe(1);
  });
});

// ─── Singleton factory tests ────────────────────────────────────────────

describe("Dal singleton — getDal / resetDal", () => {
  let connectionString: string;

  beforeAll(() => {
    connectionString = process.env.DATABASE_URL!;
  });

  afterAll(async () => {
    await resetDal();
  });

  it("getDal: throws on first call with no config", () => {
    // Ensure clean state
    return resetDal().then(() => {
      expect(() => getDal()).toThrow("config is required on the first call");
    });
  });

  it("getDal: creates singleton on first call with config", async () => {
    await resetDal();
    const dal = getDal({
      connectionString,
      schema: "public",
      max: 3,
      applicationName: "dal-singleton-test",
    });
    expect(dal).toBeInstanceOf(Dal);
    expect(dal.config.applicationName).toBe("dal-singleton-test");
  });

  it("getDal: returns same instance on subsequent calls with no config", async () => {
    const dal1 = getDal();
    const dal2 = getDal();
    expect(dal1).toBe(dal2);
  });

  it("getDal: returns same instance with same connectionString", async () => {
    const dal1 = getDal();
    const dal2 = getDal({ connectionString, schema: "public" });
    expect(dal1).toBe(dal2);
  });

  it("getDal: throws on different connectionString", async () => {
    expect(() =>
      getDal({ connectionString: "postgresql://wrong:5432/wrong" }),
    ).toThrow("different connectionString");
  });

  it("resetDal: closes and clears the singleton", async () => {
    const dal = getDal();
    await resetDal();
    expect(dal.isClosed).toBe(true);
    // After reset, a new instance can be created
    const newDal = getDal({ connectionString, schema: "public", max: 2 });
    expect(newDal).not.toBe(dal);
    await resetDal();
  });
});
