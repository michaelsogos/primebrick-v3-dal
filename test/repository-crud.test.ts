import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { Repository, NotFoundError, MultipleRowsError, RecordVanishedError, ValidationError } from "../src/index.js";
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
    // id (bigint PK) is intentionally excluded from the returned projection —
    // resolve it via findByUUID when needed.
    expect(inserted.uuid).toBeDefined();
    const stored = await repo.findByUUID(SimpleTestEntity, inserted.uuid);
    expect(stored!.id).toBeGreaterThan(0n);
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

    const stored = await repo.findByUUID(SimpleTestEntity, inserted.uuid);
    const found = await repo.findById(SimpleTestEntity, stored!.id);
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
    await repo.delete(SimpleTestEntity, { uuid: a.uuid, version: a.version }, { actor: "test-user", matchBy: "uuid" });
    await repo.add(SimpleTestEntity, { name: "Still Active" }, { actor: "test-user" });

    const rows = await repo.findAll(SimpleTestEntity);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Still Active");
  });

  it("findAll: respects deletedRecords ONLY", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "ToDelete" }, { actor: "test-user" });
    await repo.delete(SimpleTestEntity, { uuid: a.uuid, version: a.version }, { actor: "test-user", matchBy: "uuid" });
    await repo.add(SimpleTestEntity, { name: "Active" }, { actor: "test-user" });

    const rows = await repo.findAll(SimpleTestEntity, null, {
      deletedRecords: "ONLY",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("ToDelete");
  });

  it("findAll: respects deletedRecords INCLUDED", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "ToDelete" }, { actor: "test-user" });
    await repo.delete(SimpleTestEntity, { uuid: a.uuid, version: a.version }, { actor: "test-user", matchBy: "uuid" });
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
    expect(page1.total_records).toBe(15n);

    const page2 = await repo.findByPage(SimpleTestEntity, 2, 10);
    expect(page2.entities).toHaveLength(5);
    expect(page2.total_records).toBe(15n);
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
    expect(c).toBe(2n);
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
      { uuid: inserted.uuid, name: "Updated", description: "New desc", version: inserted.version },
      { actor: "updater-user", matchBy: "uuid" }
    );

    expect(updated.name).toBe("Updated");
    expect(updated.description).toBe("New desc");
    expect(updated.updated_by).toBe("updater-user");
    expect(updated.version).toBe(inserted.version + 1);
  });

  it("update: throws RecordVanishedError when uuid not found (auditable entity with version guard)", async () => {
    await expect(
      repo.update(
        SimpleTestEntity,
        { uuid: "00000000-0000-0000-0000-000000000000", name: "X", version: 1 },
        { actor: "test-user", matchBy: "uuid" }
      )
    ).rejects.toThrow(RecordVanishedError);
  });

  it("update: throws ValidationError when no fields to update", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Test" },
      { actor: "test-user" }
    );

    await expect(
      repo.update(SimpleTestEntity, { uuid: inserted.uuid, version: inserted.version }, { actor: "test-user", matchBy: "uuid" })
    ).rejects.toThrow(/no fields to update/);
  });

  // ─── delete (soft) ────────────────────────────────────────────────

  it("delete: soft-deletes row (sets deleted_at, deleted_by)", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "To Delete" },
      { actor: "test-user" }
    );

    const deleted = await repo.delete(SimpleTestEntity, { uuid: inserted.uuid, version: inserted.version }, {
      actor: "deleter-user",
      matchBy: "uuid",
    });

    expect(deleted.deleted_at).toBeInstanceOf(Date);
    expect(deleted.deleted_by).toBe("deleter-user");
    expect(deleted.version).toBe(inserted.version + 1);
  });

  it("delete: throws RecordVanishedError when uuid not found (auditable entity with version guard)", async () => {
    await expect(
      repo.delete(SimpleTestEntity, { uuid: "00000000-0000-0000-0000-000000000000", version: 1 }, {
        actor: "test-user",
        matchBy: "uuid",
      })
    ).rejects.toThrow(RecordVanishedError);
  });

  // ─── restore ──────────────────────────────────────────────────────

  it("restore: restores soft-deleted row (clears deleted_at, deleted_by)", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "To Restore" },
      { actor: "test-user" }
    );

    const deleted = await repo.delete(SimpleTestEntity, { uuid: inserted.uuid, version: inserted.version }, { actor: "test-user", matchBy: "uuid" });
    const restored = await repo.restore(SimpleTestEntity, { uuid: inserted.uuid, version: deleted.version }, {
      actor: "restorer-user",
      matchBy: "uuid",
    });

    expect(restored.deleted_at).toBeNull();
    expect(restored.deleted_by).toBeNull();
    expect(restored.updated_by).toBe("restorer-user");
  });

  it("restore: throws RecordVanishedError when uuid not found (auditable entity with version guard)", async () => {
    await expect(
      repo.restore(SimpleTestEntity, { uuid: "00000000-0000-0000-0000-000000000000", version: 1 }, {
        actor: "test-user",
        matchBy: "uuid",
      })
    ).rejects.toThrow(RecordVanishedError);
  });

  // ─── hardDelete ───────────────────────────────────────────────────

  it("hardDelete: permanently removes row", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "To Hard Delete" },
      { actor: "test-user" }
    );

    await repo.hardDelete(SimpleTestEntity, { uuid: inserted.uuid, version: inserted.version }, { actor: "test-user", matchBy: "uuid" });

    const found = await repo.findByUUID(SimpleTestEntity, inserted.uuid, {
      throwIfNotFound: false,
    });
    expect(found).toBeNull();
  });

  it("hardDelete: throws RecordVanishedError when uuid not found (auditable entity with version guard)", async () => {
    await expect(
      repo.hardDelete(SimpleTestEntity, { uuid: "00000000-0000-0000-0000-000000000000", version: 1 }, {
        actor: "test-user",
        matchBy: "uuid",
      })
    ).rejects.toThrow(RecordVanishedError);
  });

  // ─── upsert() — REMOVED API (tests preserved as comments) ────────────
  // Single-row upsert() was intentionally removed from Repository — see the
  // comment block above the removal marker in repository.ts. The equivalent
  // contract is now: add() for expected-absent rows (unique conflict raises
  // ERR04/ERR05), update() with version when the row exists.
  // These tests documented the old ON CONFLICT DO UPDATE behaviour; kept
  // here for reference until the single-row write design is finalized.
  /*
  it("upsert: inserts when no conflict (INSERT path, no version guard per OD4)", async () => {
    const result = await repo.upsert(
      SimpleTestEntity,
      { name: "Upserted" },
      { actor: "test-user", conflictTarget: "uuid" }
    );

    expect(result).toBeDefined();
    expect(result.name).toBe("Upserted");
    expect(result.version).toBe(1);
  });

  it("upsert: updates on conflict (uuid already exists, version guard applies)", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "test-user" }
    );

    const result = await repo.upsert(
      SimpleTestEntity,
      { uuid: inserted.uuid, name: "Upserted Name", version: inserted.version },
      { actor: "upsert-user", conflictTarget: "uuid" }
    );

    expect(result.name).toBe("Upserted Name");
    expect(result.version).toBe(inserted.version + 1);
    expect(result.updated_by).toBe("upsert-user");
    // created_at and created_by should be preserved
    expect(result.created_by).toBe("test-user");
  });
  */

  // ─── add() conflict semantics (onConflict) ────────────────────────────
  // Conflict behaviour: 'raise' (default) emits PG-raised ERR04 (live row) /
  // ERR05 (soft-deleted row); 'ignore' is bare ON CONFLICT DO NOTHING →
  // add() returns undefined.

  it("add onConflict 'raise' (default): inserts when no conflict", async () => {
    const result = await repo.add(
      SimpleTestEntity,
      { name: "Upserted" },
      { actor: "test-user" }
    );

    expect(result).toBeDefined();
    expect(result.name).toBe("Upserted");
    expect(result.version).toBe(1);
  });

  it("add onConflict 'raise': PG raises ERR04 on duplicate uuid (live row)", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "test-user" }
    );

    const err = await repo
      .add(SimpleTestEntity, { uuid: inserted.uuid, name: "Dup" }, { actor: "u2" })
      .then(() => null)
      .catch((e) => e);
    expect(err).not.toBeNull();
    expect(err.code).toBe("ERR04");
    // PG DETAIL carries the conflicting row's uuid + matched constraint
    const detail = JSON.parse(err.detail ?? "{}");
    expect(detail.uuid).toBe(inserted.uuid);
    expect(detail.constraint).toBe("uuid");
  });

  it("add onConflict 'raise': PG raises ERR05 on duplicate uuid of a soft-deleted row", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "To Delete" },
      { actor: "test-user" }
    );
    await repo.delete(
      SimpleTestEntity,
      { uuid: inserted.uuid, version: inserted.version },
      { actor: "test-user", matchBy: "uuid" }
    );

    const err = await repo
      .add(SimpleTestEntity, { uuid: inserted.uuid, name: "Dup" }, { actor: "u2" })
      .then(() => null)
      .catch((e) => e);
    expect(err).not.toBeNull();
    expect(err.code).toBe("ERR05");
    const detail = JSON.parse(err.detail ?? "{}");
    expect(detail.uuid).toBe(inserted.uuid);
  });

  it("add onConflict 'ignore': duplicate is skipped silently, returns undefined", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "test-user" }
    );

    const skipped = await repo.add(
      SimpleTestEntity,
      { uuid: inserted.uuid, name: "Dup" },
      { actor: "u2", onConflict: "ignore" }
    );
    expect(skipped).toBeUndefined();
    // original row untouched
    const still = await repo.findByUUID(SimpleTestEntity, inserted.uuid);
    expect(still!.name).toBe("Original");
  });

  it("add conflictKeys: narrows conflict identification to a named unique group", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "test-user" }
    );

    // conflictKeys=['uuid'] matches the uuid unique group → ERR04 with detail
    const err = await repo
      .add(
        SimpleTestEntity,
        { uuid: inserted.uuid, name: "Dup" },
        { actor: "u2", conflictKeys: ["uuid"] }
      )
      .then(() => null)
      .catch((e) => e);
    expect(err.code).toBe("ERR04");
  });

  it("add conflictKeys: throws ValidationError when keys match no unique group", async () => {
    await expect(
      repo.add(
        SimpleTestEntity,
        { name: "X" },
        { actor: "u", conflictKeys: ["name"] }
      )
    ).rejects.toThrow(ValidationError);
  });

  // ─── update() unique-conflict semantics (ERR04/ERR05 via CTE) ─────────
  // When the payload writes a @Unique column, the UPDATE carries a
  // conflict-reporting CTE (self-excluded target row) → pg_raise ERR04
  // (live conflicting row) / ERR05 (soft-deleted) with uuid + constraint +
  // keys in DETAIL. Payloads without unique columns emit the plain UPDATE.

  it("update: unique conflict on another live row raises ERR04 with uuid/constraint/keys", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A", email: "taken@x.com" }, { actor: "u" });
    const b = await repo.add(SimpleTestEntity, { name: "B", email: "free@x.com" }, { actor: "u" });

    const err = await repo
      .update(
        SimpleTestEntity,
        { uuid: b.uuid, email: "taken@x.com", version: b.version },
        { actor: "u2", matchBy: "uuid" as any }
      )
      .then(() => null)
      .catch((e) => e);
    expect(err).not.toBeNull();
    expect(err.code).toBe("ERR04");
    const detail = JSON.parse(err.detail ?? "{}");
    expect(detail.uuid).toBe(a.uuid);
    expect(detail.constraint).toBe("email");
    expect(detail.keys).toEqual({ email: "taken@x.com" });
    // the conflicting row is untouched, the attempted update rolled back
    const unchanged = await repo.findByUUID(SimpleTestEntity, b.uuid);
    expect(unchanged!.email).toBe("free@x.com");
  });

  it("update: unique conflict on a soft-deleted row raises ERR05", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A", email: "gone@x.com" }, { actor: "u" });
    await repo.delete(SimpleTestEntity, { uuid: a.uuid, version: a.version }, { actor: "u", matchBy: "uuid" as any });
    const b = await repo.add(SimpleTestEntity, { name: "B" }, { actor: "u" });

    const err = await repo
      .update(
        SimpleTestEntity,
        { uuid: b.uuid, email: "gone@x.com", version: b.version },
        { actor: "u2", matchBy: "uuid" as any }
      )
      .then(() => null)
      .catch((e) => e);
    expect(err).not.toBeNull();
    expect(err.code).toBe("ERR05");
    const detail = JSON.parse(err.detail ?? "{}");
    expect(detail.uuid).toBe(a.uuid);
    expect(detail.keys).toEqual({ email: "gone@x.com" });
  });

  it("update: rewriting the SAME unique value on the SAME row is not a conflict", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A", email: "self@x.com" }, { actor: "u" });

    const updated = await repo.update(
      SimpleTestEntity,
      { uuid: a.uuid, name: "A2", email: "self@x.com", version: a.version },
      { actor: "u2", matchBy: "uuid" as any }
    );
    expect(updated.name).toBe("A2");
    expect(updated.version).toBe(2);
  });

  it("update: stale version wins over unique conflict (ERR01, conflict not reported)", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A", email: "hold@x.com" }, { actor: "u" });
    const b = await repo.add(SimpleTestEntity, { name: "B" }, { actor: "u" });
    // bump b's version so the caller's observed version is stale
    const b2 = await repo.update(
      SimpleTestEntity,
      { uuid: b.uuid, name: "B2", version: b.version },
      { actor: "u", matchBy: "uuid" as any }
    );

    const err = await repo
      .update(
        SimpleTestEntity,
        { uuid: b.uuid, email: "hold@x.com", version: b.version }, // stale: real is b2.version
        { actor: "u2", matchBy: "uuid" as any }
      )
      .then(() => null)
      .catch((e) => e);
    expect(err).not.toBeNull();
    expect(err.code).toBe("ERR01");
  });

  it("update: payload without unique columns performs a plain update (no conflict CTE)", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A", email: "other@x.com" }, { actor: "u" });
    const b = await repo.add(SimpleTestEntity, { name: "B" }, { actor: "u" });

    // 'name' is not unique — no conflict check at all; must just work.
    const updated = await repo.update(
      SimpleTestEntity,
      { uuid: b.uuid, name: "B-renamed", version: b.version },
      { actor: "u", matchBy: "uuid" as any }
    );
    expect(updated.name).toBe("B-renamed");
  });
});
