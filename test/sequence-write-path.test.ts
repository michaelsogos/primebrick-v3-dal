import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg, { Pool } from "pg";

import { Dal } from "../src/dal/dal.js";
import { Repository, REPO_INTERNAL } from "../src/repository/repository.js";
import { sequenceBoundUuid } from "../src/meta/entity-decorators.js";
import { SequenceNotFoundError, ValidationError } from "../src/errors/errors.js";
import { SeqTestEntity } from "./entities/seq-test-entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

/**
 * Seq-bound write-path resolution — the repository resolves sequence
 * directives (and create-time omissions) to rendered literals inside ONE
 * transaction with the entity write. Covers: lazy mini-tx, default
 * allocation, uuid/expr directives, strict literal rejection,
 * SEQUENCE_NOT_FOUND identity, bulk `count:N` claims + uniformity,
 * clone allocation, rollback atomicity, actor attribution, rendered
 * length guard, and the deferred-transaction forbid.
 *
 * uuid is the ONLY sequence identity — `name` is display data and never
 * reaches a lookup. Bound rows carry the deterministic
 * `sequenceBoundUuid(<table>.<field>)` — the same derivation the
 * self-provisioning path uses.
 */

const SEQ_NAME = "dal_test_seq.code"; // bound NAME: <table>.<field>
const SEQ_UUID = sequenceBoundUuid(SEQ_NAME); // deterministic bound identity
const ACTOR = "seq-actor";

async function seedSequence(name: string, pattern = "TST-{seq:5}", step = 1n, start = 1n): Promise<string> {
  // Seeded rows carry the same deterministic-uuid scheme provisioning
  // uses — a bound-name seed IS the row materialization would create.
  const uuid = sequenceBoundUuid(name);
  await getTestPool().query(
    `INSERT INTO sequences (uuid, name, pattern, step, start)
     VALUES ($1, $2, $3, $4, $5)`,
    [uuid, name, pattern, step, start],
  );
  return uuid;
}

async function counterRow(): Promise<Record<string, unknown> | undefined> {
  const r = await getTestPool().query(`SELECT * FROM sequence_counters`);
  return r.rows[0] as Record<string, unknown> | undefined;
}

async function seqRows(): Promise<Array<Record<string, unknown>>> {
  const r = await getTestPool().query(`SELECT * FROM sequences ORDER BY name`);
  return r.rows as Array<Record<string, unknown>>;
}

