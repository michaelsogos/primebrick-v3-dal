import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg, { Pool } from "pg";

import { Repository, REPO_INTERNAL } from "../src/repository/repository.js";
import { sequenceBoundUuid } from "../src/meta/entity-decorators.js";
import { SeqTestEntity } from "./entities/seq-test-entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

/**
 * sequenceRevive — the atomic generation handover the JH job and the
 * governed RPC share. Phase A clones expired reviving rows (sez slot
 * advanced, anchors re-derived, chain audit stamped) looping until the
 * current generation owns `now`; phase B soft-deletes rows past
 * `switch_at`. Series resolution then serves the successor — bound
 * writes never re-point by hand.
 */

const SEQ_NAME = "dal_test_seq.code";
const SEQ_UUID = sequenceBoundUuid(SEQ_NAME);
const ACTOR = "revive-actor";

async function seedReviving(opts: {
  name?: string; sez?: string; every?: string; slot?: string;
  expire?: string; sw?: string;
} = {}): Promise<string> {
  await getTestPool().query(
    `INSERT INTO sequences
       (uuid, name, pattern, step, start, tz, sez, revive_every, revive_slot, expire_at, switch_at, default_from, binding_key)
     VALUES ($1, $2, $3, 1, 1, 'UTC', $4, $5, $6, $7::timestamptz, $8::timestamptz, '2025-01-01', $9)`,
    [
      SEQ_UUID,
      opts.name ?? SEQ_NAME,
      "TST-{seq:5}/{sez}",
      opts.sez ?? "26",
      opts.every ?? "1 year",
      opts.slot ?? "sez",
      opts.expire ?? "2027-01-01T00:00:00Z",
      opts.sw ?? "2027-01-11T00:00:00Z",
      SEQ_NAME,
    ],
  );
  return SEQ_UUID;
}

async function seqRows(): Promise<Array<Record<string, unknown>>> {
  const r = await getTestPool().query(`SELECT * FROM sequences ORDER BY created_at, name`);
  return r.rows as Array<Record<string, unknown>>;
}

describe("sequenceRevive — atomic generation handover", () => {
  let repo: Repository;
  let pool: Pool;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestSchema();
    repo = new Repository(pool, REPO_INTERNAL);
  });
  afterAll(async () => { await closeTestPool(); });
  beforeEach(async () => { await truncateTestTables(); });

  it("phase A: due row spawns successor — sez advanced, chain stamped, anchors re-derived", async () => {
    await seedReviving();
    const rep = await repo.sequenceRevive({
      actor: ACTOR, now: new Date("2027-01-05T00:00:00Z"),
    });
    expect(rep.revived).toHaveLength(1);
    const rows = await seqRows();
    expect(rows).toHaveLength(2);
    const next = rows.find((r) => r.revived_from === SEQ_UUID)!;
    expect(next).toBeDefined();
    expect(next.name).toBe(`${SEQ_NAME}#27`);
    expect(next.sez).toBe("27");
    expect(next.revived_from).toBe(SEQ_UUID);
    expect(next.revived_by).toBe(ACTOR);
    expect((next.revived_at as Date).toISOString()).toBe("2027-01-05T00:00:00.000Z");
    // anchors: default_from = prev boundary; expire = next Jan-1; switch = +grace
    expect((next.default_from as Date).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect((next.expire_at as Date).toISOString()).toBe("2028-01-01T00:00:00.000Z");
    expect(next.binding_key).toBe(SEQ_NAME);
    // grace open (switch_at Jan-11 > now Jan-5) → predecessor still alive
    const prev = rows.find((r) => r.uuid === SEQ_UUID)!;
    expect(prev.deleted_at).toBeNull();
    expect(rep.switched).toHaveLength(0);
  });

  it("idempotent re-fire — a successor already exists, nothing duplicates", async () => {
    await seedReviving();
    await repo.sequenceRevive({ actor: ACTOR, now: new Date("2027-01-05T00:00:00Z") });
    const again = await repo.sequenceRevive({ actor: ACTOR, now: new Date("2027-01-05T00:00:00Z") });
    expect(again.revived).toHaveLength(0);
    expect(await seqRows()).toHaveLength(2);
  });

  it("phase B: switch_at passed → predecessor soft-deleted, history preserved", async () => {
    await seedReviving();
    const rep = await repo.sequenceRevive({
      actor: ACTOR, now: new Date("2027-01-12T00:00:00Z"),
    });
    expect(rep.revived).toHaveLength(1);
    expect(rep.switched).toEqual([SEQ_UUID]);
    const prev = (await seqRows()).find((r) => r.uuid === SEQ_UUID)!;
    expect(prev.deleted_at).not.toBeNull();
    expect(prev.deleted_by).toBe(ACTOR);
    expect(prev.sez).toBe("26"); // 2026 counter preserved for analysis
  });

  it("late job catches the chain up — one real period at a time", async () => {
    // monthly cadence expiring Feb-1; now is April — two generations spawn
    await seedReviving({ every: "1 month", sez: "2026-01", expire: "2026-02-01", sw: "2026-03-01" });
    const rep = await repo.sequenceRevive({
      actor: ACTOR, now: new Date("2026-04-15T00:00:00Z"),
    });
    // chain: 2026-01 → 2026-02 (expire Mar-1) → 2026-03 (expire Apr-1) → 2026-04 (expire May-1)
    expect(rep.revived).toHaveLength(3);
    const rows = await seqRows();
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual([
      SEQ_NAME, `${SEQ_NAME}#2026-02`, `${SEQ_NAME}#2026-03`, `${SEQ_NAME}#2026-04`,
    ]);
    // no grace → switch_at = expire_at: seed (Mar-1), #02 (Mar-1) and
    // #03 (Apr-1) all retired by Apr-15 — only the current gen is alive
    const alive = rows.filter((r) => r.deleted_at === null).map((r) => r.name).sort();
    expect(alive).toEqual([`${SEQ_NAME}#2026-04`]);
    expect(rep.switched).toHaveLength(3);
    // current gen serves the binding — no repointing by hand
    const row = await repo.add(SeqTestEntity, { label: "a" }, { actor: ACTOR });
    expect(row.code).toBe("TST-00001/2026-04");
  });

  it("only_uuid scopes phase A; phase B always sweeps", async () => {
    await seedReviving();
    const rep = await repo.sequenceRevive({
      actor: ACTOR, now: new Date("2027-01-05T00:00:00Z"),
      only_uuid: "11111111-2222-4333-8444-555555555555",
    });
    expect(rep.revived).toHaveLength(0);
    expect(await seqRows()).toHaveLength(1);
  });
});
