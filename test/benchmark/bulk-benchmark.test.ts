import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { Repository } from "../../src/index.js";
import { BenchSimpleEntity } from "../entities/bench-simple.entity.js";
import { BenchPrimitivesEntity } from "../entities/bench-primitives.entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "../helpers/setup.js";

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generate N simple benchmark records. */
function genSimple(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    uuid: randomUUID(),
    code: `BENCH_S_${i}`,
    name: `Benchmark Simple Row ${i}`,
    status: i % 2 === 0 ? "active" : "inactive",
  }));
}

/** Generate N primitives benchmark records (all PG types). */
function genPrimitives(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    uuid: randomUUID(),
    int2_val: i % 32767,
    int4_val: i,
    int8_val: BigInt(i) * 1000000n,
    float4_val: i * 1.5,
    float8_val: i * 3.141592653589793,
    numeric_safe: i * 123.45,
    boolean_val: i % 2 === 0,
    char_val: "X",
    varchar_val: `varchar_${i}`,
    text_val: `Long text content for row ${i} with some padding to make it realistic...`,
    uuid_val: randomUUID(),
    date_val: new Date(2024, 0, (i % 28) + 1),
    timestamp_val: new Date(Date.now() + i * 1000),
    timestamptz_val: new Date(),
    jsonb_val: { index: i, nested: { value: i * 2, tags: ["a", "b"] } },
    text_arr: [`tag_${i}`, `tag_${i + 1}`],
    int4_arr: [i, i + 1, i + 2],
    inet_val: `192.168.${i % 256}.${(i * 7) % 256}`,
  }));
}

/** Run a benchmark and collect metrics. */
async function benchmark<T>(
  label: string,
  count: number,
  fn: () => Promise<T[]>
): Promise<void> {
  const start = performance.now();
  const result = await fn();
  const end = performance.now();
  const totalMs = end - start;
  const rps = Math.round(count / (totalMs / 1000));

  console.log(`\n  [BENCH] ${label}`);
  console.log(`    records:    ${count.toLocaleString()}`);
  console.log(`    total:      ${totalMs.toFixed(2)} ms`);
  console.log(`    throughput: ${rps.toLocaleString()} rec/s`);
  console.log(`    returned:   ${result.length.toLocaleString()} rows`);

  expect(result).toHaveLength(count);
}

/** Cleanup: hard-delete all rows by uuid. */
async function cleanup(entity: any, rows: { uuid: string }[]): Promise<void> {
  for (const r of rows) {
    try {
      await repo.hardDelete(entity, { uuid: r.uuid }, { actor: "bench", matchBy: "uuid" });
    } catch {
      // ignore — already deleted
    }
  }
}

// ─── Benchmark scales ─────────────────────────────────────────────────────────
// 1M is opt-in via BENCH_1M=1 env var (avoids long test runs by default)
const counts = process.env.BENCH_1M
  ? [100, 1000, 10000, 1000000]
  : [100, 1000, 10000];

// ─── Benchmarks: updateMany — simple table ────────────────────────────────────

describe("updateMany benchmark — simple table", () => {
  for (const count of counts) {
    it(`updateMany ${count.toLocaleString()} rows — simple table`, async () => {
      await truncateTestTables();

      const rows = genSimple(count);
      await repo.addMany(BenchSimpleEntity, rows, { actor: "bench" });

      const updates = rows.map((r) => ({
        uuid: r.uuid,
        name: `Updated ${r.name}`,
        status: r.status === "active" ? "inactive" : "active",
      }));

      await benchmark(`updateMany simple`, count, () =>
        repo.updateMany(BenchSimpleEntity, updates, { actor: "bench", matchBy: "uuid" })
      );

      await cleanup(BenchSimpleEntity, rows);
    });
  }
});

// ─── Benchmarks: upsertMany — simple table ────────────────────────────────────

describe("upsertMany benchmark — simple table", () => {
  for (const count of counts) {
    it(`upsertMany ${count.toLocaleString()} rows — simple table (all inserts)`, async () => {
      await truncateTestTables();

      const rows = genSimple(count);
      await benchmark(`upsertMany simple (inserts)`, count, () =>
        repo.upsertMany(BenchSimpleEntity, rows, { actor: "bench" })
      );

      await cleanup(BenchSimpleEntity, rows);
    });

    it(`upsertMany ${count.toLocaleString()} rows — simple table (all updates)`, async () => {
      await truncateTestTables();

      const rows = genSimple(count);
      await repo.addMany(BenchSimpleEntity, rows, { actor: "bench" });

      const updates = rows.map((r) => ({
        ...r,
        name: `Upserted ${r.name}`,
      }));

      await benchmark(`upsertMany simple (updates)`, count, () =>
        repo.upsertMany(BenchSimpleEntity, updates, { actor: "bench" })
      );

      await cleanup(BenchSimpleEntity, rows);
    });
  }
});

// ─── Benchmarks: updateMany — primitives table ────────────────────────────────

describe("updateMany benchmark — primitives table", () => {
  for (const count of counts) {
    it(`updateMany ${count.toLocaleString()} rows — primitives table`, async () => {
      await truncateTestTables();

      const rows = genPrimitives(count);
      await repo.addMany(BenchPrimitivesEntity, rows as any, { actor: "bench" });

      const updates = rows.map((r) => ({
        uuid: r.uuid,
        varchar_val: `updated_${r.varchar_val}`,
        text_val: `Updated text for ${r.uuid}`,
        jsonb_val: { ...r.jsonb_val, updated: true },
      }));

      await benchmark(`updateMany primitives`, count, () =>
        repo.updateMany(BenchPrimitivesEntity, updates, { actor: "bench", matchBy: "uuid" })
      );

      await cleanup(BenchPrimitivesEntity, rows);
    });
  }
});

// ─── Benchmarks: upsertMany — primitives table ────────────────────────────────

describe("upsertMany benchmark — primitives table", () => {
  for (const count of counts) {
    it(`upsertMany ${count.toLocaleString()} rows — primitives table (mixed insert+update)`, async () => {
      await truncateTestTables();

      const half = Math.floor(count / 2);
      const existingRows = genPrimitives(half);
      await repo.addMany(BenchPrimitivesEntity, existingRows as any, { actor: "bench" });

      const allRows = [
        ...existingRows.map((r) => ({ ...r, text_val: `Mixed upsert ${r.uuid}` })),
        ...genPrimitives(count - half),
      ];

      await benchmark(`upsertMany primitives (mixed)`, count, () =>
        repo.upsertMany(BenchPrimitivesEntity, allRows as any, { actor: "bench" })
      );

      await cleanup(BenchPrimitivesEntity, allRows);
    });
  }
});