describe("Repository — seq-bound write resolution", () => {
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
    await seedSequence(SEQ_NAME);
  });

  it("empty registry: omission self-provisions the declared default row", async () => {
    await getTestPool().query(`DELETE FROM sequences`); // wipe the beforeEach seed
    const row = await repo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR });
    expect(row.code).toBe("TST-00001");
    const rows = await seqRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.uuid).toBe(SEQ_UUID); // deterministic bound identity
    expect(rows[0]!.name).toBe(SEQ_NAME);
    expect(rows[0]!.pattern).toBe("TST-{seq:5}");
    // an operator-edited row stays authoritative — ON CONFLICT never overwrites
    await getTestPool().query(`UPDATE sequences SET pattern = 'OP-{seq:3}', start = 50, step = 1 WHERE uuid = $1`, [SEQ_UUID]);
    await getTestPool().query(`DELETE FROM sequence_counters`);
    const b = await repo.add(SeqTestEntity, { label: "b" }, { actor: ACTOR });
    expect(b.code).toBe("OP-050");
  });

  it("add omitted → allocates the field default sequence inside the lazy mini-tx", async () => {
    const row = await repo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR });
    expect(row.code).toBe("TST-00001");
    const counter = await counterRow();
    expect(counter).toBeDefined();
    expect(counter!.counter).toBe(2n); // next-to-emit
    expect(counter!.last_alloc_by).toBe(ACTOR);
  });

  it("add {seq:{uuid}} of the bound row → same counter continues", async () => {
    await repo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR });
    const row = await repo.add(
      SeqTestEntity,
      { code: { seq: { uuid: SEQ_UUID } }, label: "b" },
      { actor: ACTOR },
    );
    expect(row.code).toBe("TST-00002");
  });

  it("add {seq:uuid} → resolves by uuid identity", async () => {
    const row = await repo.add(SeqTestEntity, { code: { seq: SEQ_UUID }, label: "u" }, { actor: ACTOR });
    expect(row.code).toBe("TST-00001");
  });

  it("literal reaching the repository is STRICT-rejected (API bypass-proof)", async () => {
    await expect(
      repo.add(SeqTestEntity, { code: "RAW-001", label: "x" }, { actor: ACTOR }),
    ).rejects.toThrow(ValidationError);
    // and nothing was claimed
    expect(await counterRow()).toBeUndefined();
  });

  it("missing sequence uuid → SEQUENCE_NOT_FOUND carrying the identity", async () => {
    const bogus = "11111111-2222-4333-8444-555555555555";
    const err = await repo
      .add(SeqTestEntity, { code: { seq: { uuid: bogus } }, label: "x" }, { actor: ACTOR })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SequenceNotFoundError);
    expect((err as SequenceNotFoundError).identity).toBe(bogus);
    expect((err as SequenceNotFoundError).code).toBe("SEQUENCE_NOT_FOUND");
  });

  it("expr directive materializes a field-scoped sequence row idempotently", async () => {
    const dir = { seq: { pattern: "EXP-{seq:4}", step: 1n, start: 7n } };
    const a = await repo.add(SeqTestEntity, { code: dir, label: "a" }, { actor: ACTOR });
    const b = await repo.add(SeqTestEntity, { code: dir, label: "b" }, { actor: ACTOR });
    expect(a.code).toBe("EXP-0007");
    expect(b.code).toBe("EXP-0008"); // SAME counter — materialized once
    const rows = await seqRows();
    const expr = rows.filter((r) => (r.name as string).startsWith(`${SEQ_NAME}@expr_`));
    expect(expr).toHaveLength(1);
    expect(expr[0]!.pattern).toBe("EXP-{seq:4}");
  });

  it("update directive → allocates; omitted column stays untouched", async () => {
    const row = await repo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR });
    const relabeled = await repo.update(
      SeqTestEntity,
      { uuid: row.uuid, version: row.version, label: "b" },
      { actor: ACTOR, matchBy: "uuid" },
    );
    expect(relabeled.code).toBe("TST-00001"); // untouched — no allocation
    const rotated = await repo.update(
      SeqTestEntity,
      { uuid: row.uuid, version: relabeled.version, code: { seq: { uuid: SEQ_UUID } } },
      { actor: ACTOR, matchBy: "uuid" },
    );
    expect(rotated.code).toBe("TST-00002");
  });

  it("clone allocates a fresh sequence value (never copies the unique code)", async () => {
    const src = await repo.add(SeqTestEntity, { label: "src" }, { actor: ACTOR });
    const cloned = await repo.clone(SeqTestEntity, src.uuid, { actor: ACTOR });
    expect(cloned.code).toBe("TST-00002");
    expect(cloned.code).not.toBe(src.code);
    expect(cloned.cloned_from).toBe(src.uuid);
  });

  it("addMany omits → ONE contiguous claim (count:N) distributes literals", async () => {
    const res = await repo.addMany(
      SeqTestEntity,
      [{ label: "a" }, { label: "b" }, { label: "c" }],
      { actor: ACTOR },
    );
    expect(res.affected).toBe(3);
    const rows = await getTestPool().query(`SELECT code FROM dal_test_seq ORDER BY code`);
    expect(rows.rows.map((r: { code: string }) => r.code)).toEqual([
      "TST-00001",
      "TST-00002",
      "TST-00003",
    ]);
    const counter = await counterRow();
    expect(counter!.counter).toBe(4n);
    expect(counter!.last_alloc_count).toBe(3n); // ONE claim of 3
  });

  it("addMany mixed directives → rejected", async () => {
    await expect(
      repo.addMany(
        SeqTestEntity,
        [{ label: "a" }, { code: { seq: { uuid: SEQ_UUID } }, label: "b" }],
        { actor: ACTOR },
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("updateMany same directive → contiguous values; mixed → rejected", async () => {
    const a = await repo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR });
    const b = await repo.add(SeqTestEntity, { label: "b" }, { actor: ACTOR });
    const res = await repo.updateMany(
      SeqTestEntity,
      [
        { uuid: a.uuid, version: a.version, code: { seq: { uuid: SEQ_UUID } } },
        { uuid: b.uuid, version: b.version, code: { seq: { uuid: SEQ_UUID } } },
      ],
      { actor: ACTOR, matchBy: "uuid" },
    );
    expect(res.affected).toBe(2);
    const rows = await getTestPool().query(`SELECT code FROM dal_test_seq ORDER BY code`);
    expect(rows.rows.map((r: { code: string }) => r.code)).toEqual(["TST-00003", "TST-00004"]);

    const c = await repo.add(SeqTestEntity, { label: "c" }, { actor: ACTOR });
    await expect(
      repo.updateMany(
        SeqTestEntity,
        [
          { uuid: a.uuid, version: 2, code: { seq: { uuid: SEQ_UUID } } },
          { uuid: c.uuid, version: c.version, label: "x" },
        ],
        { actor: ACTOR, matchBy: "uuid" },
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("claim + entity write are ONE tx — INSERT failure rolls the counter back", async () => {
    const client = await pool.connect();
    const txRepo = new Repository(client, REPO_INTERNAL);
    await client.query("BEGIN");
    const a = await txRepo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR }); // joins caller tx
    try {
      await txRepo.add(SeqTestEntity, { uuid: a.uuid, label: "b" }, { actor: ACTOR });
      expect.unreachable("duplicate uuid must fail");
    } catch {
      // conflict — rolls back below
    }
    await client.query("ROLLBACK");
    client.release();
    // no entity rows AND no counter row — the claim rolled back too
    expect((await getTestPool().query(`SELECT count(*)::int n FROM dal_test_seq`)).rows[0].n).toBe(0);
    expect(await counterRow()).toBeUndefined();
  });

  it("rendered length > column length → ValidationError (D4-B defense in depth)", async () => {
    const long = "X".repeat(40);
    await expect(
      repo.add(
        SeqTestEntity,
        { code: { seq: { pattern: `${long}-{seq:3}`, step: 1n, start: 1n } }, label: "x" },
        { actor: ACTOR },
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("dal.beginTransaction rejects seq-bound writes at buffer time", async () => {
    const dal = new Dal({
      connectionString: process.env.DATABASE_URL!,
      schemas: ["public"],
      max: 2,
      applicationName: "dal-test-seq-deferred",
    });
    try {
      const tx = dal.beginTransaction();
      expect(() => tx.add(SeqTestEntity, { label: "x" }, { actor: ACTOR })).toThrow(ValidationError);
      const src = await repo.add(SeqTestEntity, { label: "s" }, { actor: ACTOR });
      const tx2 = dal.beginTransaction();
      expect(() =>
        tx2.update(SeqTestEntity, { uuid: src.uuid, version: src.version, code: { seq: { uuid: SEQ_UUID } } }, { actor: ACTOR }),
      ).toThrow(ValidationError);
    } finally {
      await dal.close();
    }
  });
});

describe("Repository — sequenceSet governed primitive", () => {
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
    await seedSequence(SEQ_NAME);
  });

  it("set on an unclaimed period → creates the counter at `next`; allocation continues from it", async () => {
    const res = await repo.sequenceSet({ seq: { uuid: SEQ_UUID }, next: 42n, actor: ACTOR });
    expect(res.counter).toBe(42n);
    const row = await repo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR });
    expect(row.code).toBe("TST-00042");
    const counter = await counterRow();
    expect(counter!.counter).toBe(43n);
    expect(counter!.last_alloc_by).toBe(ACTOR);
  });

  it("set on an existing counter → next wins (operator re-seed, both directions)", async () => {
    await repo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR }); // counter → 2
    await repo.sequenceSet({ seq: { uuid: SEQ_UUID }, next: 100n, actor: ACTOR });
    expect((await counterRow())!.counter).toBe(100n);
    await repo.sequenceSet({ seq: { uuid: SEQ_UUID }, next: 7n, actor: ACTOR });
    expect((await counterRow())!.counter).toBe(7n); // backward allowed — governed op
    const row = await repo.add(SeqTestEntity, { label: "b" }, { actor: ACTOR });
    expect(row.code).toBe("TST-00007");
  });

  it("set never emits a value — the row stays unwritten until a real claim", async () => {
    await repo.sequenceSet({ seq: { uuid: SEQ_UUID }, next: 9n, actor: ACTOR });
    expect((await getTestPool().query(`SELECT count(*)::int n FROM dal_test_seq`)).rows[0].n).toBe(0);
    expect((await counterRow())!.last_alloc_by).toBeNull(); // SET is not a claim
  });

  it("missing sequence identity → SEQUENCE_NOT_FOUND carrying the identity", async () => {
    const bogus = "11111111-2222-4333-8444-555555555555";
    await expect(
      repo.sequenceSet({ seq: { uuid: bogus }, next: 1n, actor: ACTOR }),
    ).rejects.toThrow(SequenceNotFoundError);
    await expect(
      repo.sequenceSet({ seq: { uuid: bogus }, next: 1n, actor: ACTOR }),
    ).rejects.toMatchObject({ code: "SEQUENCE_NOT_FOUND" });
  });

  it("non-bigint next → ValidationError", async () => {
    await expect(
      repo.sequenceSet({ seq: { uuid: SEQ_UUID }, next: 5 as unknown as bigint, actor: ACTOR }),
    ).rejects.toThrow(ValidationError);
  });

  it("tx-bound repo: the SET rolls back with the caller transaction", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const txRepo = new Repository(client, REPO_INTERNAL);
      await txRepo.sequenceSet({ seq: { uuid: SEQ_UUID }, next: 50n, actor: ACTOR });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await counterRow()).toBeUndefined();
  });

  it("sez ctx partitions the counter row under the right partition_key", async () => {
    const partUuid = await seedSequence("dal_test_seq.part", "PART-{sez}-{seq:3}");
    const res = await repo.sequenceSet({ seq: { uuid: partUuid }, next: 10n, sez: "A", actor: ACTOR });
    expect(res.partition_key).toBe("A\x1f\x1f");
    const counter = await counterRow();
    expect(counter!.partition_key).toBe("A\x1f\x1f");
    expect(counter!.counter).toBe(10n);
  });
});

