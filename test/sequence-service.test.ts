import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { getDal, resetDal } from "../src/dal/dal.js";
import { SequencesService } from "../src/builtin/sequence-decl.js";
import { sequenceBoundUuid } from "../src/meta/entity-decorators.js";
import { SequenceNotFoundError } from "../src/errors/errors.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

/**
 * SequencesService — the governed builtin surface: `setCounter` (the
 * `sequence.set` RPC primitive) upserts the counter row through the
 * governed entity-service door; `forecast` + list/get counter
 * projections are READ-ONLY (never create or bump a counter). Actor
 * attribution lands in audit cols, never in last_alloc_* (a SET is not
 * a claim). uuid is the ONLY identity on every surface — `name` is
 * display data.
 */

const ACTOR = "seq-svc-actor";

async function seedSequence(name: string, pattern = "TST-{seq:5}", start = 1n): Promise<string> {
  const uuid = sequenceBoundUuid(name);
  await getTestPool().query(
    `INSERT INTO sequences (uuid, name, pattern, step, start)
     VALUES ($1, $2, $3, 1, $4)`,
    [uuid, name, pattern, start],
  );
  return uuid;
}

async function counters(): Promise<Array<Record<string, unknown>>> {
  const r = await getTestPool().query(`SELECT * FROM sequence_counters ORDER BY period_key, partition_key`);
  return r.rows as Array<Record<string, unknown>>;
}

describe("SequencesService — governed setCounter + read-only forecast", () => {
  let svc: SequencesService;

  beforeAll(async () => {
    await setupTestSchema();
    getDal({
      connectionString: process.env.DATABASE_URL!,
      schemas: ["public"],
      max: 2,
      applicationName: "dal-test-seqs-service",
    });
    process.env.DATABASE_SCHEMA = "public";
    svc = new SequencesService(() => ACTOR);
  });

  afterAll(async () => {
    await resetDal();
    await closeTestPool();
  });

  beforeEach(async () => {
    await truncateTestTables();
  });

  it("setCounter on an unclaimed sequence → creates the counter row at `next`", async () => {
    const uuid = await seedSequence("svc.seq");
    const res = await svc.setCounter({ uuid, next: 42n });
    expect(res.counter).toBe(42n);
    const [c] = await counters();
    expect(c!.sequence_uuid).toBe(uuid);
    expect(c!.counter).toBe(42n);
    expect(c!.updated_by).toBe(ACTOR);
    expect(c!.last_alloc_by).toBeNull(); // SET is not a claim
  });

  it("setCounter on an existing counter → updates next via the governed door (version bumps)", async () => {
    const uuid = await seedSequence("svc.seq");
    await svc.setCounter({ uuid, next: 42n });
    const again = await svc.setCounter({ uuid, next: 7n });
    expect(again.counter).toBe(7n);
    const cs = await counters();
    expect(cs).toHaveLength(1);
    expect(cs[0]!.version).toBe(2);
  });

  it("setCounter with sez ctx → targets that partition only", async () => {
    const uuid = await seedSequence("svc.part", "P-{sez}-{seq:3}");
    const a = await svc.setCounter({ uuid, next: 10n, sez: "A" });
    expect(a.partition_key).toBe("A\x1f\x1f");
    const b = await svc.setCounter({ uuid, next: 20n, sez: "B" });
    const cs = await counters();
    expect(cs).toHaveLength(2);
    expect(cs.map((c) => c.counter)).toEqual([10n, 20n]);
    expect(b.partition_key).toBe("B\x1f\x1f");
  });

  it("setCounter on a missing uuid → NotFound", async () => {
    await expect(svc.setCounter({ uuid: crypto.randomUUID(), next: 1n })).rejects.toThrow();
    expect(await counters()).toHaveLength(0);
  });

  it("forecast renders the would-be next — and writes NOTHING", async () => {
    const uuid = await seedSequence("svc.seq");
    const f1 = await svc.forecast({ uuid });
    expect(f1.next).toBe("TST-00001");
    expect(f1.name).toBe("svc.seq");
    expect(f1.counter).toBeNull();
    expect(await counters()).toHaveLength(0); // forecast never provisions
    await svc.setCounter({ uuid, next: 42n });
    const f2 = await svc.forecast({ uuid });
    expect(f2.next).toBe("TST-00042");
    expect(f2.counter).toBe(42n);
    expect((await counters())[0]!.counter).toBe(42n); // unchanged
  });

  it("forecast honors sez context per partition", async () => {
    const uuid = await seedSequence("svc.part", "P-{sez}-{seq:3}");
    await svc.setCounter({ uuid, next: 10n, sez: "A" });
    const fa = await svc.forecast({ uuid, sez: "A" });
    const fb = await svc.forecast({ uuid, sez: "B" });
    expect(fa.next).toBe("P-A-010");
    expect(fb.next).toBe("P-B-001"); // unclaimed partition → start
    expect(await counters()).toHaveLength(1); // read-only
  });

  it("forecast missing identity → NotFound carrying it", async () => {
    await expect(svc.forecast({ uuid: crypto.randomUUID() })).rejects.toThrow();
  });

  it("list/get attach counter projections — emitted_next null for partitioned patterns", async () => {
    const uuid = await seedSequence("svc.seq");
    await svc.setCounter({ uuid, next: 42n });
    await seedSequence("svc.part", "P-{sez}-{seq:3}");
    const res = await svc.list({ page: 1, page_size: 10 } as never);
    const rows = res.rows as unknown as Array<Record<string, unknown>>;
    const flat = rows.find((r) => r.name === "svc.seq")!;
    const part = rows.find((r) => r.name === "svc.part")!;
    expect(flat.value_next).toBe(42n);
    expect(flat.emitted_next).toBe("TST-00042");
    expect(part.emitted_next).toBeNull();
    const g = (await svc.get(uuid)) as unknown as Record<string, unknown>;
    expect(g.emitted_next).toBe("TST-00042");
    expect(await counters()).toHaveLength(1); // still read-only
  });
});

