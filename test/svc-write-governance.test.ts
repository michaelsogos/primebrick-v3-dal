import "dotenv/config";
import "reflect-metadata";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { ValidationError } from "../src/index.js";
import { Dal } from "../src/dal/dal.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import { TestUserNoTrailEntity } from "./entities/test-user-no-trail.entity.js";
import { ManualUniqueEntity } from "./entities/manual-unique-entity.js";
import { getTestPool, setupTestSchema, truncateTestTables } from "./helpers/setup.js";

/**
 * Write-governance enforcement — construction guarantees added after the
 * "this.dal.<write> is a silent governance bypass" finding:
 *
 *  A1  `assertWriteActor` — a write on an auditable entity with NO actor
 *      throws ValidationError even when the type-level `AuditableWriteOptions`
 *      contract is bypassed via `as any`. Silent NULL author stamping is
 *      unreachable.
 *  A2  svc auditPort gate — `audit:` is bound ONLY for `@AuditTrail`
 *      entities; an Auditable-columns-only entity never attempts an INSERT
 *      into a nonexistent `{table}_audit` (before the gate every svc write
 *      on such an entity fired a swallowed `[DAL Audit Error]`).
 *  A3  `svc.bulkUpdate`/`svc.bulkPurge` — internal atomic bulk ops.
 *  A4  `beforeCreate`/`beforeUpdate` hooks receive `ctx.actor` — the SAME
 *      identity that gets stamped, not a second ambient lookup.
 */
