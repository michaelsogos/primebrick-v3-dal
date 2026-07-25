import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import {
  Repository,
  NotFoundError,
  MultipleRowsError,
  UnknownColumnError,
  ValidationError,
  RecordVanishedError,
} from "../src/index.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

/**
 * Negative / failure path tests — verifies that the DAL throws the correct
 * errors for invalid inputs, missing rows, and edge cases.
 */
describe("Repository — negative / failure paths", () => {
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

  // ─── NotFoundError ────────────────────────────────────────────────

  it("findById: throws NotFoundError with descriptive message", async () => {
    try {
      await repo.findById(SimpleTestEntity, 999999);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).code).toBe("NOT_FOUND");
      expect((err as NotFoundError).message).toContain("dal_test_simple");
      expect((err as NotFoundError).message).toContain("999999");
    }
  });

  it("findByUUID: throws NotFoundError with uuid in message", async () => {
    const uuid = "00000000-0000-0000-0000-000000000000";
    try {
      await repo.findByUUID(SimpleTestEntity, uuid);
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect((err as NotFoundError).message).toContain(uuid);
    }
  });

  it("find: throws NotFoundError when no filters match", async () => {
    const { field, Filter } = await import("../src/index.js");
    await expect(
      repo.find(SimpleTestEntity, null, {
        filters: [
          Filter.fieldValue(field(SimpleTestEntity, "name"), "=", "Nonexistent"),
        ],
      })
    ).rejects.toThrow(NotFoundError);
  });

  it("update: throws RecordVanishedError for non-existent uuid (auditable entity with version guard)", async () => {
    await expect(
      repo.update(
        SimpleTestEntity,
        { uuid: "00000000-0000-0000-0000-000000000000", name: "X", version: 1 },
        { actor: "test-user", matchBy: "uuid" }
      )
    ).rejects.toThrow(RecordVanishedError);
  });

  it("delete: throws RecordVanishedError for non-existent uuid (auditable entity with version guard)", async () => {
    await expect(
      repo.delete(SimpleTestEntity, { uuid: "00000000-0000-0000-0000-000000000000", version: 1 }, {
        actor: "test-user",
        matchBy: "uuid",
      })
    ).rejects.toThrow(RecordVanishedError);
  });

  it("restore: throws RecordVanishedError for non-existent uuid (auditable entity with version guard)", async () => {
    await expect(
      repo.restore(SimpleTestEntity, { uuid: "00000000-0000-0000-0000-000000000000", version: 1 }, {
        actor: "test-user",
        matchBy: "uuid",
      })
    ).rejects.toThrow(RecordVanishedError);
  });

  it("hardDelete: throws RecordVanishedError for non-existent uuid (auditable entity with version guard)", async () => {
    await expect(
      repo.hardDelete(SimpleTestEntity, { uuid: "00000000-0000-0000-0000-000000000000", version: 1 }, {
        actor: "test-user",
        matchBy: "uuid",
      })
    ).rejects.toThrow(RecordVanishedError);
  });

  // ─── ValidationError ──────────────────────────────────────────────

  it("add: throws ValidationError when row is empty object", async () => {
    await expect(
      repo.add(SimpleTestEntity, {}, { actor: "test-user" })
    ).rejects.toThrow(ValidationError);
  });

  it("add: throws ValidationError when all values are undefined", async () => {
    await expect(
      repo.add(
        SimpleTestEntity,
        { name: undefined, description: undefined },
        { actor: "test-user" }
      )
    ).rejects.toThrow(ValidationError);
  });

  it("update: throws ValidationError when updates is empty", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Test" },
      { actor: "test-user" }
    );
    await expect(
      repo.update(SimpleTestEntity, { uuid: inserted.uuid, version: inserted.version }, { actor: "test-user", matchBy: "uuid" })
    ).rejects.toThrow(ValidationError);
  });

  it("update: throws ValidationError when all update values are undefined", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Test" },
      { actor: "test-user" }
    );
    await expect(
      repo.update(
        SimpleTestEntity,
        { uuid: inserted.uuid, name: undefined, version: inserted.version },
        { actor: "test-user", matchBy: "uuid" }
      )
    ).rejects.toThrow(ValidationError);
  });

  it("findByPage: throws ValidationError for page 0", async () => {
    await expect(repo.findByPage(SimpleTestEntity, 0, 10)).rejects.toThrow(
      ValidationError
    );
  });

  it("findByPage: throws ValidationError for negative page", async () => {
    await expect(repo.findByPage(SimpleTestEntity, -1, 10)).rejects.toThrow(
      ValidationError
    );
  });

  it("findByPage: throws ValidationError for recordsPerPage 0", async () => {
    await expect(repo.findByPage(SimpleTestEntity, 1, 0)).rejects.toThrow(
      ValidationError
    );
  });

  // ─── UnknownColumnError ───────────────────────────────────────────

  it("add: throws UnknownColumnError for non-existent property", async () => {
    await expect(
      repo.add(
        SimpleTestEntity,
        { name: "Test", non_existent_col: "value" } as any,
        { actor: "test-user" }
      )
    ).rejects.toThrow(UnknownColumnError);
  });

  it("update: throws UnknownColumnError for non-existent property", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Test" },
      { actor: "test-user" }
    );
    await expect(
      repo.update(
        SimpleTestEntity,
        { uuid: inserted.uuid, non_existent_col: "value", version: inserted.version } as any,
        { actor: "test-user", matchBy: "uuid" }
      )
    ).rejects.toThrow(UnknownColumnError);
  });

  // ─── Silent failures (should NOT throw) ───────────────────────────

  it("addMany: empty array returns empty array (silent, no error)", async () => {
    const result = await repo.addMany(SimpleTestEntity, [], { actor: "test-user" });
    expect(result).toEqual([]);
  });

  it("upsertMany: empty array returns empty array (silent, no error)", async () => {
    const result = await repo.upsertMany(SimpleTestEntity, [], {
      actor: "test-user",
      conflictTarget: "uuid",
    });
    expect(result).toEqual([]);
  });

  it("deleteMany: empty array returns empty array (silent, no error)", async () => {
    const result = await repo.deleteMany(SimpleTestEntity, [], {
      actor: "test-user",
      matchBy: "uuid",
    });
    expect(result).toEqual([]);
  });

  it("updateMany: empty array returns empty array (silent, no error)", async () => {
    const result = await repo.updateMany(SimpleTestEntity, [], {
      actor: "test-user",
      matchBy: "uuid",
    });
    expect(result).toEqual([]);
  });

  // ─── Error code stability ─────────────────────────────────────────

  it("NotFoundError has stable code 'NOT_FOUND'", async () => {
    try {
      await repo.findById(SimpleTestEntity, 999999);
    } catch (err) {
      expect((err as NotFoundError).code).toBe("NOT_FOUND");
    }
  });

  it("ValidationError has stable code 'VALIDATION'", async () => {
    try {
      await repo.add(SimpleTestEntity, {}, { actor: "test-user" });
    } catch (err) {
      expect((err as ValidationError).code).toBe("VALIDATION");
    }
  });

  it("UnknownColumnError has stable code 'UNKNOWN_COLUMN'", async () => {
    try {
      await repo.add(
        SimpleTestEntity,
        { bad_col: "x" } as any,
        { actor: "test-user" }
      );
    } catch (err) {
      expect((err as UnknownColumnError).code).toBe("UNKNOWN_COLUMN");
    }
  });
});
