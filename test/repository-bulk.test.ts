import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { Repository, ValidationError } from "../src/index.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

describe("Repository — bulk operations (SimpleTestEntity)", () => {
  let pool: Pool;
  let repo: Repository;

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

  // ─── addMany ──────────────────────────────────────────────────────
  // Bulk ops return a BulkResult { received, affected } — no RETURNING.
  // Assertions verify persisted state via findAll/findByUUID/count.
  // Caller-provided uuids make rows locatable.

  it("addMany: inserts multiple rows (verified via findAll)", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      uuid: randomUUID(),
      name: `Bulk ${i}`,
    }));

    const result = await repo.addMany(SimpleTestEntity, rows, { actor: "bulk-user" });
    expect(result).toEqual({ received: 5, affected: 5 });

    const stored = await repo.findAll(SimpleTestEntity);
    expect(stored).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      const row = stored.find((r) => r.uuid === rows[i].uuid)!;
      expect(row.id).toBeGreaterThan(0n);
      expect(row.name).toBe(`Bulk ${i}`);
      expect(row.version).toBe(1);
      expect(row.created_by).toBe("bulk-user");
    }
  });

  it("addMany: empty input returns a zero summary", async () => {
    const result = await repo.addMany(SimpleTestEntity, [], { actor: "bulk-user" });
    expect(result).toEqual({ received: 0, affected: 0 });
    expect(await repo.count(SimpleTestEntity)).toBe(0n);
  });

  it("addMany: unique conflict raises ERR04 and rolls back the whole batch", async () => {
    const existingUuid = randomUUID();
    await repo.add(SimpleTestEntity, { uuid: existingUuid, name: "Existing" }, { actor: "bulk-user" });

    const rows = [
      { uuid: randomUUID(), name: "New 1" },
      { uuid: existingUuid, name: "Conflict" },
      { uuid: randomUUID(), name: "New 2" },
    ];

    const err = await repo.addMany(SimpleTestEntity, rows, { actor: "bulk-user" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("ERR04");
    const detail = JSON.parse(err.detail ?? "{}");
    expect(detail.conflicts).toBe(1);
    expect(detail.rows).toHaveLength(1);
    expect(detail.rows[0].uuid).toBe(existingUuid);
    expect(detail.rows[0].deleted).toBe(false);

    // Atomic: no partial writes survived — only the pre-existing row
    const stored = await repo.findAll(SimpleTestEntity);
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe("Existing");
  });

  it("addMany: all-soft-deleted conflicts raise ERR05", async () => {
    const uuids = [randomUUID(), randomUUID()];
    await repo.addMany(
      SimpleTestEntity,
      uuids.map((uuid, i) => ({ uuid, name: `Soft ${i}` })),
      { actor: "bulk-user" },
    );
    await repo.deleteMany(
      SimpleTestEntity,
      uuids.map((uuid) => ({ uuid, version: 1 })),
      { actor: "bulk-user", matchBy: "uuid" },
    );

    const err = await repo.addMany(
      SimpleTestEntity,
      uuids.map((uuid, i) => ({ uuid, name: `Re-add ${i}` })),
      { actor: "bulk-user" },
    ).catch((e) => e);
    expect(err.code).toBe("ERR05");
    const detail = JSON.parse(err.detail ?? "{}");
    expect(detail.conflicts).toBe(2);
    expect(detail.rows.every((r: { deleted: boolean }) => r.deleted)).toBe(true);
  });

  it("addMany: conflict detail is capped at 10 rows while conflicts reports the real total", async () => {
    const uuids = Array.from({ length: 15 }, () => randomUUID());
    await repo.addMany(
      SimpleTestEntity,
      uuids.map((uuid, i) => ({ uuid, name: `Cap ${i}` })),
      { actor: "bulk-user" },
    );

    const err = await repo.addMany(
      SimpleTestEntity,
      uuids.map((uuid, i) => ({ uuid, name: `Again ${i}` })),
      { actor: "bulk-user" },
    ).catch((e) => e);
    expect(err.code).toBe("ERR04");
    const detail = JSON.parse(err.detail ?? "{}");
    expect(detail.conflicts).toBe(15);
    expect(detail.rows).toHaveLength(10);
  });

  it("addMany: stamps audit fields automatically", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ name: `Audit ${i}` }));

    await repo.addMany(SimpleTestEntity, rows, { actor: "bulk-user" });

    const stored = await repo.findAll(SimpleTestEntity);
    expect(stored).toHaveLength(3);
    for (const row of stored) {
      expect(row.created_by).toBe("bulk-user");
      expect(row.updated_by).toBe("bulk-user");
      expect(row.version).toBe(1);
    }
  });

  it("addMany: handles batches larger than batch size (auto-batching)", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ name: `Batch ${i}` }));

    await repo.addMany(SimpleTestEntity, rows, { actor: "bulk-user" });

    expect(await repo.count(SimpleTestEntity)).toBe(100n);
  });

  /* upsertMany — COMMENTED OUT: method parked pending guarded/unguarded decision.
  // ─── upsertMany ───────────────────────────────────────────────────

  it("upsertMany: inserts all when no conflicts", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ name: `Upsert ${i}` }));

    const result = await repo.upsertMany(SimpleTestEntity, rows, {
      actor: "upsert-bulk-user",
      conflictTarget: "uuid",
    });
    expect(result).toEqual({ received: 5, affected: 5 });

    const stored = await repo.findAll(SimpleTestEntity);
    expect(stored).toHaveLength(5);
    for (const row of stored) {
      expect(row.version).toBe(1);
    }
  });

  it("upsertMany: updates on conflict (mixed insert + update)", async () => {
    // First, add 3 existing rows with known uuids
    const existingUuids = Array.from({ length: 3 }, () => randomUUID());
    await repo.addMany(
      SimpleTestEntity,
      existingUuids.map((uuid, i) => ({ uuid, name: `Existing ${i}` })),
      { actor: "bulk-user" },
    );

    // Build upsert payload: 3 existing uuids (update) + 2 new (insert)
    const upsertRows = [
      ...existingUuids.map((uuid, i) => ({ uuid, name: `Updated ${i}` })),
      { name: "New 0" },
      { name: "New 1" },
    ];

    const result = await repo.upsertMany(SimpleTestEntity, upsertRows, {
      actor: "upsert-bulk-user",
      conflictTarget: "uuid",
    });
    expect(result.received).toBe(5);
    expect(result.affected).toBe(5);

    const stored = await repo.findAll(SimpleTestEntity);
    expect(stored).toHaveLength(5);

    // The 3 existing rows should have version 2 (updated)
    const updatedRows = stored.filter((r) => r.name.startsWith("Updated"));
    expect(updatedRows).toHaveLength(3);
    for (const row of updatedRows) {
      expect(row.version).toBe(2);
      expect(row.updated_by).toBe("upsert-bulk-user");
      expect(row.created_by).toBe("bulk-user");
    }

    // The 2 new rows should have version 1 (inserted)
    const newRows = stored.filter((r) => r.name.startsWith("New"));
    expect(newRows).toHaveLength(2);
    for (const row of newRows) {
      expect(row.version).toBe(1);
    }
  });

  it("upsertMany: empty input returns a zero summary", async () => {
    const result = await repo.upsertMany(SimpleTestEntity, [], {
      actor: "upsert-bulk-user",
      conflictTarget: "uuid",
    });
    expect(result).toEqual({ received: 0, affected: 0 });
    expect(await repo.count(SimpleTestEntity)).toBe(0n);
  });
  */

  // ─── deleteMany ───────────────────────────────────────────────────

  it("deleteMany: soft-deletes multiple rows by uuid", async () => {
    const uuids = Array.from({ length: 5 }, () => randomUUID());
    await repo.addMany(
      SimpleTestEntity,
      uuids.map((uuid, i) => ({ uuid, name: `Delete ${i}` })),
      { actor: "bulk-user" },
    );

    const result = await repo.deleteMany(
      SimpleTestEntity,
      uuids.map((uuid) => ({ uuid, version: 1 })),
      { actor: "bulk-deleter", matchBy: "uuid" },
    );
    expect(result).toEqual({ received: 5, affected: 5 });

    // findAll excludes soft-deleted rows → nothing left visible
    expect(await repo.findAll(SimpleTestEntity)).toHaveLength(0);
    // Rows still exist, flagged deleted
    const all = await repo.findAll(SimpleTestEntity, null, { deletedRecords: "INCLUDED" });
    expect(all).toHaveLength(5);
    for (const row of all) {
      expect(row.deleted_at).toBeInstanceOf(Date);
      expect(row.deleted_by).toBe("bulk-deleter");
    }
  });

  it("deleteMany: empty input returns a zero summary", async () => {
    const result = await repo.deleteMany(SimpleTestEntity, [], {
      actor: "bulk-deleter",
      matchBy: "uuid",
    });
    expect(result).toEqual({ received: 0, affected: 0 });
  });

  it("deleteMany: one vanished row raises ERR03 and rolls back — nothing deleted", async () => {
    const uuid = randomUUID();
    await repo.add(SimpleTestEntity, { uuid, name: "One" }, { actor: "bulk-user" });
    const ghost = randomUUID();

    let caught: unknown;
    try {
      await repo.deleteMany(
        SimpleTestEntity,
        [{ uuid, version: 1 }, { uuid: ghost, version: 1 }],
        { actor: "bulk-deleter", matchBy: "uuid" },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("ERR03"); // the only offender vanished → ERR03 top-level
    const detail = JSON.parse((caught as { detail?: string }).detail ?? "{}");
    expect(detail.stale).toBe(1);
    expect(detail.rows).toHaveLength(1);
    expect(detail.rows[0].code).toBe("ERR03");
    expect(detail.rows[0].vanished).toBe(true);

    // Atomic rollback — the live row is untouched
    const stored = await repo.findAll(SimpleTestEntity);
    expect(stored).toHaveLength(1);
    expect(stored[0].deleted_at).toBeNull();
  });

  // ─── updateMany (TEMP TABLE strategy) ─────────────────────────────

  it("updateMany: updates multiple rows via TEMP TABLE strategy", async () => {
    const uuids = Array.from({ length: 5 }, () => randomUUID());
    await repo.addMany(
      SimpleTestEntity,
      uuids.map((uuid, i) => ({ uuid, name: `Original ${i}` })),
      { actor: "bulk-user" },
    );

    const result = await repo.updateMany(
      SimpleTestEntity,
      uuids.map((uuid, i) => ({ uuid, name: `Updated ${i}`, version: 1 })),
      { actor: "bulk-updater", matchBy: "uuid" },
    );
    expect(result).toEqual({ received: 5, affected: 5 });

    const stored = await repo.findAll(SimpleTestEntity);
    for (let i = 0; i < 5; i++) {
      const row = stored.find((r) => r.uuid === uuids[i])!;
      expect(row.name).toBe(`Updated ${i}`);
      expect(row.version).toBe(2);
    }
  });

  it("updateMany: throws ValidationError when no columns to update", async () => {
    const uuids = Array.from({ length: 3 }, () => randomUUID());
    await repo.addMany(
      SimpleTestEntity,
      uuids.map((uuid, i) => ({ uuid, name: `NoCol ${i}` })),
      { actor: "bulk-user" },
    );

    const updates = uuids.map((uuid) => ({ uuid, version: 1 }));

    await expect(
      repo.updateMany(SimpleTestEntity, updates, { actor: "bulk-updater", matchBy: "uuid" })
    ).rejects.toThrow(ValidationError);
  });

  it("updateMany: empty input returns a zero summary", async () => {
    const result = await repo.updateMany(SimpleTestEntity, [], {
      actor: "bulk-updater",
      matchBy: "uuid",
    });
    expect(result).toEqual({ received: 0, affected: 0 });
  });

  it("updateMany: handles large batches (100 rows)", async () => {
    const uuids = Array.from({ length: 100 }, () => randomUUID());
    await repo.addMany(
      SimpleTestEntity,
      uuids.map((uuid, i) => ({ uuid, name: `Large ${i}` })),
      { actor: "bulk-user" },
    );

    await repo.updateMany(
      SimpleTestEntity,
      uuids.map((uuid, i) => ({ uuid, name: `Large Updated ${i}`, version: 1 })),
      { actor: "bulk-updater", matchBy: "uuid" },
    );

    const stored = await repo.findAll(SimpleTestEntity);
    expect(stored).toHaveLength(100);
    for (const row of stored) {
      expect(row.name).toMatch(/^Large Updated \d+$/);
      expect(row.version).toBe(2);
    }
  });

  // ─── timeout / atomicity ──────────────────────────────────────────

  it("addMany: timeoutMs=1 aborts the statement and rolls back — zero rows written", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      uuid: randomUUID(),
      name: `Timeout ${i}`,
    }));

    await expect(
      repo.addMany(SimpleTestEntity, rows, { actor: "bulk-user", timeoutMs: 1 }),
    ).rejects.toThrow();

    expect(await repo.count(SimpleTestEntity)).toBe(0n);
  });

  it("updateMany: timeoutMs=1 aborts mid-operation — no update survives", async () => {
    const uuids = Array.from({ length: 3 }, () => randomUUID());
    await repo.addMany(
      SimpleTestEntity,
      uuids.map((uuid, i) => ({ uuid, name: `Keep ${i}` })),
      { actor: "bulk-user" },
    );

    await expect(
      repo.updateMany(
        SimpleTestEntity,
        uuids.map((uuid, i) => ({ uuid, name: `Changed ${i}`, version: 1 })),
        { actor: "bulk-updater", matchBy: "uuid", timeoutMs: 1 },
      ),
    ).rejects.toThrow();

    const stored = await repo.findAll(SimpleTestEntity);
    for (const row of stored) {
      expect(row.name).toMatch(/^Keep \d+$/);
      expect(row.version).toBe(1);
    }
  });

  // ─── expected_version guard ───────────────────────────────────────

  it("updateMany: missing version raises ERR02 with per-row detail — nothing written", async () => {
    const uuids = Array.from({ length: 3 }, () => randomUUID());
    await repo.addMany(
      SimpleTestEntity,
      uuids.map((uuid, i) => ({ uuid, name: `V ${i}` })),
      { actor: "bulk-user" },
    );

    let caught: unknown;
    try {
      await repo.updateMany(
        SimpleTestEntity,
        [
          { uuid: uuids[0], name: "X", version: 1 },
          { uuid: uuids[1], name: "X" }, // missing version
          { uuid: uuids[2], name: "X", version: 1 },
        ],
        { actor: "bulk-updater", matchBy: "uuid" },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("ERR02");
    const detail = (caught as { detail?: { missing?: number; rows?: unknown[] } }).detail;
    expect(detail?.missing).toBe(1);
    expect(detail?.rows).toHaveLength(1);
    expect((detail!.rows as { code: string }[])[0].code).toBe("ERR02");
    // No UPDATE ran at all — names untouched
    const stored = await repo.findAll(SimpleTestEntity);
    for (const row of stored) expect(row.name).toMatch(/^V \d+$/);
  });

  it("updateMany: stale version raises ERR01 with expected/actual per-row detail — rollback", async () => {
    const uuids = Array.from({ length: 3 }, () => randomUUID());
    await repo.addMany(
      SimpleTestEntity,
      uuids.map((uuid, i) => ({ uuid, name: `S ${i}` })),
      { actor: "bulk-user" },
    );

    let caught: unknown;
    try {
      await repo.updateMany(
        SimpleTestEntity,
        uuids.map((uuid, i) => ({ uuid, name: `S-upd ${i}`, version: i === 1 ? 99 : 1 })),
        { actor: "bulk-updater", matchBy: "uuid" },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("ERR01");
    const detail = JSON.parse((caught as { detail?: string }).detail ?? "{}");
    expect(detail.stale).toBe(1);
    expect(detail.rows[0].code).toBe("ERR01");
    expect(detail.rows[0].expected_version).toBe(99);
    expect(detail.rows[0].actual_version).toBe(1);
    expect(detail.rows[0].vanished).toBe(false);
    // rollback — even the two correct rows were not written
    const stored = await repo.findAll(SimpleTestEntity);
    for (const row of stored) expect(row.name).toMatch(/^S \d+$/);
  });

  it("deleteMany: all rows vanished raises ERR03", async () => {
    const ghosts = [randomUUID(), randomUUID()];
    let caught: unknown;
    try {
      await repo.deleteMany(
        SimpleTestEntity,
        ghosts.map((uuid) => ({ uuid, version: 1 })),
        { actor: "bulk-deleter", matchBy: "uuid" },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("ERR03");
    const detail = JSON.parse((caught as { detail?: string }).detail ?? "{}");
    expect(detail.stale).toBe(2);
    expect(detail.rows.every((r: { code: string }) => r.code === "ERR03")).toBe(true);
  });

  // ─── restoreMany ──────────────────────────────────────────────────

  it("restoreMany: restores soft-deleted rows with version guard", async () => {
    const uuids = Array.from({ length: 3 }, () => randomUUID());
    await repo.addMany(
      SimpleTestEntity,
      uuids.map((uuid, i) => ({ uuid, name: `Res ${i}` })),
      { actor: "bulk-user" },
    );
    await repo.deleteMany(
      SimpleTestEntity,
      uuids.map((uuid) => ({ uuid, version: 1 })),
      { actor: "bulk-user", matchBy: "uuid" },
    );
    expect(await repo.findAll(SimpleTestEntity)).toHaveLength(0);

    const result = await repo.restoreMany(
      SimpleTestEntity,
      uuids.map((uuid) => ({ uuid, version: 2 })),
      { actor: "bulk-restorer", matchBy: "uuid" },
    );
    expect(result).toEqual({ received: 3, affected: 3 });

    const stored = await repo.findAll(SimpleTestEntity);
    expect(stored).toHaveLength(3);
    for (const row of stored) {
      expect(row.deleted_at).toBeNull();
      expect(row.version).toBe(3);
    }
  });

  it("restoreMany: stale version raises ERR01 — nothing restored", async () => {
    const uuids = [randomUUID(), randomUUID()];
    await repo.addMany(
      SimpleTestEntity,
      uuids.map((uuid, i) => ({ uuid, name: `Res2 ${i}` })),
      { actor: "bulk-user" },
    );
    await repo.deleteMany(
      SimpleTestEntity,
      uuids.map((uuid) => ({ uuid, version: 1 })),
      { actor: "bulk-user", matchBy: "uuid" },
    );

    let caught: unknown;
    try {
      await repo.restoreMany(
        SimpleTestEntity,
        [{ uuid: uuids[0], version: 2 }, { uuid: uuids[1], version: 7 }],
        { actor: "bulk-restorer", matchBy: "uuid" },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("ERR01");
    expect(await repo.findAll(SimpleTestEntity)).toHaveLength(0);
  });

  it("restoreMany: empty input returns a zero summary", async () => {
    const result = await repo.restoreMany(SimpleTestEntity, [], {
      actor: "bulk-restorer",
      matchBy: "uuid",
    });
    expect(result).toEqual({ received: 0, affected: 0 });
  });
});
