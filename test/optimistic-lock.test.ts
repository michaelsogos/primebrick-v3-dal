import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import {
  Repository,
  MissingVersionError,
  RecordVanishedError,
  DalErrorCodes,
} from "../src/index.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

describe("Repository — optimistic concurrency control (update)", () => {
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

  // ─── ERR02: Missing version ───────────────────────────────────────

  it("ERR02: throws MissingVersionError when version is omitted on auditable update", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Test" },
      { actor: "test-user" }
    );

    await expect(
      repo.update(
        SimpleTestEntity,
        { uuid: inserted.uuid, name: "No Version" },
        { actor: "test-user", matchBy: "uuid" }
      )
    ).rejects.toThrow(MissingVersionError);
  });

  it("ERR02: error code is 'ERR02'", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Test" },
      { actor: "test-user" }
    );

    try {
      await repo.update(
        SimpleTestEntity,
        { uuid: inserted.uuid, name: "No Version" },
        { actor: "test-user", matchBy: "uuid" }
      );
      expect.fail("Should have thrown MissingVersionError");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingVersionError);
      expect((err as MissingVersionError).code).toBe(DalErrorCodes.ERR02);
    }
  });

  // ─── Happy path: correct version ──────────────────────────────────

  it("happy: update succeeds when version matches current row version", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "test-user" }
    );

    const updated = await repo.update(
      SimpleTestEntity,
      { uuid: inserted.uuid, name: "Updated", version: inserted.version },
      { actor: "test-user", matchBy: "uuid" }
    );

    expect(updated.name).toBe("Updated");
    expect(updated.version).toBe(inserted.version + 1);
  });

  it("happy: sequential updates with correct version chain", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "v1" },
      { actor: "test-user" }
    );

    const u1 = await repo.update(
      SimpleTestEntity,
      { uuid: inserted.uuid, name: "v2", version: inserted.version },
      { actor: "test-user", matchBy: "uuid" }
    );
    expect(u1.version).toBe(2);

    const u2 = await repo.update(
      SimpleTestEntity,
      { uuid: inserted.uuid, name: "v3", version: u1.version },
      { actor: "test-user", matchBy: "uuid" }
    );
    expect(u2.version).toBe(3);
  });

  // ─── ERR01: Version mismatch (concurrent edit) ────────────────────

  it("ERR01: throws PG error with code 'ERR01' when version is stale (concurrent edit)", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "test-user" }
    );

    // First writer updates successfully, bumping version to 2
    await repo.update(
      SimpleTestEntity,
      { uuid: inserted.uuid, name: "Writer 1", version: inserted.version },
      { actor: "writer1", matchBy: "uuid" }
    );

    // Second writer tries to update with stale version (1) — should get ERR01
    try {
      await repo.update(
        SimpleTestEntity,
        { uuid: inserted.uuid, name: "Writer 2", version: inserted.version },
        { actor: "writer2", matchBy: "uuid" }
      );
      expect.fail("Should have thrown ERR01");
    } catch (err) {
      // PG DatabaseError propagated by node-postgres
      expect((err as Error & { code?: string }).code).toBe(DalErrorCodes.ERR01);
      expect((err as Error).message).toContain("Optimistic Concurrency Violation");
    }
  });

  it("ERR01: error has detail field with version info", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "test-user" }
    );

    // Bump version
    await repo.update(
      SimpleTestEntity,
      { uuid: inserted.uuid, name: "Bumped", version: inserted.version },
      { actor: "writer1", matchBy: "uuid" }
    );

    // Try with stale version
    try {
      await repo.update(
        SimpleTestEntity,
        { uuid: inserted.uuid, name: "Stale", version: inserted.version },
        { actor: "writer2", matchBy: "uuid" }
      );
      expect.fail("Should have thrown ERR01");
    } catch (err) {
      const pgErr = err as Error & { code?: string; detail?: string };
      expect(pgErr.code).toBe(DalErrorCodes.ERR01);
      expect(pgErr.detail).toBeDefined();
      expect(pgErr.detail).toContain(String(inserted.version));
    }
  });

  // ─── ERR03: Record vanished (row hard-deleted) ────────────────────

  it("ERR03: throws RecordVanishedError when row was hard-deleted by another writer", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "To Delete" },
      { actor: "test-user" }
    );

    // Hard-delete the row (now requires version for auditable entities)
    await repo.hardDelete(
      SimpleTestEntity,
      { uuid: inserted.uuid, version: inserted.version },
      { actor: "deleter", matchBy: "uuid" }
    );

    // Try to update the now-vanished row with the old version
    await expect(
      repo.update(
        SimpleTestEntity,
        { uuid: inserted.uuid, name: "Ghost", version: inserted.version },
        { actor: "test-user", matchBy: "uuid" }
      )
    ).rejects.toThrow(RecordVanishedError);
  });

  it("ERR03: error code is 'ERR03'", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "To Delete" },
      { actor: "test-user" }
    );

    await repo.hardDelete(
      SimpleTestEntity,
      { uuid: inserted.uuid, version: inserted.version },
      { actor: "deleter", matchBy: "uuid" }
    );

    try {
      await repo.update(
        SimpleTestEntity,
        { uuid: inserted.uuid, name: "Ghost", version: inserted.version },
        { actor: "test-user", matchBy: "uuid" }
      );
      expect.fail("Should have thrown RecordVanishedError");
    } catch (err) {
      expect(err).toBeInstanceOf(RecordVanishedError);
      expect((err as RecordVanishedError).code).toBe(DalErrorCodes.ERR03);
    }
  });

  // ─── Version is stripped from SET clause ──────────────────────────

  it("version is not written to the SET clause (only used in WHERE)", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "test-user" }
    );

    // Update with correct version — the returned version should be incremented,
    // not the value we passed
    const updated = await repo.update(
      SimpleTestEntity,
      { uuid: inserted.uuid, name: "Updated", version: inserted.version },
      { actor: "test-user", matchBy: "uuid" }
    );

    // Version should be inserted.version + 1 (auto-incremented), NOT inserted.version
    expect(updated.version).toBe(inserted.version + 1);
  });

  // ─── delete: version guard ────────────────────────────────────────

  it("ERR02: delete throws MissingVersionError when version is omitted", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Test" },
      { actor: "test-user" }
    );

    await expect(
      repo.delete(
        SimpleTestEntity,
        { uuid: inserted.uuid },
        { actor: "test-user", matchBy: "uuid" }
      )
    ).rejects.toThrow(MissingVersionError);
  });

  it("ERR01: delete throws ERR01 when version is stale", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "test-user" }
    );

    // Bump version via update
    await repo.update(
      SimpleTestEntity,
      { uuid: inserted.uuid, name: "Bumped", version: inserted.version },
      { actor: "writer1", matchBy: "uuid" }
    );

    // Try to delete with stale version
    try {
      await repo.delete(
        SimpleTestEntity,
        { uuid: inserted.uuid, version: inserted.version },
        { actor: "writer2", matchBy: "uuid" }
      );
      expect.fail("Should have thrown ERR01");
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe(DalErrorCodes.ERR01);
    }
  });

  it("happy: delete succeeds when version matches", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "To Delete" },
      { actor: "test-user" }
    );

    const deleted = await repo.delete(
      SimpleTestEntity,
      { uuid: inserted.uuid, version: inserted.version },
      { actor: "test-user", matchBy: "uuid" }
    );

    expect(deleted.deleted_at).toBeInstanceOf(Date);
    expect(deleted.version).toBe(inserted.version + 1);
  });

  // ─── hardDelete: version guard ────────────────────────────────────

  it("ERR02: hardDelete throws MissingVersionError when version is omitted", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Test" },
      { actor: "test-user" }
    );

    await expect(
      repo.hardDelete(
        SimpleTestEntity,
        { uuid: inserted.uuid },
        { actor: "test-user", matchBy: "uuid" }
      )
    ).rejects.toThrow(MissingVersionError);
  });

  it("ERR01: hardDelete throws ERR01 when version is stale", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "test-user" }
    );

    // Bump version via update
    await repo.update(
      SimpleTestEntity,
      { uuid: inserted.uuid, name: "Bumped", version: inserted.version },
      { actor: "writer1", matchBy: "uuid" }
    );

    // Try to hardDelete with stale version
    try {
      await repo.hardDelete(
        SimpleTestEntity,
        { uuid: inserted.uuid, version: inserted.version },
        { actor: "writer2", matchBy: "uuid" }
      );
      expect.fail("Should have thrown ERR01");
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe(DalErrorCodes.ERR01);
    }
  });

  // ─── restore: version guard ───────────────────────────────────────

  it("ERR02: restore throws MissingVersionError when version is omitted", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Test" },
      { actor: "test-user" }
    );
    const deleted = await repo.delete(
      SimpleTestEntity,
      { uuid: inserted.uuid, version: inserted.version },
      { actor: "test-user", matchBy: "uuid" }
    );

    await expect(
      repo.restore(
        SimpleTestEntity,
        { uuid: inserted.uuid },
        { actor: "test-user", matchBy: "uuid" }
      )
    ).rejects.toThrow(MissingVersionError);
  });

  it("happy: restore succeeds when version matches", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "To Restore" },
      { actor: "test-user" }
    );
    const deleted = await repo.delete(
      SimpleTestEntity,
      { uuid: inserted.uuid, version: inserted.version },
      { actor: "test-user", matchBy: "uuid" }
    );

    const restored = await repo.restore(
      SimpleTestEntity,
      { uuid: inserted.uuid, version: deleted.version },
      { actor: "test-user", matchBy: "uuid" }
    );

    expect(restored.deleted_at).toBeNull();
    expect(restored.version).toBe(deleted.version + 1);
  });

  // ─── upsert: version guard (ON CONFLICT path only, per OD4) ───────

  it("upsert INSERT path: succeeds without version (OD4 — no guard on new row)", async () => {
    const result = await repo.upsert(
      SimpleTestEntity,
      { name: "New Row" },
      { actor: "test-user", conflictTarget: "uuid" }
    );

    expect(result).toBeDefined();
    expect(result.name).toBe("New Row");
    expect(result.version).toBe(1);
  });

  it("upsert ON CONFLICT path: ERR02 when version omitted on existing row", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "test-user" }
    );

    await expect(
      repo.upsert(
        SimpleTestEntity,
        { uuid: inserted.uuid, name: "Updated" },
        { actor: "test-user", conflictTarget: "uuid" }
      )
    ).rejects.toThrow(MissingVersionError);
  });

  it("upsert ON CONFLICT path: ERR01 when version is stale", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "test-user" }
    );

    // Bump version via update
    await repo.update(
      SimpleTestEntity,
      { uuid: inserted.uuid, name: "Bumped", version: inserted.version },
      { actor: "writer1", matchBy: "uuid" }
    );

    // Try to upsert with stale version
    try {
      await repo.upsert(
        SimpleTestEntity,
        { uuid: inserted.uuid, name: "Stale", version: inserted.version },
        { actor: "writer2", conflictTarget: "uuid" }
      );
      expect.fail("Should have thrown ERR01");
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe(DalErrorCodes.ERR01);
    }
  });

  it("upsert ON CONFLICT path: succeeds when version matches", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "test-user" }
    );

    const result = await repo.upsert(
      SimpleTestEntity,
      { uuid: inserted.uuid, name: "Updated", version: inserted.version },
      { actor: "upsert-user", conflictTarget: "uuid" }
    );

    expect(result.name).toBe("Updated");
    expect(result.version).toBe(inserted.version + 1);
  });
});