describe("svc write governance — actor guard, trail gate, bulk ops, hook ctx", () => {
  let dal: Dal;
  const auditRows = async (table: string) => {
    const res = await getTestPool().query(`SELECT action FROM ${table} ORDER BY changed_at, uuid`);
    return res.rows as { action: string }[];
  };

  beforeAll(async () => {
    dal = new Dal({
      connectionString: process.env.DATABASE_URL!,
      schemas: ["public"],
      max: 5,
      statementTimeoutMs: 30000,
      applicationName: "dal-test-write-governance",
    });
    await setupTestSchema();
    await getTestPool().query(`
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
      CREATE TABLE IF NOT EXISTS dal_test_manual (
        id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        uuid  uuid NOT NULL DEFAULT uuidv7(),
        name  text,
        email text
      );
      CREATE UNIQUE INDEX IF NOT EXISTS dal_test_manual_uuid_idx ON dal_test_manual (uuid);
    `);
  });

  afterAll(async () => {
    await getTestPool().query(`DROP TABLE IF EXISTS dal_test_users_audit`);
    await dal.close();
  });

  beforeEach(async () => {
    await truncateTestTables();
    await getTestPool().query(`TRUNCATE TABLE dal_test_simple_audit, dal_test_users_audit`);
  });

  // ── A1 — actor runtime guard ──────────────────────────────────────────

  it("A1: add on an auditable entity without actor throws (as-any bypass closed)", async () => {
    await expect(
      dal.add(SimpleTestEntity, { name: "no-actor" }, {} as never),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("A1: update/delete/restore/hardDelete without actor throw", async () => {
    const row = await dal.add(SimpleTestEntity, { name: "seed" }, { actor: "t" });
    const match = { uuid: row.uuid, version: row.version };
    for (const op of ["update", "delete", "restore", "hardDelete"] as const) {
      const body = op === "update" ? { ...match, name: "x" } : match;
      await expect(
        (dal as any)[op](SimpleTestEntity, body, { matchBy: "uuid" }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("A1: bulk ops without actor throw", async () => {
    const row = await dal.add(SimpleTestEntity, { name: "seed" }, { actor: "t" });
    const item = { uuid: row.uuid, version: row.version };
    await expect(
      (dal as any).updateMany(SimpleTestEntity, [{ ...item, name: "x" }], { matchBy: "uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      (dal as any).hardDeleteMany(SimpleTestEntity, [item], { matchBy: "uuid" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // ── A2 — svc auditPort bound only on @AuditTrail entities ─────────────

  it("A2: svc on a no-trail entity writes ZERO audit rows (gate works)", async () => {
    const svc = dal.entityService<TestUserNoTrailEntity>({
      entity: TestUserNoTrailEntity as never,
      actor: () => "tester",
      list: { searchableKeys: ["display_name"], filterableKeys: new Set(["display_name"]) },
    });
    const row = await svc.create({ display_name: "no-trail", idp_code: "local" });
    await svc.update(row.uuid, { version: row.version, display_name: "v2" });
    // Give any would-be fire-and-forget audit write a window to land.
    await new Promise((r) => setTimeout(r, 300));
    expect(await auditRows("dal_test_users_audit")).toHaveLength(0);
  });

  it("A2: svc on an @AuditTrail entity still writes audit rows", async () => {
    const svc = dal.entityService<SimpleTestEntity>({
      entity: SimpleTestEntity as never,
      actor: () => "tester",
      list: { searchableKeys: ["name"], filterableKeys: new Set(["name"]) },
    });
    await svc.create({ name: "trail-row" });
    const deadline = Date.now() + 3000;
    let rows: { action: string }[] = [];
    while (Date.now() < deadline) {
      rows = await auditRows("dal_test_simple_audit");
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(rows.length).toBeGreaterThan(0);
  });

  // ── A3 — svc.bulkUpdate / svc.bulkPurge ───────────────────────────────

  it("A3: bulkUpdate is atomic updateMany with actor+audit bound", async () => {
    const svc = dal.entityService<SimpleTestEntity>({
      entity: SimpleTestEntity as never,
      actor: () => "bulk-actor",
      list: { searchableKeys: ["name"], filterableKeys: new Set(["name"]) },
    });
    const a = await svc.create({ name: "a" });
    const b = await svc.create({ name: "b" });
    await svc.bulkUpdate([
      { uuid: a.uuid, version: a.version, name: "a2" },
      { uuid: b.uuid, version: b.version, name: "b2" },
    ]);
    const res = await svc.list({ sort_key: "name", sort_dir: "asc" });
    expect(res.rows.map((r) => r.name)).toEqual(["a2", "b2"]);
  });

  it("A3: bulkPurge hard-deletes atomically", async () => {
    const svc = dal.entityService<SimpleTestEntity>({
      entity: SimpleTestEntity as never,
      actor: () => "bulk-actor",
      list: { searchableKeys: ["name"], filterableKeys: new Set(["name"]) },
    });
    const a = await svc.create({ name: "gone-a" });
    const b = await svc.create({ name: "gone-b" });
    await svc.bulkPurge([
      { uuid: a.uuid, version: a.version },
      { uuid: b.uuid, version: b.version },
    ]);
    const res = await svc.list({});
    expect(res.rows).toHaveLength(0);
  });

  // ── A4 — hooks receive ctx.actor (the stamped identity) ───────────────

  it("A4: beforeCreate/beforeUpdate see ctx.actor === the stamped actor", async () => {
    const seen: string[] = [];
    const svc = dal.entityService<SimpleTestEntity>({
      entity: SimpleTestEntity as never,
      actor: () => "session-user",
      list: { searchableKeys: ["name"], filterableKeys: new Set(["name"]) },
      hooks: {
        beforeCreate: (body, ctx) => {
          seen.push(`create:${ctx.actor}`);
          return body;
        },
        beforeUpdate: (uuid, body, ctx) => {
          seen.push(`update:${uuid ? ctx.actor : ctx.actor}`);
          return body;
        },
      },
    });
    const row = await svc.create({ name: "ctx-row" });
    await svc.update(row.uuid, { version: row.version, name: "ctx-row-2" });
    expect(seen).toEqual(["create:session-user", "update:session-user"]);
    expect(row.created_by).toBe("session-user");
  });

  // ── tx seam — actor guard fires inside transactions ───────────────────

  it("A1: actor guard fires inside dal.transaction (tx writes stay governed)", async () => {
    const row = await dal.add(SimpleTestEntity, { name: "tx-seed" }, { actor: "t" });
    await expect(
      dal.transaction(async (tx) =>
        tx.update(
          SimpleTestEntity,
          { uuid: row.uuid, version: row.version, name: "tx-bypass" },
          { matchBy: "uuid" },
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // ── G4 — non-auditable entity: version is absent, not required ────────

  it("G4: svc.create/update on a non-auditable entity works without version", async () => {
    await getTestPool().query(`TRUNCATE TABLE dal_test_manual RESTART IDENTITY CASCADE`);
    const svc = dal.entityService<ManualUniqueEntity>({
      entity: ManualUniqueEntity as never,
      actor: () => "t",
      list: { searchableKeys: ["name"], filterableKeys: new Set(["name"]) },
    });
    const row = await svc.create({ name: "n1", email: "e1" });
    // No version column exists on dal_test_manual — the relaxed signature
    // accepts the body without it and the repo does not enforce the lock.
    const updated = await svc.update(row.uuid, { name: "n2" });
    expect(updated.name).toBe("n2");
  });
});