describe("Repository — sequenceAnalyze read-only pre-check", () => {
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
    await seedSequence(SEQ_NAME);
  });

  async function seedCodes(...codes: string[]) {
    for (const c of codes) {
      await getTestPool().query(`INSERT INTO dal_test_seq (uuid, code, label) VALUES (uuidv7(), $1, 'x')`, [c]);
    }
  }

  it("derives the scan target from the <table>.<field> bound name — reports in_use/max/suggested", async () => {
    await seedCodes("TST-00001", "TST-00137", "TST-00138");
    const a = await repo.sequenceAnalyze({ seq: { uuid: SEQ_UUID } });
    expect(a.table).toBe("dal_test_seq");
    expect(a.column).toBe("code");
    expect(a.in_use).toBe(3n);
    expect(a.max_value).toBe(138n);
    expect(a.suggested_start).toBe(139n);
    expect(a.next_proposed).toBe("TST-00001"); // counter never claimed
    expect(a.next_in_use).toBe(true);          // TST-00001 exists → next emit would collide
    expect(a.conflicts_above).toBe(3n);        // all ≥ current (1)
    expect(a.ambiguous).toEqual([]);
    // read-only: no counter materialized
    expect(await counterRow()).toBeUndefined();
  });

  it("after a SET past the max, next_in_use clears and conflicts drop", async () => {
    await seedCodes("TST-00001", "TST-00042");
    await repo.sequenceSet({ seq: { uuid: SEQ_UUID }, next: 100n, actor: ACTOR });
    const a = await repo.sequenceAnalyze({ seq: { uuid: SEQ_UUID } });
    expect(a.next_proposed).toBe("TST-00100");
    expect(a.next_in_use).toBe(false);
    expect(a.conflicts_above).toBe(0n);
  });

  it("explicit table/column works for names without a <table>.<field> shape", async () => {
    const u = await seedSequence("custom.seq", "TST-{seq:5}");
    await seedCodes("TST-00007");
    const a = await repo.sequenceAnalyze({ seq: { uuid: u }, table: "dal_test_seq", column: "code" });
    expect(a.in_use).toBe(1n);
    expect(a.max_value).toBe(7n);
  });

  it("missing table/column on a non-derivable name → ValidationError", async () => {
    const u = await seedSequence("custom.seq");
    await expect(repo.sequenceAnalyze({ seq: { uuid: u } })).rejects.toThrow(ValidationError);
  });

  it("nonexistent or non-text target → ValidationError", async () => {
    await expect(
      repo.sequenceAnalyze({ seq: { uuid: SEQ_UUID }, table: "dal_test_seq", column: "nope" }),
    ).rejects.toThrow(ValidationError);
    await expect(
      repo.sequenceAnalyze({ seq: { uuid: SEQ_UUID }, table: "dal_test_seq", column: "label" }),
    ).resolves.toBeDefined(); // label is text — legal
    await getTestPool().query(`CREATE TABLE IF NOT EXISTS analyze_num (n int)`);
    await expect(
      repo.sequenceAnalyze({ seq: { uuid: SEQ_UUID }, table: "analyze_num", column: "n" }),
    ).rejects.toThrow(/text\/varchar/);
  });

  it("pattern-exact: sibling prefixes never pollute (TST-… vs TSTX-…), width matches W-or-more", async () => {
    await seedCodes("TST-00001", "TSTX-99999", "TST-ABC");
    const a = await repo.sequenceAnalyze({ seq: { uuid: SEQ_UUID } });
    expect(a.in_use).toBe(1n); // TSTX-99999 is NOT in this pattern's space
    expect(a.max_value).toBe(1n);
  });

  it("partitions group by sez segments; sez ctx narrows to that partition", async () => {
    const partUuid = await seedSequence("dal_test_seq.part", "P-{sez}-{seq:3}");
    await seedCodes("P-A-001", "P-A-007", "P-B-003", "Q-X-999");
    const g = await repo.sequenceAnalyze({ seq: { uuid: partUuid }, table: "dal_test_seq", column: "code" });
    expect(g.in_use).toBe(3n); // Q-X-999 is a different literal prefix
    expect(g.partitions).toHaveLength(2);
    const pa = g.partitions.find((p) => p.partition_key.startsWith("A"))!;
    expect(pa.in_use).toBe(2n);
    expect(pa.max_value).toBe(7n);
    const scoped = await repo.sequenceAnalyze({ seq: { uuid: partUuid }, table: "dal_test_seq", column: "code", sez: "B" });
    expect(scoped.in_use).toBe(1n);
    expect(scoped.partitions[0]!.max_value).toBe(3n);
  });

  it("ambiguous: a sibling sequence whose pattern also matches values is listed by name", async () => {
    await seedSequence("dal_test_seq.wide", "TST-{seq:3}"); // \d{3,} matches TST-00042 too
    await seedSequence("other.seq", "Q-{seq:4}");
    await seedCodes("TST-00042");
    const a = await repo.sequenceAnalyze({ seq: { uuid: SEQ_UUID } });
    expect(a.ambiguous).toContain("dal_test_seq.wide");
    expect(a.ambiguous).not.toContain("other.seq");
    expect(a.ambiguous).not.toContain(SEQ_NAME); // self never reported
  });
