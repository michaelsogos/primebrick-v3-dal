import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
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

  it("addMany: inserts multiple rows and returns them all with RETURNING *", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ name: `Bulk ${i}` }));

    const inserted = await repo.addMany(SimpleTestEntity, rows, {
      actor: "bulk-user",
    });

    expect(inserted).toHaveLength(5);
    for (let i = 0; i < inserted.length; i++) {
      expect(inserted[i].id).toBeGreaterThan(0);
      expect(inserted[i].uuid).toBeDefined();
      expect(inserted[i].name).toBe(`Bulk ${i}`);
      expect(inserted[i].version).toBe(1);
      expect(inserted[i].created_by).toBe("bulk-user");
    }
  });

  it("addMany: returns empty array for empty input", async () => {
    const inserted = await repo.addMany(SimpleTestEntity, [], {
      actor: "bulk-user",
    });
    expect(inserted).toEqual([]);
  });

  it("addMany: stamps audit fields automatically", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ name: `Audit ${i}` }));

    const inserted = await repo.addMany(SimpleTestEntity, rows, {
      actor: "bulk-user",
    });

    expect(inserted).toHaveLength(3);
    for (const row of inserted) {
      expect(row.created_by).toBe("bulk-user");
      expect(row.updated_by).toBe("bulk-user");
      expect(row.version).toBe(1);
    }
  });

  it("addMany: handles batches larger than batch size (auto-batching)", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ name: `Batch ${i}` }));

    const inserted = await repo.addMany(SimpleTestEntity, rows, {
      actor: "bulk-user",
    });

    expect(inserted).toHaveLength(100);
  });

  // ─── upsertMany ───────────────────────────────────────────────────

  it("upsertMany: inserts all when no conflicts", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ name: `Upsert ${i}` }));

    const upserted = await repo.upsertMany(SimpleTestEntity, rows, {
      actor: "upsert-bulk-user",
      conflictTarget: "uuid",
    });

    expect(upserted).toHaveLength(5);
    for (const row of upserted) {
      expect(row.version).toBe(1);
    }
  });

  it("upsertMany: updates on conflict (mixed insert + update)", async () => {
    // First, add 3 existing rows
    const existingRows = Array.from({ length: 3 }, (_, i) => ({
      name: `Existing ${i}`,
    }));
    const existing = await repo.addMany(SimpleTestEntity, existingRows, {
      actor: "bulk-user",
    });
    const existingUuids = existing.map((r) => r.uuid);

    // Build upsert payload: 3 existing uuids (update) + 2 new (insert)
    const upsertRows = [
      ...existingUuids.map((uuid, i) => ({ uuid, name: `Updated ${i}` })),
      { name: "New 0" },
      { name: "New 1" },
    ];

    const upserted = await repo.upsertMany(SimpleTestEntity, upsertRows, {
      actor: "upsert-bulk-user",
      conflictTarget: "uuid",
    });

    expect(upserted).toHaveLength(5);

    // The 3 existing rows should have version 2 (updated)
    const updatedRows = upserted.filter((r) => r.name.startsWith("Updated"));
    expect(updatedRows).toHaveLength(3);
    for (const row of updatedRows) {
      expect(row.version).toBe(2);
      expect(row.updated_by).toBe("upsert-bulk-user");
      expect(row.created_by).toBe("bulk-user");
    }

    // The 2 new rows should have version 1 (inserted)
    const newRows = upserted.filter((r) => r.name.startsWith("New"));
    expect(newRows).toHaveLength(2);
    for (const row of newRows) {
      expect(row.version).toBe(1);
    }
  });

  it("upsertMany: returns empty array for empty input", async () => {
    const upserted = await repo.upsertMany(SimpleTestEntity, [], {
      actor: "upsert-bulk-user",
      conflictTarget: "uuid",
    });
    expect(upserted).toEqual([]);
  });

  // ─── deleteMany ───────────────────────────────────────────────────

  it("deleteMany: soft-deletes multiple rows by uuid", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ name: `Delete ${i}` }));
    const inserted = await repo.addMany(SimpleTestEntity, rows, {
      actor: "bulk-user",
    });
    const uuids = inserted.map((r) => r.uuid);

    const deleted = await repo.deleteMany(SimpleTestEntity, uuids, {
      actor: "bulk-deleter",
    });

    expect(deleted).toHaveLength(5);
    for (const row of deleted) {
      expect(row.deleted_at).toBeInstanceOf(Date);
      expect(row.deleted_by).toBe("bulk-deleter");
    }
  });

  it("deleteMany: returns empty array for empty input", async () => {
    const deleted = await repo.deleteMany(SimpleTestEntity, [], {
      actor: "bulk-deleter",
    });
    expect(deleted).toEqual([]);
  });

  // ─── updateMany (TEMP TABLE strategy) ─────────────────────────────

  it("updateMany: updates multiple rows via TEMP TABLE strategy", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ name: `Original ${i}` }));
    const inserted = await repo.addMany(SimpleTestEntity, rows, {
      actor: "bulk-user",
    });

    const updates = inserted.map((r, i) => ({
      uuid: r.uuid,
      name: `Updated ${i}`,
    }));

    const updated = await repo.updateMany(SimpleTestEntity, updates, {
      actor: "bulk-updater",
    });

    expect(updated).toHaveLength(5);
    for (let i = 0; i < updated.length; i++) {
      expect(updated[i].name).toBe(`Updated ${i}`);
      expect(updated[i].version).toBe(2);
    }
  });

  it("updateMany: throws ValidationError when no columns to update", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ name: `NoCol ${i}` }));
    const inserted = await repo.addMany(SimpleTestEntity, rows, {
      actor: "bulk-user",
    });

    const updates = inserted.map((r) => ({ uuid: r.uuid }));

    await expect(
      repo.updateMany(SimpleTestEntity, updates, { actor: "bulk-updater" })
    ).rejects.toThrow(ValidationError);
  });

  it("updateMany: returns empty array for empty input", async () => {
    const updated = await repo.updateMany(SimpleTestEntity, [], {
      actor: "bulk-updater",
    });
    expect(updated).toEqual([]);
  });

  it("updateMany: handles large batches (100 rows)", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      name: `Large ${i}`,
    }));
    const inserted = await repo.addMany(SimpleTestEntity, rows, {
      actor: "bulk-user",
    });

    const updates = inserted.map((r, i) => ({
      uuid: r.uuid,
      name: `Large Updated ${i}`,
    }));

    const updated = await repo.updateMany(SimpleTestEntity, updates, {
      actor: "bulk-updater",
    });

    expect(updated).toHaveLength(100);
    for (let i = 0; i < updated.length; i++) {
      expect(updated[i].name).toBe(`Large Updated ${i}`);
      expect(updated[i].version).toBe(2);
    }
  });
});
