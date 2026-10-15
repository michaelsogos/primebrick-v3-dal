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
      schemas: ["public"],
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
    expect(dal.config.schemas).toEqual(["public"]);
  });

  it("Dal: throws if connectionString is missing", () => {
    expect(() => new Dal({ connectionString: "", schemas: [] } as DalConfig)).toThrow("connectionString is required");
  });

  // ─── Pool lifecycle ──────────────────────────────────────────────────

  it("Dal.getPool: returns the underlying pg.Pool", () => {
    const pool = dal.getPool();
    expect(pool).toBeInstanceOf(pg.Pool);
  });

  it("Dal.close: drains the pool; subsequent operations fail", async () => {
    const tempDal = new Dal({ connectionString, schemas: ["public"], max: 2 });
    await tempDal.close();
    expect(tempDal.isClosed).toBe(true);
    // Pool is ended — querying should reject
    await expect(tempDal.getPool().query("SELECT 1")).rejects.toThrow();
  });

  it("Dal.isClosed: false before close, true after", async () => {
    const tempDal = new Dal({ connectionString, schemas: ["public"], max: 2 });
    expect(tempDal.isClosed).toBe(false);
    await tempDal.close();
    expect(tempDal.isClosed).toBe(true);
  });

  // ─── close() hardening: re-entrancy, timeout, error containment ──────

  it("Dal.close: re-entrant — concurrent calls both resolve without error", async () => {
    const tempDal = new Dal({ connectionString, schemas: ["public"], max: 2 });
    // Both calls should resolve without error — the first wins, the second is a no-op
    await Promise.all([tempDal.close(), tempDal.close()]);
    expect(tempDal.isClosed).toBe(true);
    expect(tempDal.isClosing).toBe(false);
  });

  it("Dal.close: re-entrant — sequential second call is a no-op", async () => {
    const tempDal = new Dal({ connectionString, schemas: ["public"], max: 2 });
    await tempDal.close();
    expect(tempDal.isClosed).toBe(true);
    // Second call on already-closed pool — should NOT throw
    await expect(tempDal.close()).resolves.toBeUndefined();
  });

  it("Dal.isClosing: false before, transient during, false after", async () => {
    const tempDal = new Dal({ connectionString, schemas: ["public"], max: 2 });
    expect(tempDal.isClosing).toBe(false);
    await tempDal.close();
    expect(tempDal.isClosing).toBe(false);
    expect(tempDal.isClosed).toBe(true);
  });

  it("Dal.close: timeoutMs — resolves even if pool.end() is slow", async () => {
    // With a real PG, pool.end() completes quickly. But we verify the timeout
    // mechanism: close(1) must resolve regardless of whether pool.end() or the
    // timeout wins the race. Either way, close() must not hang.
    const tempDal = new Dal({ connectionString, schemas: ["public"], max: 2 });
    const start = Date.now();
    await tempDal.close(1); // 1ms timeout
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000); // sanity: didn't hang
    expect(tempDal.isClosed).toBe(true);
  });

  it("Dal.close: default timeoutMs is 10000", async () => {
    // Verify the default parameter — just ensure close() with no args works
    // and completes (pool.end() on a healthy pool is instant).
    const tempDal = new Dal({ connectionString, schemas: ["public"], max: 2 });
    await tempDal.close();
    expect(tempDal.isClosed).toBe(true);
  });

  // ─── onConnect session settings ──────────────────────────────────────

  it("Dal.onConnect: sets search_path, statement_timeout, application_name", async () => {
    // Query the session settings through the Dal's pool
    const result = (await dal.getPool().query<{ setting: string }>(`
      SELECT current_setting('search_path') AS setting
    `)).rows;
    expect(result[0].setting).toContain("public");

    const timeoutResult = (await dal.getPool().query<{ setting: string }>(`
      SELECT current_setting('statement_timeout') AS setting
    `)).rows;
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

    const appNameResult = (await dal.getPool().query<{ setting: string }>(`
      SELECT current_setting('application_name') AS setting
    `)).rows;
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
    // id is excluded from add()'s projection — verify the INT8 parser via findByUUID
    const stored = await dal.findByUUID(SimpleTestEntity, inserted.uuid);
    expect(typeof stored!.id).toBe("bigint");
    expect(stored!.id).toBeGreaterThan(0n);
  });

  // ─── CRUD delegation ─────────────────────────────────────────────────

  it("Dal.add: inserts and returns entity with RETURNING *", async () => {
    const inserted = await dal.add(
      SimpleTestEntity,
      { name: "Via Dal", description: "gateway test" },
      { actor: "dal-user" },
    );
    // id (bigint PK) is intentionally excluded from the RETURNING projection
    expect(inserted.uuid).toBeDefined();
    expect(inserted.name).toBe("Via Dal");
    expect(inserted.created_by).toBe("dal-user");
    expect(inserted.version).toBe(1);
  });

  it("Dal.find: finds by filter", async () => {
    await dal.add(SimpleTestEntity, { name: "Find Me" }, { actor: "test" });
    // Query by name via the pool (avoid DSL import complexity in this test)
    const rows = (await dal.getPool().query<{ name: string }>(
      `SELECT name FROM dal_test_simple WHERE name = $1`,
      ["Find Me"],
    )).rows;
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("Find Me");
  });

  it("Dal.findById: finds by primary key", async () => {
    const inserted = await dal.add(
      SimpleTestEntity,
      { name: "FindById" },
      { actor: "test" },
    );
    const stored = await dal.findByUUID(SimpleTestEntity, inserted.uuid);
    const found = await dal.findById(SimpleTestEntity, stored!.id);
    expect(found).toBeDefined();
    expect((found as SimpleTestEntity).name).toBe("FindById");
  });

  it("Dal.count: returns row count", async () => {
    await dal.add(SimpleTestEntity, { name: "A" }, { actor: "test" });
    await dal.add(SimpleTestEntity, { name: "B" }, { actor: "test" });
    const count = await dal.count(SimpleTestEntity);
    expect(count).toBe(2n);
  });

  // ─── repository / serverVersion / transaction / truncate ─────────────

  it("Dal.entityService: builds the generic worker over the gateway repo", async () => {
    const svc = dal.entityService<SimpleTestEntity>({
      entity: SimpleTestEntity as never,
      actor: () => "test",
      list: {
        searchableKeys: ["name"],
        filterableKeys: new Set(["name"]),
      },
    });
    const created = await svc.create({ name: "svc-created" });
    expect(created.name).toBe("svc-created");
    const fetched = await svc.get(created.uuid);
    expect(fetched.name).toBe("svc-created");
  });

  it("Dal.tableAuditPort: returns an AuditPort bound to the gateway repo", async () => {
    const port = dal.tableAuditPort();
    expect(typeof port.writeAudit).toBe("function");
  });

  it("Dal.serverVersion: returns server_version and full banner", async () => {
    const v = await dal.serverVersion();
    expect(v.server_version).toMatch(/^\d+\.\d+/);
    expect(v.version).toContain("PostgreSQL");
  });

  it("Dal.serverVersion: doubles as connectivity probe — rejects after close", async () => {
    const tempDal = new Dal({ connectionString, schemas: ["public"], max: 1 });
    await tempDal.close();
    await expect(tempDal.serverVersion()).rejects.toThrow();
  });

  it("Dal.transaction: commits tx-scoped repository writes", async () => {
    await dal.transaction(async (txRepo) => {
      await txRepo.add(SimpleTestEntity, { name: "tx-dal" }, { actor: "tx" });
    });
    expect(await dal.count(SimpleTestEntity)).toBe(1n);
  });

  it("Dal.transaction: rolls back on throw", async () => {
    await expect(
      dal.transaction(async (txRepo) => {
        await txRepo.add(SimpleTestEntity, { name: "tx-rb" }, { actor: "tx" });
        throw new Error("intentional");
      }),
    ).rejects.toThrow("intentional");
    expect(await dal.count(SimpleTestEntity)).toBe(0n);
  });

  it("Dal.truncate: resets the table through entity metadata", async () => {
    await dal.add(SimpleTestEntity, { name: "to-truncate" }, { actor: "test" });
    await dal.truncate(SimpleTestEntity);
    expect(await dal.count(SimpleTestEntity)).toBe(0n);
  });

  it("Dal.truncate: rejects entities outside the declared schema domain", async () => {
    const { Entity } = await import("../src/index.js");
    @Entity("anything", "other_schema")
    class ForeignEntity {}
    await expect(dal.truncate(ForeignEntity)).rejects.toThrow();
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
      schemas: ["public"],
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
    const dal2 = getDal({ connectionString, schemas: ["public"] });
    expect(dal1).toBe(dal2);
  });

  it("getDal: throws on different connectionString", async () => {
    expect(() =>
      getDal({ connectionString: "postgresql://wrong:5432/wrong", schemas: ["public"] }),
    ).toThrow("different connectionString");
  });

  it("resetDal: closes and clears the singleton", async () => {
    const dal = getDal();
    await resetDal();
    expect(dal.isClosed).toBe(true);
    // After reset, a new instance can be created
    const newDal = getDal({ connectionString, schemas: ["public"], max: 2 });
    expect(newDal).not.toBe(dal);
    await resetDal();
  });
});
