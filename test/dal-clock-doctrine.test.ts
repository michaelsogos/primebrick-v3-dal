import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import {
  Repository,
  ValidationError,
  DAL_NOW,
} from "../src/index.js";
import { REPO_INTERNAL } from "../src/repository/repository.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import { TypeTestEntity } from "./entities/type-test-entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

/**
 * DB-clock doctrine (Phase 6):
 * - audit stamps are rendered as `clock_timestamp()` literals in SQL
 * - `DAL_NOW` sentinel → `clock_timestamp()` on add/update paths
 * - `DAL_NOW` on a non-timestamp column → ValidationError
 */
function fullTypeRow(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "11111111-1111-7111-8111-111111111111",
    int_col: 42,
    bigint_col: 1n,
    bool_col: true,
    varchar_col: "test",
    numeric_col: 1.0,
    big_numeric_col: "1",
    decimal_col: 1.0,
    timestamp_col: new Date("2020-01-01T00:00:00Z"),
    date_col: new Date("2020-01-01"),
    ...overrides,
  } as Record<string, unknown>;
}

describe("DB-clock doctrine", () => {
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

  it("audit stamps land on the DB clock (created_at ≈ statement instant)", async () => {
    const before = Date.now() - 2000;
    const row = await repo.add(
      SimpleTestEntity,
      { name: "clocked" } as never,
      { actor: "test" },
    );
    const after = Date.now() + 2000;
    expect(row.created_at).toBeInstanceOf(Date);
    expect((row.created_at as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((row.created_at as Date).getTime()).toBeLessThanOrEqual(after);
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  it("DAL_NOW on insert stamps the column server-side", async () => {
    const before = Date.now() - 2000;
    const row = await repo.add(
      TypeTestEntity,
      fullTypeRow({ timestamp_col: DAL_NOW }) as never,
      { actor: "test" },
    );
    const after = Date.now() + 2000;
    expect(row.timestamp_col).toBeInstanceOf(Date);
    expect((row.timestamp_col as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((row.timestamp_col as Date).getTime()).toBeLessThanOrEqual(after);
  });

  it("DAL_NOW on update re-stamps the column server-side", async () => {
    const created = await repo.add(
      TypeTestEntity,
      fullTypeRow() as never,
      { actor: "test" },
    );
    const before = Date.now() - 2000;
    const updated = await repo.update(
      TypeTestEntity,
      {
        uuid: created.uuid,
        timestamp_col: DAL_NOW,
        version: created.version,
      } as never,
      { actor: "test" },
    );
    const after = Date.now() + 2000;
    expect((updated.timestamp_col as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((updated.timestamp_col as Date).getTime()).toBeLessThanOrEqual(after);
  });

  it("DAL_NOW on a non-timestamp column is rejected", async () => {
    await expect(
      repo.add(
        TypeTestEntity,
        fullTypeRow({ int_col: DAL_NOW }) as never,
        { actor: "test" },
      ),
    ).rejects.toThrow(ValidationError);
  });
});
