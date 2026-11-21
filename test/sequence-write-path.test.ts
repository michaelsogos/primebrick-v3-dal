import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg, { Pool } from "pg";

import { Dal } from "../src/dal/dal.js";
import { Repository, REPO_INTERNAL } from "../src/repository/repository.js";
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
 * allocation, code/uuid/expr directives, strict literal rejection,
 * SEQUENCE_NOT_FOUND identity, bulk `count:N` claims + uniformity,
 * clone allocation, rollback atomicity, actor attribution, rendered
 * length guard, and the deferred-transaction forbid.
 */

const SEQ_CODE = "dal_test_seq.code"; // derived default: <table>.<field>
const ACTOR = "seq-actor";

async function seedSequence(code: string, pattern = "TST-{seq:5}", step = 1n, start = 1n): Promise<string> {
  const r = await getTestPool().query<{ uuid: string }>(
    `INSERT INTO sequences (uuid, code, pattern, step, start)
     VALUES (uuidv7(), $1, $2, $3, $4) RETURNING uuid`,
    [code, pattern, step, start],
  );
  return r.rows[0]!.uuid;
}

async function counterRow(): Promise<Record<string, unknown> | undefined> {
  const r = await getTestPool().query(`SELECT * FROM sequence_counters`);
  return r.rows[0] as Record<string, unknown> | undefined;
}

async function seqRows(): Promise<Array<Record<string, unknown>>> {
  const r = await getTestPool().query(`SELECT * FROM sequences ORDER BY code`);
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
    await seedSequence(SEQ_CODE);
  });

  it("add omitted → allocates the field default sequence inside the lazy mini-tx", async () => {
    const row = await repo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR });
    expect(row.code).toBe("TST-00001");
    const counter = await counterRow();
    expect(counter).toBeDefined();
    expect(counter!.counter).toBe(2n); // next-to-emit
    expect(counter!.last_alloc_by).toBe(ACTOR);
  });

  it("add {seq:{code}} → same counter continues", async () => {
    await repo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR });
    const row = await repo.add(
      SeqTestEntity,
      { code: { seq: { code: SEQ_CODE } }, label: "b" },
      { actor: ACTOR },
    );
    expect(row.code).toBe("TST-00002");
  });

  it("add {seq:uuid} → resolves by uuid identity", async () => {
    const uuid = (await seqRows())[0]!.uuid as string;
    const row = await repo.add(SeqTestEntity, { code: { seq: uuid }, label: "u" }, { actor: ACTOR });
    expect(row.code).toBe("TST-00001");
  });

  it("literal reaching the repository is STRICT-rejected (API bypass-proof)", async () => {
    await expect(
      repo.add(SeqTestEntity, { code: "RAW-001", label: "x" }, { actor: ACTOR }),
    ).rejects.toThrow(ValidationError);
    // and nothing was claimed
    expect(await counterRow()).toBeUndefined();
  });

  it("missing sequence code → SEQUENCE_NOT_FOUND carrying the identity", async () => {
    const err = await repo
      .add(SeqTestEntity, { code: { seq: { code: "nope.code" } }, label: "x" }, { actor: ACTOR })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SequenceNotFoundError);
    expect((err as SequenceNotFoundError).identity).toBe("nope.code");
    expect((err as SequenceNotFoundError).code).toBe("SEQUENCE_NOT_FOUND");
  });

  it("expr directive materializes a field-scoped sequence row idempotently", async () => {
    const dir = { seq: { pattern: "EXP-{seq:4}", step: 1n, start: 7n } };
    const a = await repo.add(SeqTestEntity, { code: dir, label: "a" }, { actor: ACTOR });
    const b = await repo.add(SeqTestEntity, { code: dir, label: "b" }, { actor: ACTOR });
    expect(a.code).toBe("EXP-0007");
    expect(b.code).toBe("EXP-0008"); // SAME counter — materialized once
    const rows = await seqRows();
    const expr = rows.filter((r) => (r.code as string).startsWith(`${SEQ_CODE}@expr_`));
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
      { uuid: row.uuid, version: relabeled.version, code: { seq: { code: SEQ_CODE } } },
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
        [{ label: "a" }, { code: { seq: { code: SEQ_CODE } }, label: "b" }],
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
        { uuid: a.uuid, version: a.version, code: { seq: { code: SEQ_CODE } } },
        { uuid: b.uuid, version: b.version, code: { seq: { code: SEQ_CODE } } },
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
          { uuid: a.uuid, version: 2, code: { seq: { code: SEQ_CODE } } },
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
        tx2.update(SeqTestEntity, { uuid: src.uuid, version: src.version, code: { seq: { code: SEQ_CODE } } }, { actor: ACTOR }),
      ).toThrow(ValidationError);
    } finally {
      await dal.close();
    }
  });
});
