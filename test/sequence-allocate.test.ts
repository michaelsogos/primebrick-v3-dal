import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { Repository } from "../src/index.js";
import { REPO_INTERNAL } from "../src/repository/repository.js";
import { SequenceCounterEntity } from "../src/entities/sequence-counter-entity.js";
import { SequenceEntity } from "../src/entities/sequence-entity.js";
import { getTestPool, closeTestPool } from "./helpers/setup.js";

/**
 * sequenceAllocate — the counter claim primitive. Empirical contract:
 *
 *   - first claim of a (period, partition) INSERTs the counter at
 *     start + count·step and RETURNS the emitted range [start, start+(n-1)step];
 *   - next claims UPDATE atomically — disjoint ranges, no doubles;
 *   - concurrent claims SERIALIZE on the row lock (Promise.all proof);
 *   - (period, partition) identity isolates counters;
 *   - the row's `counter` stays next-to-emit; last_alloc_* carry
 *     who/when/how many (attribution, no trail).
 *
 * The table is created in the test DB's public schema — the entity's
 * schema resolves via the `public` fallback (no domain configured).
 */

const SEQ_A = "00000000-0000-7000-8000-0000000000a1";
const SEQ_B = "00000000-0000-7000-8000-0000000000b2";

describe("Repository.sequenceAllocate — atomic counter claim", () => {
  let pool: Pool;
  let repo: Repository;

  beforeAll(async () => {
    pool = getTestPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sequence_counters (
        uuid             uuid NOT NULL DEFAULT uuidv7() PRIMARY KEY,
        sequence_id      uuid NOT NULL,
        period_key       varchar(64)  NOT NULL DEFAULT '',
        partition_key    varchar(255) NOT NULL DEFAULT '',
        counter          bigint NOT NULL,
        last_alloc_at    timestamptz,
        last_alloc_by    varchar(100),
        last_alloc_count bigint,
        created_at       timestamptz NOT NULL DEFAULT now(),
        created_by       varchar(100) NOT NULL DEFAULT 'test',
        updated_at       timestamptz NOT NULL DEFAULT now(),
        updated_by       varchar(100) NOT NULL DEFAULT 'test',
        version          int NOT NULL DEFAULT 1,
        UNIQUE (sequence_id, period_key, partition_key)
      )
    `);
    repo = new Repository(pool, REPO_INTERNAL);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE sequence_counters`);
  });

  it("first claim INSERTs the counter — emits [start, start+(n-1)·step]", async () => {
    const r = await repo.sequenceAllocate({
      sequence_id: SEQ_A,
      period_key: "",
      partition_key: "\x1f\x1f",
      count: 3,
      step: 5n,
      start: 10n,
      actor: "e2e",
    });
    expect(r).toEqual({ first: 10n, last: 20n }); // 10,15,20 emitted

    const row = await pool.query(
      `SELECT counter, last_alloc_by, last_alloc_count FROM sequence_counters WHERE sequence_id=$1`,
      [SEQ_A],
    );
    expect(row.rows[0].counter).toBe(25n); // next-to-emit
    expect(row.rows[0].last_alloc_by).toBe("e2e");
    expect(row.rows[0].last_alloc_count).toBe(3n);
  });

  it("next claim continues — disjoint range, no doubles", async () => {
    const spec = { sequence_id: SEQ_A, period_key: "", partition_key: "\x1f\x1f", count: 2, step: 1n, start: 1n, actor: "t" };
    const a = await repo.sequenceAllocate(spec);
    const b = await repo.sequenceAllocate(spec);
    expect(a).toEqual({ first: 1n, last: 2n });
    expect(b).toEqual({ first: 3n, last: 4n });
  });

  it("concurrent claims serialize — 5×10 disjoint codes, counter lands at start+50·step", async () => {
    const spec = { sequence_id: SEQ_A, period_key: "", partition_key: "\x1f\x1f", count: 10, step: 1n, start: 100n, actor: "t" };
    const ranges = await Promise.all([...Array(5)].map(() => repo.sequenceAllocate(spec)));
    const emitted = ranges.flatMap((r) => {
      const codes: bigint[] = [];
      for (let c = r.first; c <= r.last; c++) codes.push(c);
      return codes;
    });
    expect(new Set(emitted).size).toBe(50); // zero doubles under concurrency
    const row = await pool.query(`SELECT counter FROM sequence_counters WHERE sequence_id=$1`, [SEQ_A]);
    expect(row.rows[0].counter).toBe(150n);
  });

  it("period + partition identity isolate counters", async () => {
    const base = { sequence_id: SEQ_A, count: 1, step: 1n, start: 1n, actor: "t" };
    const a = await repo.sequenceAllocate({ ...base, period_key: "2026", partition_key: "\x1f\x1f" });
    const b = await repo.sequenceAllocate({ ...base, period_key: "2027", partition_key: "\x1f\x1f" });
    const c = await repo.sequenceAllocate({ ...base, period_key: "2026", partition_key: "IT\x1f\x1f" });
    expect(a.first).toBe(1n);
    expect(b.first).toBe(1n); // new period restarts at start
    expect(c.first).toBe(1n); // new partition restarts at start
    const rows = await pool.query(`SELECT COUNT(*)::int AS n FROM sequence_counters WHERE sequence_id=$1`, [SEQ_A]);
    expect(rows.rows[0].n).toBe(3);
  });

  it("different sequences never share a counter", async () => {
    const spec = { period_key: "", partition_key: "\x1f\x1f", count: 1, step: 1n, start: 1n, actor: "t" };
    expect((await repo.sequenceAllocate({ ...spec, sequence_id: SEQ_A })).first).toBe(1n);
    expect((await repo.sequenceAllocate({ ...spec, sequence_id: SEQ_B })).first).toBe(1n);
  });

  it("negative step counts down", async () => {
    const r = await repo.sequenceAllocate({
      sequence_id: SEQ_A, period_key: "", partition_key: "\x1f\x1f",
      count: 3, step: -2n, start: 10n, actor: "t",
    });
    expect(r).toEqual({ first: 10n, last: 6n }); // 10,8,6 — next emit 4
  });

  it.each([
    [{ count: 0 }, /positive integer/, "count=0"],
    [{ count: -2 }, /positive integer/, "count=-2"],
    [{ count: 1.5 }, /positive integer/, "count=1.5"],
    [{ step: 0n }, /non-zero/, "step=0"],
  ])("fail-closed validation %s", async (bad, re) => {
    await expect(
      repo.sequenceAllocate({
        sequence_id: SEQ_A, period_key: "", partition_key: "\x1f\x1f",
        count: 1, step: 1n, start: 1n, actor: "t", ...bad,
      }),
    ).rejects.toThrow(re);
  });

  it("sealed — subclassing the entity classes throws at construction", () => {
    class MySeq extends SequenceEntity {}
    class MyCounter extends SequenceCounterEntity {}
    expect(() => new MySeq()).toThrowError(/sealed/);
    expect(() => new MyCounter()).toThrowError(/sealed/);
  });
});