describe("SequencesService — analyze (governed read-only pre-check)", () => {
  let svc: SequencesService;

  beforeAll(async () => {
    await setupTestSchema();
    getDal({
      connectionString: process.env.DATABASE_URL!,
      schemas: ["public"],
      max: 2,
      applicationName: "dal-test-seqs-analyze",
    });
    process.env.DATABASE_SCHEMA = "public";
    svc = new SequencesService(() => ACTOR);
  });

  afterAll(async () => {
    await resetDal();
    await closeTestPool();
  });

  beforeEach(async () => {
    await truncateTestTables();
  });

  it("scans a physical column in the module schema — reports usage/collisions/ambiguity, writes nothing", async () => {
    // scan target: the `sequences.name` column itself (text, same schema)
    const uuid = await seedSequence("TST-001", "TST-{seq:3}");
    await seedSequence("TST-002", "TST-{seq:3}");
    await seedSequence("svc.wide", "TST-{seq:2}"); // \d{2,} also matches TST-001 → ambiguous
    const a = await svc.analyze({ uuid, table: "sequences", column: "name" });
    expect(a.table).toBe("sequences");
    expect(a.in_use).toBe(2n);
    expect(a.max_value).toBe(2n);
    expect(a.suggested_start).toBe(3n);
    expect(a.next_proposed).toBe("TST-001");
    expect(a.next_in_use).toBe(true);
    expect(a.ambiguous).toContain("svc.wide");
    expect(await counters()).toHaveLength(0); // read-only
  });

  it("derives target from the <table>.<field> bound name when table/column omitted", async () => {
    const uuid = await seedSequence("sequences.name", "TST-{seq:3}");
    await seedSequence("TST-001", "Q-{seq:4}");
    const a = await svc.analyze({ uuid });
    expect(a.table).toBe("sequences");
    expect(a.column).toBe("name");
    expect(a.in_use).toBe(1n);
  });
});
