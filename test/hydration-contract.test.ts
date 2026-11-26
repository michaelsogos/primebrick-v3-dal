/**
 * Hydration contract — RETURNING rows and read rows are hydrated into entity
 * shape BY CONSTRUCTION: the TS annotation never lies at runtime.
 * Pins the ratified doctrine: version (int4 storage, bigint annotation)
 * hydrates as native bigint on EVERY path — write RETURNING and reads alike.
 */
import "dotenv/config";
import "reflect-metadata";
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import type { Pool } from "pg";
import { Repository, REPO_INTERNAL } from "../src/repository/repository.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

describe("entity-shape hydration contract — version is bigint on every path", () => {
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

  it("add RETURNING hydrates version as bigint", async () => {
    const inserted = await repo.add(SimpleTestEntity, { name: "hyd-add" }, { actor: "hyd-test" });
    expect(typeof inserted.version).toBe("bigint");
    expect(inserted.version).toBe(1n);
  });

  it("findByUUID read hydrates version as bigint", async () => {
    const inserted = await repo.add(SimpleTestEntity, { name: "hyd-read" }, { actor: "hyd-test" });
    const read = await repo.findByUUID(SimpleTestEntity, inserted.uuid);
    expect(typeof read!.version).toBe("bigint");
  });

  it("update RETURNING hydrates version as bigint", async () => {
    const inserted = await repo.add(SimpleTestEntity, { name: "hyd-upd" }, { actor: "hyd-test" });
    const updated = await repo.update(
      SimpleTestEntity,
      { uuid: inserted.uuid, version: inserted.version, name: "hyd-upd2" },
      { actor: "hyd-test" },
    );
    expect(typeof updated.version).toBe("bigint");
    expect(updated.version).toBe(2n);
  });

  it("findAll rows hydrate version as bigint", async () => {
    await repo.add(SimpleTestEntity, { name: "hyd-all" }, { actor: "hyd-test" });
    const rows = await repo.findAll(SimpleTestEntity);
    const mine = rows.find((r) => r.name === "hyd-all");
    expect(typeof mine!.version).toBe("bigint");
  });

  it("delete/restore RETURNING hydrate version as bigint", async () => {
    const inserted = await repo.add(SimpleTestEntity, { name: "hyd-del" }, { actor: "hyd-test" });
    const deleted = await repo.delete(SimpleTestEntity, { uuid: inserted.uuid, version: inserted.version }, { actor: "hyd-test" });
    expect(typeof deleted.version).toBe("bigint");
    const restored = await repo.restore(SimpleTestEntity, { uuid: inserted.uuid, version: deleted.version }, { actor: "hyd-test" });
    expect(typeof restored.version).toBe("bigint");
  });

  it("streaming rows hydrate version as bigint", async () => {
    await repo.add(SimpleTestEntity, { name: "hyd-stream" }, { actor: "hyd-test" });
    const stream = await repo.findAll(SimpleTestEntity, undefined, { stream: true });
    let saw = false;
    for await (const row of stream as AsyncIterable<SimpleTestEntity>) {
      if ((row as SimpleTestEntity).name === "hyd-stream") {
        saw = true;
        expect(typeof (row as SimpleTestEntity).version).toBe("bigint");
      }
    }
    expect(saw).toBe(true);
  });
});
