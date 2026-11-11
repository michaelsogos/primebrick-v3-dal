import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import {
  Repository,
  NotFoundError,
  ValidationError,
  newUuidV7,
}
from "../src/index.js";
import { REPO_INTERNAL } from "../src/repository/repository.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

const V4 = "550e8400-e29b-41d4-a716-446655440000"; // well-formed uuid v4
const GARBAGE = "not-a-uuid";

/**
 * uuid v7 boundary enforcement — the public `uuid` column is the uid contract
 * (PK or @Unique): every value crossing a repository boundary must be v7.
 * SimpleTestEntity (bigint PK + unique uuid) deliberately covers the
 * non-PK-uuid shape.
 */
describe("Repository — uuid v7 boundary enforcement", () => {
  let pool: Pool;
  let repo: Repository;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestSchema();
    repo = new Repository(pool, REPO_INTERNAL);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  beforeEach(async () => {
    await truncateTestTables();
  });

  // ─── findByUUID (read boundary) ─────────────────────────────────

  it("findByUUID: rejects a v4 value at the boundary", async () => {
    await expect(repo.findByUUID(SimpleTestEntity, V4)).rejects.toThrow(
      ValidationError
    );
  });

  it("findByUUID: rejects a malformed value at the boundary", async () => {
    await expect(repo.findByUUID(SimpleTestEntity, GARBAGE)).rejects.toThrow(
      ValidationError
    );
  });

  it("findByUUID: a well-formed v7 reaches the DB (NotFound, not Validation)", async () => {
    await expect(repo.findByUUID(SimpleTestEntity, newUuidV7())).rejects.toThrow(
      NotFoundError
    );
  });

  // ─── add / addMany (app-injected uid) ────────────────────────────

  it("add: app-supplied v4 uuid rejected; v7 accepted", async () => {
    await expect(
      repo.add(SimpleTestEntity, { uuid: V4, name: "bad" }, { actor: "t" })
    ).rejects.toThrow(ValidationError);

    const uuid = newUuidV7();
    const row = await repo.add(
      SimpleTestEntity,
      { uuid, name: "good" },
      { actor: "t" }
    );
    expect(row.uuid).toBe(uuid);
  });

  it("add: omitted uuid still flows to the DB default (uuidv7)", async () => {
    const row = await repo.add(SimpleTestEntity, { name: "def" }, { actor: "t" });
    expect(row.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("addMany: one v4 in a v7 batch fails the whole call", async () => {
    await expect(
      repo.addMany(
        SimpleTestEntity,
        [
          { uuid: newUuidV7(), name: "a" },
          { uuid: V4, name: "b" },
        ],
        { actor: "t" }
      )
    ).rejects.toThrow(ValidationError);
  });

  // ─── write identity selectors (matchBy boundary) ────────────────

  it("update: v4 uuid in the identity selector rejected", async () => {
    await expect(
      repo.update(
        SimpleTestEntity,
        { uuid: V4, name: "x", version: 1 },
        { actor: "t", matchBy: "uuid" }
      )
    ).rejects.toThrow(ValidationError);
  });

  it("delete: v4 uuid in the identity selector rejected", async () => {
    await expect(
      repo.delete(
        SimpleTestEntity,
        { uuid: V4, version: 1 },
        { actor: "t", matchBy: "uuid" }
      )
    ).rejects.toThrow(ValidationError);
  });

  it("restore: v4 uuid in the identity selector rejected", async () => {
    await expect(
      repo.restore(
        SimpleTestEntity,
        { uuid: V4, version: 1 },
        { actor: "t", matchBy: "uuid" }
      )
    ).rejects.toThrow(ValidationError);
  });

  it("updateMany: one v4 selector in a v7 batch fails the whole call", async () => {
    await expect(
      repo.updateMany(
        SimpleTestEntity,
        [
          { uuid: newUuidV7(), name: "a", version: 1 },
          { uuid: V4, name: "b", version: 1 },
        ],
        { actor: "t", matchBy: "uuid" }
      )
    ).rejects.toThrow(ValidationError);
  });

  it("deleteMany: one v4 selector in a v7 batch fails the whole call", async () => {
    await expect(
      repo.deleteMany(
        SimpleTestEntity,
        [
          { uuid: newUuidV7(), version: 1 },
          { uuid: V4, version: 1 },
        ],
        { actor: "t", matchBy: "uuid" }
      )
    ).rejects.toThrow(ValidationError);
  });

  // ─── real rows: v7 selectors match and write ─────────────────────

  it("v7 selector on a live row updates correctly", async () => {
    const row = await repo.add(
      SimpleTestEntity,
      { name: "before" },
      { actor: "t" }
    );
    const updated = await repo.update(
      SimpleTestEntity,
      { uuid: row.uuid, name: "after", version: row.version },
      { actor: "t", matchBy: "uuid" }
    );
    expect(updated.name).toBe("after");
  });
});
