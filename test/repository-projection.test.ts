import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { Repository, Project, Filter, Sort, field } from "../src/index.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

/**
 * Tests for Project.expr — raw SQL expression projection.
 * Covers COUNT(*), COALESCE, string concatenation, and other aggregate/expr use cases.
 */
describe("Repository — Project.expr projection", () => {
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

  it("expr: COUNT(*) returns total row count as bigint", async () => {
    await repo.add(SimpleTestEntity, { name: "A" }, { actor: "u" });
    await repo.add(SimpleTestEntity, { name: "B" }, { actor: "u" });
    await repo.add(SimpleTestEntity, { name: "C" }, { actor: "u" });

    const result = await repo.find<SimpleTestEntity, { total: bigint }>(
      SimpleTestEntity,
      [Project.expr("COUNT(*)", "total")],
      { throwIfNotFound: false },
    );

    expect(result).toBeDefined();
    expect(typeof result!.total).toBe("bigint");
    expect(result!.total).toBe(3n);
  });

  it("expr: COUNT(*) with filter counts only matching rows", async () => {
    await repo.add(SimpleTestEntity, { name: "Alpha" }, { actor: "u" });
    await repo.add(SimpleTestEntity, { name: "Beta" }, { actor: "u" });
    await repo.add(SimpleTestEntity, { name: "Alpha2" }, { actor: "u" });

    const result = await repo.find<SimpleTestEntity, { cnt: bigint }>(
      SimpleTestEntity,
      [Project.expr("COUNT(*)", "cnt")],
      {
        filters: [Filter.fieldValue(field(SimpleTestEntity, "name"), "LIKE", "Alpha%")],
        throwIfNotFound: false,
      },
    );

    expect(result!.cnt).toBe(2n);
  });

  it("expr: COUNT(*) with deletedRecords EXCLUDED skips soft-deleted", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "Keep" }, { actor: "u" });
    await repo.add(SimpleTestEntity, { name: "Delete" }, { actor: "u" });
    await repo.delete(SimpleTestEntity, { uuid: a.uuid, version: a.version }, { actor: "u", matchBy: "uuid" });

    const excluded = await repo.find<SimpleTestEntity, { cnt: bigint }>(
      SimpleTestEntity,
      [Project.expr("COUNT(*)", "cnt")],
      { deletedRecords: "EXCLUDED", throwIfNotFound: false },
    );
    expect(excluded!.cnt).toBe(1n);

    const included = await repo.find<SimpleTestEntity, { cnt: bigint }>(
      SimpleTestEntity,
      [Project.expr("COUNT(*)", "cnt")],
      { deletedRecords: "INCLUDED", throwIfNotFound: false },
    );
    expect(included!.cnt).toBe(2n);
  });

  it("expr: COUNT(*) on empty table returns 0n", async () => {
    const result = await repo.find<SimpleTestEntity, { total: bigint }>(
      SimpleTestEntity,
      [Project.expr("COUNT(*)", "total")],
      { throwIfNotFound: false },
    );

    expect(result).toBeDefined();
    expect(result!.total).toBe(0n);
  });

  it("expr: MAX(id) returns the highest id", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A" }, { actor: "u" });
    const b = await repo.add(SimpleTestEntity, { name: "B" }, { actor: "u" });
    const c = await repo.add(SimpleTestEntity, { name: "C" }, { actor: "u" });

    const result = await repo.find<SimpleTestEntity, { max_id: bigint }>(
      SimpleTestEntity,
      [Project.expr("MAX(id)", "max_id")],
      { throwIfNotFound: false },
    );

    expect(result!.max_id).toBe(c.id);
    expect(result!.max_id).toBeGreaterThan(a.id);
    expect(result!.max_id).toBeGreaterThan(b.id);
  });

  it("expr: COALESCE returns first non-null value", async () => {
    await repo.add(SimpleTestEntity, { name: "HasDesc", description: "real desc" }, { actor: "u" });
    await repo.add(SimpleTestEntity, { name: "NoDesc" }, { actor: "u" });

    const rows = await repo.findAll<SimpleTestEntity, { name: string; fallback: string }>(
      SimpleTestEntity,
      [
        Project.field(field(SimpleTestEntity, "name")),
        Project.expr("COALESCE(description, 'none')", "fallback"),
      ],
      { sorting: [Sort.by(field(SimpleTestEntity, "name"), "ASC")] },
    );

    expect(rows).toHaveLength(2);
    const withDesc = rows.find((r) => r.name === "HasDesc");
    const noDesc = rows.find((r) => r.name === "NoDesc");
    expect(withDesc!.fallback).toBe("real desc");
    expect(noDesc!.fallback).toBe("none");
  });

  it("expr: combined field + expr projection in same query", async () => {
    await repo.add(SimpleTestEntity, { name: "X" }, { actor: "u" });
    await repo.add(SimpleTestEntity, { name: "Y" }, { actor: "u" });

    const result = await repo.find<SimpleTestEntity, { name: string; row_num: bigint }>(
      SimpleTestEntity,
      [
        Project.field(field(SimpleTestEntity, "name")),
        Project.expr("COUNT(*) OVER()", "row_num"),
      ],
      { throwIfNotFound: false },
    );

    // With throwIfNotFound: false, find returns the first row
    expect(result).toBeDefined();
    expect(result!.name).toBeDefined();
    expect(typeof result!.row_num).toBe("bigint");
    expect(result!.row_num).toBe(2n);
  });
});
