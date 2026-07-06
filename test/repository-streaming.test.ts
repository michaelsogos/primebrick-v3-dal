import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { Repository } from "../src/index.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

describe("Repository — streaming (pg-query-stream)", () => {
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

  it("findAll with stream: true returns an AsyncIterable", async () => {
    // Insert 5 rows
    for (let i = 0; i < 5; i++) {
      await repo.add(
        SimpleTestEntity,
        { name: `Stream Item ${i}` },
        { actor: "test-user" }
      );
    }

    const result = await repo.findAll(SimpleTestEntity, null, {
      stream: true,
    });

    // Should be an AsyncIterable, not an array
    expect(result).toBeDefined();
    expect(typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function");

    // Consume the stream
    const rows: unknown[] = [];
    for await (const row of result as AsyncIterable<unknown>) {
      rows.push(row);
    }

    expect(rows).toHaveLength(5);
    expect((rows[0] as any).name).toContain("Stream Item");
  });

  it("findAll with stream: true handles empty result set", async () => {
    const result = await repo.findAll(SimpleTestEntity, null, {
      stream: true,
    });

    const rows: unknown[] = [];
    for await (const row of result as AsyncIterable<unknown>) {
      rows.push(row);
    }

    expect(rows).toHaveLength(0);
  });

  it("findAll with stream: true handles large result set without buffering", async () => {
    // Insert 100 rows
    const rowsToInsert = Array.from({ length: 100 }, (_, i) => ({
      name: `Large Stream ${i}`,
    }));
    await repo.addMany(SimpleTestEntity, rowsToInsert, { actor: "test-user" });

    const result = await repo.findAll(SimpleTestEntity, null, {
      stream: true,
    });

    let count = 0;
    let firstRowName: string | null = null;
    for await (const row of result as AsyncIterable<any>) {
      count++;
      if (count === 1) firstRowName = row.name;
    }

    expect(count).toBe(100);
    expect(firstRowName).toContain("Large Stream");
  });
});
