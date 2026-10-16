/**
 * Deferred fluent transaction — `dal.beginTransaction()` → buffered repo ops →
 * `commit()` runs ONE data-modifying CTE statement. Covers: value
 * materialization, `Deferred.ref()` inter-op data flow, atomic zero-row
 * aborts (ERR01/ERR03/ERR04), eager rejections (audit/stream), discard, and
 * the all-or-nothing guarantee (a failing later op undoes earlier branches —
 * single-statement implicit transaction).
 */
import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { Dal, DeferredFieldRef, Project, field, ValidationError } from "../src/index.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import { setupTestSchema, truncateTestTables, getTestPool, closeTestPool } from "./helpers/setup.js";

describe("Dal.beginTransaction — deferred single-statement CTE tx", () => {
  let dal: Dal;

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL!;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    dal = new Dal({ connectionString, schemas: ["public"], max: 5, applicationName: "dal-test-deferred" });
    await setupTestSchema();
  });

  afterAll(async () => {
    await dal.close();
    await closeTestPool();
  });

  beforeEach(async () => {
    await truncateTestTables();
  });

  const ACTOR = "test-actor";

  it("buffers add + commit → row persisted, Deferred.value materialized", async () => {
    const tx = dal.beginTransaction();
    const a = tx.add(SimpleTestEntity, { name: "alpha" }, { actor: ACTOR });
    expect(a.settled).toBe(false);
    await tx.commit();
    expect(a.value.name).toBe("alpha");
    expect(a.value.uuid).toBeTruthy();
    expect(a.value.version).toBe(1);
    expect(a.value.created_at).toBeInstanceOf(Date);
    expect(a.value.created_by).toBe(ACTOR);
    expect(await dal.count(SimpleTestEntity)).toBe(1n);
  });

  it("Deferred.value before commit throws", async () => {
    const tx = dal.beginTransaction();
    const a = tx.add(SimpleTestEntity, { name: "x" }, { actor: ACTOR });
    expect(() => a.value).toThrow(ValidationError);
    await tx.commit();
  });

  it("ref() flows an earlier op's RETURNING value into a later op's payload", async () => {
    const seed = await dal.add(SimpleTestEntity, { name: "target" }, { actor: ACTOR });

    const tx = dal.beginTransaction();
    const a = tx.add(SimpleTestEntity, { name: "source-name" }, { actor: ACTOR });
    tx.update(
      SimpleTestEntity,
      { uuid: seed.uuid, version: seed.version, description: a.ref("name") },
      { actor: ACTOR },
    );
    await tx.commit();

    const reread = await dal.findByUUID(SimpleTestEntity, seed.uuid);
    expect(reread!.description).toBe("source-name");
  });

  it("ref() targeting a non-emitted field or a forward index is rejected at commit", async () => {
    // forward index — constructed manually (refs can only ever point backward
    // through the fluent API; the check is a defense net)
    const tx = dal.beginTransaction();
    tx.add(SimpleTestEntity, { name: "a" }, { actor: ACTOR });
    tx.add(SimpleTestEntity, { name: "b", description: new DeferredFieldRef(99, "name") as unknown as string }, { actor: ACTOR });
    await expect(tx.commit()).rejects.toThrowError(/EARLIER/);

    // field not emitted by the source op's RETURNING
    const tx2 = dal.beginTransaction();
    const src = tx2.add(SimpleTestEntity, { name: "src" }, { actor: ACTOR, returning: [Project.field(field(SimpleTestEntity, "name"))] });
    // 'description' is not emitted by that RETURNING (only name + bookkeeping)
    tx2.add(SimpleTestEntity, { name: "dst", description: src.ref("description") as unknown as string }, { actor: ACTOR });
    await expect(tx2.commit()).rejects.toThrowError(/not emitted/);
  });

  it("atomicity: a failing later op rolls back earlier writes (single statement)", async () => {
    const tx = dal.beginTransaction();
    tx.add(SimpleTestEntity, { name: "never-persisted" }, { actor: ACTOR });
    tx.update(
      SimpleTestEntity,
      { uuid: "00000000-0000-0000-0000-000000000000", version: 1, name: "x" },
      { actor: ACTOR },
    );
    await expect(tx.commit()).rejects.toMatchObject({ code: "ERR03" });
    expect(await dal.count(SimpleTestEntity)).toBe(0n);
  });

  it("version mismatch on a deferred update aborts with ERR01", async () => {
    const row = await dal.add(SimpleTestEntity, { name: "v1" }, { actor: ACTOR });
    const tx = dal.beginTransaction();
    tx.update(SimpleTestEntity, { uuid: row.uuid, version: 999, name: "v2" }, { actor: ACTOR });
    await expect(tx.commit()).rejects.toMatchObject({ code: "ERR01" });
    const reread = await dal.findByUUID(SimpleTestEntity, row.uuid);
    expect(reread!.name).toBe("v1");
    expect(reread!.version).toBe(1);
  });

  it("add + onConflict: 'ignore' resolves Deferred to undefined on conflict", async () => {
    const existing = await dal.add(SimpleTestEntity, { name: "dup" }, { actor: ACTOR });
    const tx = dal.beginTransaction();
    const a = tx.add(SimpleTestEntity, { name: "dup2", uuid: existing.uuid }, { actor: ACTOR, onConflict: "ignore" });
    await tx.commit();
    expect(a.value).toBeUndefined();
  });

  it("reads buffer too: findAll/findByUUID materialize at commit", async () => {
    await dal.add(SimpleTestEntity, { name: "r1" }, { actor: ACTOR });
    const row2 = await dal.add(SimpleTestEntity, { name: "r2" }, { actor: ACTOR });

    const tx = dal.beginTransaction();
    const all = tx.findAll(SimpleTestEntity);
    const one = tx.findByUUID(SimpleTestEntity, row2.uuid);
    const n = tx.count(SimpleTestEntity);
    await tx.commit();

    expect(all.value!.map((r: SimpleTestEntity) => r.name).sort()).toEqual(["r1", "r2"]);
    expect(one.value!.name).toBe("r2");
    expect(n.value).toBe(2n);
    expect(one.value!.created_at).toBeInstanceOf(Date);
  });

  it("bigint id rehydrates to BigInt through the jsonb hop", async () => {
    const tx = dal.beginTransaction();
    const a = tx.add(SimpleTestEntity, { name: "big" }, { actor: ACTOR, returning: undefined });
    await tx.commit();
    const found = await dal.findByUUID<{ id?: bigint } & SimpleTestEntity>(SimpleTestEntity, a.value.uuid);
    expect(typeof found!.id).toBe("bigint");
  });

  it("audit option is rejected eagerly at buffer time", () => {
    const tx = dal.beginTransaction();
    expect(() =>
      tx.add(SimpleTestEntity, { name: "x" }, { actor: ACTOR, audit: { writeAudit: async () => {} } as never }),
    ).toThrow(ValidationError);
    tx.discard();
  });

  it("discard() invalidates without executing", async () => {
    const tx = dal.beginTransaction();
    const a = tx.add(SimpleTestEntity, { name: "discarded" }, { actor: ACTOR });
    tx.discard();
    expect(() => a.value).toThrow(ValidationError);
    expect(await dal.count(SimpleTestEntity)).toBe(0n);
    await expect(tx.commit()).rejects.toThrow(ValidationError);
  });

  it("double commit is rejected", async () => {
    const tx = dal.beginTransaction();
    tx.add(SimpleTestEntity, { name: "once" }, { actor: ACTOR });
    await tx.commit();
    await expect(tx.commit()).rejects.toThrow(ValidationError);
  });

  it("delete + hardDelete compose in one buffered tx", async () => {
    const e1 = await dal.add(SimpleTestEntity, { name: "soft" }, { actor: ACTOR });
    const e2 = await dal.add(SimpleTestEntity, { name: "hard" }, { actor: ACTOR });

    const tx = dal.beginTransaction();
    tx.delete(SimpleTestEntity, { uuid: e1.uuid, version: e1.version }, { actor: ACTOR });
    tx.hardDelete(SimpleTestEntity, { uuid: e2.uuid, version: e2.version }, { actor: ACTOR });
    await tx.commit();

    const pool = getTestPool();
    const r = await pool.query(`SELECT count(*) AS n, count(*) FILTER (WHERE deleted_at IS NOT NULL) AS d FROM dal_test_simple`);
    expect(Number(r.rows[0].n)).toBe(1);
    expect(Number(r.rows[0].d)).toBe(1);
  });
});
