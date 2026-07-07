import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { Repository, NotFoundError, MultipleRowsError } from "../src/index.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

describe("Repository — basic CRUD (SimpleTestEntity)", () => {
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

  // ─── add ──────────────────────────────────────────────────────────

  it("add: inserts a row and returns it with RETURNING *", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Test Item", description: "A test" },
      { actor: "test-user" }
    );

    expect(inserted).toBeDefined();
    expect(inserted.id).toBeGreaterThan(0);
    expect(inserted.uuid).toBeDefined();
    expect(inserted.name).toBe("Test Item");
    expect(inserted.description).toBe("A test");
    expect(inserted.created_by).toBe("test-user");
    expect(inserted.updated_by).toBe("test-user");
    expect(inserted.version).toBe(1);
    expect(inserted.deleted_at).toBeNull();
    expect(inserted.created_at).toBeInstanceOf(Date);
    expect(inserted.updated_at).toBeInstanceOf(Date);
  });

  it("add: stamps audit fields automatically when not provided", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Auto-stamped" },
      { actor: "auto-user" }
    );

    expect(inserted.created_by).toBe("auto-user");
    expect(inserted.updated_by).toBe("auto-user");
    expect(inserted.version).toBe(1);
  });

  it("add: throws ValidationError when no columns to insert", async () => {
    await expect(
      repo.add(SimpleTestEntity, {}, { actor: "test-user" })
    ).rejects.toThrow(/no columns to insert/);
  });

  // ─── findById ─────────────────────────────────────────────────────

  it("findById: returns row by primary key", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Find by ID" },
      { actor: "test-user" }
    );

    const found = await repo.findById(SimpleTestEntity, inserted.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("Find by ID");
  });

  it("findById: throws NotFoundError when row doesn't exist (default)", async () => {
    await expect(
      repo.findById(SimpleTestEntity, 999999)
    ).rejects.toThrow(NotFoundError);
  });

  it("findById: returns null when throwIfNotFound is false", async () => {
    const found = await repo.findById(SimpleTestEntity, 999999, {
      throwIfNotFound: false,
    });
    expect(found).toBeNull();
  });

  // ─── findByUUID ───────────────────────────────────────────────────

  it("findByUUID: returns row by uuid", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Find by UUID" },
      { actor: "test-user" }
    );

    const found = await repo.findByUUID(SimpleTestEntity, inserted.uuid);
    expect(found).toBeDefined();
    expect(found!.name).toBe("Find by UUID");
  });

  it("findByUUID: throws NotFoundError when not found (default)", async () => {
    await expect(
      repo.findByUUID(SimpleTestEntity, "00000000-0000-0000-0000-000000000000")
    ).rejects.toThrow(NotFoundError);
  });

  it("findByUUID: returns null when throwIfNotFound is false", async () => {
    const found = await repo.findByUUID(
      SimpleTestEntity,
      "00000000-0000-0000-0000-000000000000",
      { throwIfNotFound: false }
    );
    expect(found).toBeNull();
  });

  // ─── find ─────────────────────────────────────────────────────────

  it("find: returns first matching row with filters", async () => {
    await repo.add(SimpleTestEntity, { name: "Alpha" }, { actor: "test-user" });
    await repo.add(SimpleTestEntity, { name: "Beta" }, { actor: "test-user" });

    const { field, Filter } = await import("../src/index.js");
    const found = await repo.find(
      SimpleTestEntity,
      null,
      {
        filters: [Filter.fieldValue(field(SimpleTestEntity, "name"), "=", "Beta")],
      }
    );
    expect(found).toBeDefined();
    expect(found!.name).toBe("Beta");
  });

  it("find: throws NotFoundError when no match (default)", async () => {
    const { field, Filter } = await import("../src/index.js");
    await expect(
      repo.find(SimpleTestEntity, null, {
        filters: [Filter.fieldValue(field(SimpleTestEntity, "name"), "=", "Nonexistent")],
      })
    ).rejects.toThrow(NotFoundError);
  });

  // ─── findAll ──────────────────────────────────────────────────────

  it("findAll: returns all non-deleted rows", async () => {
    await repo.add(SimpleTestEntity, { name: "Row 1" }, { actor: "test-user" });
    await repo.add(SimpleTestEntity, { name: "Row 2" }, { actor: "test-user" });
    await repo.add(SimpleTestEntity, { name: "Row 3" }, { actor: "test-user" });

    const rows = await repo.findAll(SimpleTestEntity);
    expect(rows).toHaveLength(3);
  });

  it("findAll: respects deletedRecords EXCLUDED (default)", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "Active" }, { actor: "test-user" });
    await repo.delete(SimpleTestEntity, { uuid: a.uuid }, { actor: "test-user", matchBy: "uuid" });
    await repo.add(SimpleTestEntity, { name: "Still Active" }, { actor: "test-user" });

    const rows = await repo.findAll(SimpleTestEntity);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Still Active");
  });

  it("findAll: respects deletedRecords ONLY", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "ToDelete" }, { actor: "test-user" });
    await repo.delete(SimpleTestEntity, { uuid: a.uuid }, { actor: "test-user", matchBy: "uuid" });
    await repo.add(SimpleTestEntity, { name: "Active" }, { actor: "test-user" });

    const rows = await repo.findAll(SimpleTestEntity, null, {
      deletedRecords: "ONLY",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("ToDelete");
  });

  it("findAll: respects deletedRecords INCLUDED", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "ToDelete" }, { actor: "test-user" });
    await repo.delete(SimpleTestEntity, { uuid: a.uuid }, { actor: "test-user", matchBy: "uuid" });
    await repo.add(SimpleTestEntity, { name: "Active" }, { actor: "test-user" });

    const rows = await repo.findAll(SimpleTestEntity, null, {
      deletedRecords: "INCLUDED",
    });
    expect(rows).toHaveLength(2);
  });

  // ─── findByPage ───────────────────────────────────────────────────

  it("findByPage: returns paginated results with total_records", async () => {
    for (let i = 0; i < 15; i++) {
      await repo.add(SimpleTestEntity, { name: `Item ${i}` }, { actor: "test-user" });
    }

    const page1 = await repo.findByPage(SimpleTestEntity, 1, 10);
    expect(page1.entities).toHaveLength(10);
    expect(page1.total_records).toBe(15);

    const page2 = await repo.findByPage(SimpleTestEntity, 2, 10);
    expect(page2.entities).toHaveLength(5);
    expect(page2.total_records).toBe(15);
  });

  it("findByPage: throws ValidationError for page < 1", async () => {
    await expect(repo.findByPage(SimpleTestEntity, 0, 10)).rejects.toThrow(
      /page number lower than 1/
    );
  });

  it("findByPage: throws ValidationError for recordsPerPage < 1", async () => {
    await expect(repo.findByPage(SimpleTestEntity, 1, 0)).rejects.toThrow(
      /records per page lower than 1/
    );
  });

  // ─── count ────────────────────────────────────────────────────────

  it("count: returns total row count", async () => {
    await repo.add(SimpleTestEntity, { name: "A" }, { actor: "test-user" });
    await repo.add(SimpleTestEntity, { name: "B" }, { actor: "test-user" });

    const c = await repo.count(SimpleTestEntity);
    expect(c).toBe(2);
  });

  // ─── update ───────────────────────────────────────────────────────

  it("update: updates fields and increments version", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "test-user" }
    );

    const updated = await repo.update(
      SimpleTestEntity,
      { uuid: inserted.uuid, name: "Updated", description: "New desc" },
      { actor: "updater-user", matchBy: "uuid" }
    );

    expect(updated.name).toBe("Updated");
    expect(updated.description).toBe("New desc");
    expect(updated.updated_by).toBe("updater-user");
    expect(updated.version).toBe(inserted.version + 1);
  });

  it("update: throws NotFoundError when uuid not found", async () => {
    await expect(
      repo.update(
        SimpleTestEntity,
        { uuid: "00000000-0000-0000-0000-000000000000", name: "X" },
        { actor: "test-user", matchBy: "uuid" }
      )
    ).rejects.toThrow(NotFoundError);
  });

  it("update: throws ValidationError when no fields to update", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Test" },
      { actor: "test-user" }
    );

    await expect(
      repo.update(SimpleTestEntity, { uuid: inserted.uuid }, { actor: "test-user", matchBy: "uuid" })
    ).rejects.toThrow(/no fields to update/);
  });

  // ─── delete (soft) ────────────────────────────────────────────────

  it("delete: soft-deletes row (sets deleted_at, deleted_by)", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "To Delete" },
      { actor: "test-user" }
    );

    const deleted = await repo.delete(SimpleTestEntity, { uuid: inserted.uuid }, {
      actor: "deleter-user",
      matchBy: "uuid",
    });

    expect(deleted.deleted_at).toBeInstanceOf(Date);
    expect(deleted.deleted_by).toBe("deleter-user");
    expect(deleted.version).toBe(inserted.version + 1);
  });

  it("delete: throws NotFoundError when uuid not found", async () => {
    await expect(
      repo.delete(SimpleTestEntity, { uuid: "00000000-0000-0000-0000-000000000000" }, {
        actor: "test-user",
        matchBy: "uuid",
      })
    ).rejects.toThrow(NotFoundError);
  });

  // ─── restore ──────────────────────────────────────────────────────

  it("restore: restores soft-deleted row (clears deleted_at, deleted_by)", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "To Restore" },
      { actor: "test-user" }
    );

    await repo.delete(SimpleTestEntity, { uuid: inserted.uuid }, { actor: "test-user", matchBy: "uuid" });
    const restored = await repo.restore(SimpleTestEntity, { uuid: inserted.uuid }, {
      actor: "restorer-user",
      matchBy: "uuid",
    });

    expect(restored.deleted_at).toBeNull();
    expect(restored.deleted_by).toBeNull();
    expect(restored.updated_by).toBe("restorer-user");
  });

  it("restore: throws NotFoundError when uuid not found", async () => {
    await expect(
      repo.restore(SimpleTestEntity, { uuid: "00000000-0000-0000-0000-000000000000" }, {
        actor: "test-user",
        matchBy: "uuid",
      })
    ).rejects.toThrow(NotFoundError);
  });

  // ─── hardDelete ───────────────────────────────────────────────────

  it("hardDelete: permanently removes row", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "To Hard Delete" },
      { actor: "test-user" }
    );

    await repo.hardDelete(SimpleTestEntity, { uuid: inserted.uuid }, { actor: "test-user", matchBy: "uuid" });

    const found = await repo.findByUUID(SimpleTestEntity, inserted.uuid, {
      throwIfNotFound: false,
    });
    expect(found).toBeNull();
  });

  it("hardDelete: throws NotFoundError when uuid not found", async () => {
    await expect(
      repo.hardDelete(SimpleTestEntity, { uuid: "00000000-0000-0000-0000-000000000000" }, {
        actor: "test-user",
        matchBy: "uuid",
      })
    ).rejects.toThrow(NotFoundError);
  });

  // ─── upsert ───────────────────────────────────────────────────────

  it("upsert: inserts when no conflict", async () => {
    const result = await repo.upsert(
      SimpleTestEntity,
      { name: "Upserted" },
      { actor: "test-user", conflictTarget: "uuid" }
    );

    expect(result).toBeDefined();
    expect(result.name).toBe("Upserted");
    expect(result.version).toBe(1);
  });

  it("upsert: updates on conflict (uuid already exists)", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "test-user" }
    );

    const result = await repo.upsert(
      SimpleTestEntity,
      { uuid: inserted.uuid, name: "Upserted Name" },
      { actor: "upsert-user", conflictTarget: "uuid" }
    );

    expect(result.name).toBe("Upserted Name");
    expect(result.version).toBe(inserted.version + 1);
    expect(result.updated_by).toBe("upsert-user");
    // created_at and created_by should be preserved
    expect(result.created_by).toBe("test-user");
  });
});
