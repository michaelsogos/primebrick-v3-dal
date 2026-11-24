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

async function seedRevivingSvc(opts: {
  pattern?: string; sez?: string;
  every?: string | null; grace?: string | null; slot?: string | null;
  expire?: string | null; sw?: string | null; from?: string;
} = {}): Promise<string> {
  const r = await getTestPool().query(
    `INSERT INTO sequences
       (uuid, name, pattern, step, start, tz, sez, revive_every, revive_grace, revive_slot,
        expire_at, switch_at, default_from)
     VALUES (uuidv7(), 'svc.revive', $1, 1, 1, 'UTC', $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz)
     RETURNING uuid`,
    [
      opts.pattern ?? "TST-{seq:5}/{sez}",
      opts.sez ?? "26",
      opts.every === undefined ? "1 year" : opts.every,
      opts.grace === undefined ? null : opts.grace,
      opts.slot === undefined ? "sez" : opts.slot,
      opts.expire === undefined ? "2999-01-01T00:00:00Z" : opts.expire,
      opts.sw === undefined ? "2999-01-11T00:00:00Z" : opts.sw,
      opts.from ?? "2026-01-01T00:00:00Z",
    ],
  );
  return r.rows[0]!.uuid as string;
}

describe("SequencesService.update — revive axes editable while in tempo", () => {
  let svc: SequencesService;

  beforeAll(async () => {
    await setupTestSchema();
    getDal({
      connectionString: process.env.DATABASE_URL!,
      schemas: ["public"],
      max: 2,
      applicationName: "dal-test-seqs-axes",
    });
    svc = new SequencesService(() => ACTOR);
  });

  afterAll(async () => {
    await resetDal();
    await closeTestPool();
  });

  beforeEach(async () => {
    await truncateTestTables();
  });

  const read = async (uuid: string) =>
    (await getTestPool().query(`SELECT * FROM sequences WHERE uuid = $1`, [uuid])).rows[0] as Record<string, unknown>;

  it("interval edit → expire_at recomputes to the next boundary from now", async () => {
    const uuid = await seedRevivingSvc();
    await svc.update(uuid, { revive_every: "2 years", version: 1 });
    const row = await read(uuid);
    const exp = new Date(row.expire_at as string);
    expect(exp.getTime()).toBeGreaterThan(Date.now());
    expect(exp.getUTCDate()).toBe(1); // calendar boundary, not rolling
    expect(exp.getUTCMonth()).toBe(0);
    expect(row.revive_every).toBe("2 years");
  });

  it("'at' pin → expire_at is the literal verbatim", async () => {
    const uuid = await seedRevivingSvc({ pattern: "TST-{seq:5}/{yyyy}/{sez}" });
    await svc.update(uuid, { revive_every: "at 2027-06-16T00:00:00Z", version: 1 });
    const row = await read(uuid);
    expect((row.expire_at as Date).toISOString()).toBe("2027-06-16T00:00:00.000Z");
    expect(row.revive_every).toBe("at 2027-06-16T00:00:00Z");
  });

  it("revive off — every→NULL clears expire/switch/slot (permanent generation)", async () => {
    const uuid = await seedRevivingSvc();
    await svc.update(uuid, { revive_every: null, version: 1 });
    const row = await read(uuid);
    expect(row.revive_every).toBeNull();
    expect(row.revive_slot).toBeNull();
    expect(row.expire_at).toBeNull();
    expect(row.switch_at).toBeNull();
  });

  it("closed — expire already passed refuses the expire-axis edit", async () => {
    const uuid = await seedRevivingSvc({ expire: "2020-01-01T00:00:00Z", sw: "2999-01-11T00:00:00Z" });
    await expect(svc.update(uuid, { revive_every: "2 years", version: 1 })).rejects.toThrow(/closed|tempo/i);
  });

  it("closed — a successor already exists refuses the expire-axis edit", async () => {
    const uuid = await seedRevivingSvc();
    // materialize a successor row pointing at uuid
    await getTestPool().query(
      `INSERT INTO sequences (uuid, name, pattern, step, start, revived_from)
       VALUES (uuidv7(), 'svc.revive#27', 'TST-{seq:5}/{sez}', 1, 1, $1)`,
      [uuid],
    );
    await expect(svc.update(uuid, { revive_every: "2 years", version: 1 })).rejects.toThrow(/closed|tempo/i);
  });

  it("grace edit during the grace window — successor exists, switch still future → allowed", async () => {
    const uuid = await seedRevivingSvc({ grace: "10 days", expire: "2020-01-01T00:00:00Z", sw: "2999-01-11T00:00:00Z" });
    await getTestPool().query(
      `INSERT INTO sequences (uuid, name, pattern, step, start, revived_from)
       VALUES (uuidv7(), 'svc.revive#27', 'TST-{seq:5}/{sez}', 1, 1, $1)`,
      [uuid],
    );
    await svc.update(uuid, { revive_grace: "30 days", version: 1 });
    const row = await read(uuid);
    expect(row.revive_grace).toBe("30 days");
    expect((row.switch_at as Date).toISOString()).toBe("2020-01-31T00:00:00.000Z"); // expire+30d
  });

  it("'until' pin → switch_at literal; pin before expire is a contract error", async () => {
    const uuid = await seedRevivingSvc({ grace: "10 days" });
    await svc.update(uuid, { revive_grace: "until 2999-02-01T00:00:00Z", version: 1 });
    expect(((await read(uuid)).switch_at as Date).toISOString()).toBe("2999-02-01T00:00:00.000Z");
    await expect(svc.update(uuid, { revive_grace: "until 2000-01-01T00:00:00Z", version: 2 })).rejects.toThrow(/precede|before/i);
  });

  it("past 'at' pin dies on arrival — contract error before the guarded write", async () => {
    const uuid = await seedRevivingSvc({ pattern: "TST-{seq:5}/{yyyy}/{sez}" });
    await expect(svc.update(uuid, { revive_every: "at 2020-01-01T00:00:00Z", version: 1 })).rejects.toThrow(/not in the future|arrival/i);
  });
});
