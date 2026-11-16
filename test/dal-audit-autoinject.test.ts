import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import {
  Dal,
  AuditAction,
  type AuditPort,
  type AuditParams,
} from "../src/index.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import { TestUserNoTrailEntity } from "./entities/test-user-no-trail.entity.js";
import {
  getTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

/**
 * F1 — audit auto-inject on the Dal gateway.
 *
 * Contract: every write op on an `@AuditTrail()` entity writes a
 * `{table}_audit` row WITHOUT the caller passing `audit:` — audit is a
 * construction guarantee, not an opt-in. Explicit ports always win,
 * Auditable-columns-only entities never attempt a trail write, and the
 * `dal.transaction(fn)` seam writes the audit row on the same client
 * before COMMIT (atomic with the mutation).
 */

class SpyAuditPort implements AuditPort {
  entries: AuditParams[] = [];
  async writeAudit(params: AuditParams): Promise<bigint> {
    this.entries.push(params);
    return 0n;
  }
}

/** The gateway audit write is fire-and-forget — poll until it lands. */
async function eventually(assertion: () => Promise<void>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw lastErr;
}

describe("Dal gateway — audit auto-inject", () => {
  let dal: Dal;
  const pool = () => getTestPool();

  const auditRows = async (table = "dal_test_simple_audit") => {
    const res = await pool().query(
      `SELECT action, changed_by, entity_uuid, entity_id FROM ${table} ORDER BY changed_at, uuid`,
    );
    return res.rows as { action: string; changed_by: string; entity_uuid: string; entity_id: string | null }[];
  };

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set.");
    dal = new Dal({
      connectionString,
      schemas: ["public"],
      max: 5,
      statementTimeoutMs: 30000,
      applicationName: "dal-test-audit-autoinject",
    });
    await setupTestSchema();
    // Companion trail table for the no-`@AuditTrail` negative case.
    await pool().query(`
      CREATE TABLE IF NOT EXISTS dal_test_users_audit (
        uuid        uuid NOT NULL DEFAULT uuidv7() PRIMARY KEY,
        entity_id   bigint,
        entity_uuid uuid NOT NULL,
        action      text NOT NULL,
        changed_at  timestamptz NOT NULL DEFAULT now(),
        changed_by  text NOT NULL DEFAULT '',
        version     integer NOT NULL DEFAULT 1,
        delta       jsonb
      );
      TRUNCATE TABLE dal_test_users_audit;
    `);
  });

  afterAll(async () => {
    await pool().query(`DROP TABLE IF EXISTS dal_test_users_audit`);
    await dal.close();
  });

  beforeEach(async () => {
    await truncateTestTables();
    await pool().query(`TRUNCATE TABLE dal_test_simple_audit, dal_test_users_audit`);
  });

  const addRow = (name = "auto-audit") =>
    dal.add(SimpleTestEntity, { name }, { actor: "tester" });

  it("add() without `audit:` writes an INSERT audit row", async () => {
    const row = await addRow();
    await eventually(async () => {
      const rows = await auditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe(AuditAction.INSERT);
      expect(rows[0].changed_by).toBe("tester");
      expect(rows[0].entity_uuid).toBe(row.uuid);
    });
  });

  it("update/delete/restore/hardDelete without `audit:` write their audit rows", async () => {
    let row = await addRow();
    await eventually(async () => expect(await auditRows()).toHaveLength(1));

    row = await dal.update(
      SimpleTestEntity,
      { uuid: row.uuid, version: row.version, name: "v2" },
      { actor: "tester", matchBy: "uuid" },
    );
    row = await dal.delete(
      SimpleTestEntity,
      { uuid: row.uuid, version: row.version },
      { actor: "tester", matchBy: "uuid" },
    );
    row = await dal.restore(
      SimpleTestEntity,
      { uuid: row.uuid, version: row.version },
      { actor: "tester", matchBy: "uuid" },
    );
    await dal.hardDelete(
      SimpleTestEntity,
      { uuid: row.uuid, version: row.version },
      { actor: "tester", matchBy: "uuid" },
    );

    await eventually(async () => {
      const actions = (await auditRows()).map((r) => r.action);
      expect(actions).toEqual([
        AuditAction.INSERT,
        AuditAction.UPDATE,
        AuditAction.SOFT_DELETE,
        AuditAction.RESTORE,
        AuditAction.HARD_DELETE,
      ]);
    });
  });

  it("explicit `audit:` port always wins — no table port is injected", async () => {
    const spy = new SpyAuditPort();
    await dal.add(SimpleTestEntity, { name: "explicit" }, { actor: "tester", audit: spy });
    await eventually(async () => {
      expect(spy.entries).toHaveLength(1);
      expect(spy.entries[0].action).toBe(AuditAction.INSERT);
      expect(spy.entries[0].changedBy).toBe("tester");
    });
    // The table port was NOT injected — no row in the audit table.
    expect(await auditRows()).toHaveLength(0);
  });

  it("dal.transaction() seam — audit row commits atomically with the write", async () => {
    const row = await addRow();
    await eventually(async () => expect(await auditRows()).toHaveLength(1));

    await dal.transaction(async (repo) => {
      await repo.update(
        SimpleTestEntity,
        { uuid: row.uuid, version: row.version, name: "tx-name" },
        { actor: "tx-tester", matchBy: "uuid" },
      );
    });
    // Post-commit the audit row is already durable — same client, same tx.
    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].action).toBe(AuditAction.UPDATE);
    expect(rows[1].changed_by).toBe("tx-tester");
  });

  it("Auditable-columns entity without @AuditTrail() never attempts a trail write", async () => {
    await dal.add(
      TestUserNoTrailEntity,
      { display_name: "no-trail", idp_code: "local" },
      { actor: "tester" },
    );
    // Give a would-be fire-and-forget write a window to (wrongly) land.
    await new Promise((r) => setTimeout(r, 300));
    expect(await auditRows("dal_test_users_audit")).toHaveLength(0);
  });
});