describe("Repository — binding series resolution (reviver)", () => {
  it("legacy bound row is adopted: binding_key + default_from stamped on first lookup", async () => {
    const row = await repo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR });
    expect(row.code).toBe("TST-00001");
    const seqs = await seqRows();
    expect(seqs[0]!.binding_key).toBe(SEQ_NAME);
    expect(seqs[0]!.default_from).not.toBeNull();
  });

  it("empty series materializes gen-0 WITH binding_key + default_from", async () => {
    await getTestPool().query(`DELETE FROM sequences`);
    await repo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR });
    const rows = await seqRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.binding_key).toBe(SEQ_NAME);
    expect(rows[0]!.default_from).not.toBeNull();
  });

  it("series picks the generation owning `at` — latest default_from <= now wins", async () => {
    // gen-1 successor anchored in the past, reviving pattern — the
    // write resolves it even though the detUuid row is the legacy seed.
    await getTestPool().query(
      `INSERT INTO sequences (uuid, name, pattern, step, start, binding_key, default_from)
       VALUES (uuidv7(), 'dal_test_seq.code#27', 'NEW-{seq:4}/{sez}', 1, 1, $1, now() - interval '1 day')`,
      [SEQ_NAME],
    );
    await getTestPool().query(`UPDATE sequences SET sez = '27' WHERE binding_key = $1 AND name LIKE '%#27'`, [SEQ_NAME]);
    const row = await repo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR });
    expect(row.code).toBe("NEW-0001/27");
  });

  it("a successor with FUTURE default_from does not serve yet — old gen wins now", async () => {
    await getTestPool().query(
      `INSERT INTO sequences (uuid, name, pattern, step, start, binding_key, default_from)
       VALUES (uuidv7(), 'dal_test_seq.code#27', 'NEW-{seq:4}', 1, 1, $1, now() + interval '1 day')`,
      [SEQ_NAME],
    );
    const row = await repo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR });
    expect(row.code).toBe("TST-00001"); // still the legacy generation
  });

  it("row-owned sez merges into the allocation ctx — owned slots immutable", async () => {
    await getTestPool().query(
      `UPDATE sequences SET pattern = 'TST-{seq:4}/{sez}', sez = '26' WHERE uuid = $1`,
      [SEQ_UUID],
    );
    const row = await repo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR });
    expect(row.code).toBe("TST-0001/26");
    // pinned uuid + a DIFFERENT sez for the owned slot → construction error
    await expect(
      repo.add(SeqTestEntity, { code: { seq: { uuid: SEQ_UUID, sez: "27" } }, label: "x" }, { actor: ACTOR }),
    ).rejects.toThrow(/owns slot value/);
    // same value re-stated is fine
    const ok = await repo.add(
      SeqTestEntity,
      { code: { seq: { uuid: SEQ_UUID, sez: "26" } }, label: "ok" },
      { actor: ACTOR },
    );
    expect(ok.code).toBe("TST-0002/26");
  });
});
});
