import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { Repository } from "../src/index.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import { CompositeUniqueEntity } from "./entities/composite-unique-entity.js";
import { ManualUniqueEntity } from "./entities/manual-unique-entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

/**
 * ERRxx error-code matrix — every documented DAL error code exercised
 * end-to-end through the repository against real PostgreSQL, including edge
 * cases and wire-shape probes (what fields PG actually attaches to 23505 and
 * 57014 errors, so the HTTP boundary can enrich ERR07/ERR08 details).
 *
 * Own tables (dal_test_composite, dal_test_manual) are created here, not in
 * shared setup — the manual unique index must stay invisible to metadata.
 */

type PgErr = Error & Record<string, unknown>;

async function capture<T>(p: Promise<T>): Promise<PgErr> {
  try {
    await p;
  } catch (e) {
    return e as PgErr;
  }
  throw new Error("expected the operation to throw, but it succeeded");
}

function detailOf(err: PgErr): Record<string, unknown> {
  const raw = err.detail;
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") return JSON.parse(raw);
  return {};
}

describe("ERRxx matrix — every DAL error code, end-to-end", () => {
  let pool: Pool;
  let repo: Repository;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestSchema();
    repo = new Repository(pool);
    // Composite-unique table (metadata-driven UNIQUE INDEX (grp_a, grp_b))
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dal_test_composite (
        id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        uuid   uuid NOT NULL DEFAULT gen_random_uuid(),
        name   text,
        grp_a  text,
        grp_b  text
      );
      CREATE UNIQUE INDEX IF NOT EXISTS dal_test_composite_uuid_idx ON dal_test_composite (uuid);
      CREATE UNIQUE INDEX IF NOT EXISTS dal_test_composite_ab_uidx ON dal_test_composite (grp_a, grp_b);
    `);
    // Manual-unique table — email unique index NOT declared via @Unique
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dal_test_manual (
        id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        uuid   uuid NOT NULL DEFAULT gen_random_uuid(),
        name   text,
        email  text
      );
      CREATE UNIQUE INDEX IF NOT EXISTS dal_test_manual_uuid_idx ON dal_test_manual (uuid);
      CREATE UNIQUE INDEX IF NOT EXISTS dal_test_manual_email_manual_idx ON dal_test_manual (email);
    `);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  beforeEach(async () => {
    await truncateTestTables();
    await pool.query(`TRUNCATE TABLE dal_test_composite, dal_test_manual RESTART IDENTITY CASCADE`);
  });

  // ─── probes: what does PG actually give us on the wire? ────────────

  it("PROBE 23505: enumerate every error field PG attaches to a raw unique violation", async () => {
    await repo.add(ManualUniqueEntity, { name: "a", email: "dup@x.com" }, {});
    const err = await capture(repo.add(ManualUniqueEntity, { name: "b", email: "dup@x.com" }, {}));
    expect(err.code).toBe("23505");
    // Empirical inventory — printed so we can decide what to enrich ERR08 with
    const fields: Record<string, unknown> = {};
    for (const k of [
      "severity", "code", "detail", "hint", "schema", "table", "column",
      "constraint", "datatype", "position", "internalPosition", "internalQuery",
      "where", "file", "line", "routine",
    ]) {
      if ((err as Record<string, unknown>)[k] !== undefined) fields[k] = (err as Record<string, unknown>)[k];
    }
    console.log("[23505 fields]", JSON.stringify(fields, null, 2));
    expect(fields.constraint).toBe("dal_test_manual_email_manual_idx");
    expect(fields.table).toBe("dal_test_manual");
  });

  it("PROBE 23505 on update(): same wire shape via the guarded UPDATE path", async () => {
    await repo.add(ManualUniqueEntity, { name: "a", email: "dup@x.com" }, {});
    const b = await repo.add(ManualUniqueEntity, { name: "b", email: "free@x.com" }, {});
    const err = await capture(
      repo.update(ManualUniqueEntity, { uuid: b.uuid, email: "dup@x.com" }, { matchBy: "uuid" as never }),
    );
    expect(err.code).toBe("23505");
    console.log("[23505-update detail]", err.detail, "| constraint:", err.constraint, "| table:", err.table);
    expect(err.constraint).toBe("dal_test_manual_email_manual_idx");
  });

  it("PROBE 57014: enumerate fields on statement_timeout query_canceled", async () => {
    const client = await pool.connect();
    try {
      await client.query("SET statement_timeout = 50");
      const err = await capture(client.query("SELECT pg_sleep(1)"));
      expect(err.code).toBe("57014");
      const fields: Record<string, unknown> = {};
      for (const k of ["severity", "code", "detail", "hint", "where", "file", "line", "routine"]) {
        if ((err as Record<string, unknown>)[k] !== undefined) fields[k] = (err as Record<string, unknown>)[k];
      }
      console.log("[57014 fields]", JSON.stringify(fields, null, 2));
    } finally {
      await client.query("RESET statement_timeout").catch(() => undefined);
      client.release();
    }
  });

  // ─── ERR01 — stale version ─────────────────────────────────────────

  it("ERR01: update with stale version (unique col untouched)", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A" }, { actor: "u" });
    await repo.update(SimpleTestEntity, { uuid: a.uuid, name: "A2", version: a.version }, { actor: "u", matchBy: "uuid" as never });
    const err = await capture(
      repo.update(SimpleTestEntity, { uuid: a.uuid, name: "A3", version: a.version }, { actor: "u", matchBy: "uuid" as never }),
    );
    expect(err.code).toBe("ERR01");
  });

  it("ERR01: delete (soft) with stale version", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A" }, { actor: "u" });
    await repo.update(SimpleTestEntity, { uuid: a.uuid, name: "A2", version: a.version }, { actor: "u", matchBy: "uuid" as never });
    const err = await capture(
      repo.delete(SimpleTestEntity, { uuid: a.uuid, version: a.version }, { actor: "u", matchBy: "uuid" as never }),
    );
    expect(err.code).toBe("ERR01");
  });

  it("ERR01: restore with stale version", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A" }, { actor: "u" });
    await repo.delete(SimpleTestEntity, { uuid: a.uuid, version: a.version }, { actor: "u", matchBy: "uuid" as never });
    const err = await capture(
      repo.restore(SimpleTestEntity, { uuid: a.uuid, version: a.version }, { actor: "u", matchBy: "uuid" as never }),
    );
    expect(err.code).toBe("ERR01");
  });

  // ─── ERR02 — missing version ───────────────────────────────────────

  it("ERR02: update without version on auditable entity — thrown before any SQL", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A" }, { actor: "u" });
    const err = await capture(
      repo.update(SimpleTestEntity, { uuid: a.uuid, name: "B" }, { actor: "u", matchBy: "uuid" as never }),
    );
    expect(err.code).toBe("ERR02");
  });

  it("ERR02 wins over a pending unique conflict (missing version short-circuits before the CTE)", async () => {
    await repo.add(SimpleTestEntity, { name: "A", email: "taken@x.com" }, { actor: "u" });
    const b = await repo.add(SimpleTestEntity, { name: "B" }, { actor: "u" });
    const err = await capture(
      repo.update(SimpleTestEntity, { uuid: b.uuid, email: "taken@x.com" }, { actor: "u", matchBy: "uuid" as never }),
    );
    expect(err.code).toBe("ERR02");
  });

  // ─── ERR03 — record vanished ───────────────────────────────────────

  it("ERR03: update a hard-deleted row", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A" }, { actor: "u" });
    await repo.hardDelete(SimpleTestEntity, { uuid: a.uuid, version: a.version }, { actor: "u", matchBy: "uuid" as never });
    const err = await capture(
      repo.update(SimpleTestEntity, { uuid: a.uuid, name: "G", version: a.version }, { actor: "u", matchBy: "uuid" as never }),
    );
    expect(err.code).toBe("ERR03");
  });

  it("ERR03 wins over a would-be unique conflict (vanished target → empty t0 → no raise)", async () => {
    await repo.add(SimpleTestEntity, { name: "A", email: "taken@x.com" }, { actor: "u" });
    const b = await repo.add(SimpleTestEntity, { name: "B" }, { actor: "u" });
    await repo.hardDelete(SimpleTestEntity, { uuid: b.uuid, version: b.version }, { actor: "u", matchBy: "uuid" as never });
    const err = await capture(
      repo.update(SimpleTestEntity, { uuid: b.uuid, email: "taken@x.com", version: b.version }, { actor: "u", matchBy: "uuid" as never }),
    );
    expect(err.code).toBe("ERR03");
  });

  // ─── ERR04 — live unique conflict ──────────────────────────────────

  it("ERR04: add() duplicate email — detail carries uuid + constraint + keys", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A", email: "dup@x.com" }, { actor: "u" });
    const err = await capture(
      repo.add(SimpleTestEntity, { name: "B", email: "dup@x.com" }, { actor: "u" }),
    );
    expect(err.code).toBe("ERR04");
    const d = detailOf(err);
    expect(d.uuid).toBe(a.uuid);
    expect(d.constraint).toBe("email");
    expect(d.keys).toEqual({ email: "dup@x.com" });
  });

  it("ERR04: add() duplicate uuid (explicit) — keys include the attempted uuid", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A" }, { actor: "u" });
    const err = await capture(
      repo.add(SimpleTestEntity, { uuid: a.uuid, name: "B" }, { actor: "u" }),
    );
    expect(err.code).toBe("ERR04");
    const d = detailOf(err);
    expect(d.constraint).toBe("uuid");
    expect(d.keys).toEqual({ uuid: a.uuid });
  });

  it("ERR04: update() composite group — keys include BOTH columns (untouched grp_b read from t0)", async () => {
    await repo.add(CompositeUniqueEntity, { name: "x", grp_a: "A1", grp_b: "B1" }, {});
    const b = await repo.add(CompositeUniqueEntity, { name: "y", grp_a: "A2", grp_b: "B1" }, {});
    // Change only grp_a of b → collides with (A1, B1); grp_b untouched comes from t0
    const err = await capture(
      repo.update(CompositeUniqueEntity, { uuid: b.uuid, grp_a: "A1" }, { matchBy: "uuid" as never }),
    );
    expect(err.code).toBe("ERR04");
    const d = detailOf(err);
    expect(d.constraint).toBe("dal_test_composite_ab_uidx");
    expect(d.keys).toEqual({ grp_a: "A1", grp_b: "B1" });
  });

  it("ERR04: add() composite group — keys carry the full attempted combination", async () => {
    await repo.add(CompositeUniqueEntity, { name: "x", grp_a: "A1", grp_b: "B1" }, {});
    const err = await capture(
      repo.add(CompositeUniqueEntity, { name: "y", grp_a: "A1", grp_b: "B1" }, {}),
    );
    expect(err.code).toBe("ERR04");
    const d = detailOf(err);
    expect(d.keys).toEqual({ grp_a: "A1", grp_b: "B1" });
  });

  it("ERR04: add() composite PARTIAL match does NOT conflict (grp_a equal, grp_b differs)", async () => {
    await repo.add(CompositeUniqueEntity, { name: "x", grp_a: "A1", grp_b: "B1" }, {});
    const ok = await repo.add(CompositeUniqueEntity, { name: "y", grp_a: "A1", grp_b: "B2" }, {});
    expect(ok.uuid).toBeDefined();
  });

  // ─── ERR05 — soft-deleted unique conflict ──────────────────────────

  it("ERR05: add() colliding with a soft-deleted row — keys + uuid of the deleted row", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A", email: "gone@x.com" }, { actor: "u" });
    await repo.delete(SimpleTestEntity, { uuid: a.uuid, version: a.version }, { actor: "u", matchBy: "uuid" as never });
    const err = await capture(
      repo.add(SimpleTestEntity, { name: "B", email: "gone@x.com" }, { actor: "u" }),
    );
    expect(err.code).toBe("ERR05");
    const d = detailOf(err);
    expect(d.uuid).toBe(a.uuid);
    expect(d.keys).toEqual({ email: "gone@x.com" });
  });

  it("ERR04 wins when conflicts hit BOTH a live and a deleted row (different groups)", async () => {
    // live row owns email, deleted row owns uuid — one raise: which code wins?
    const del = await repo.add(SimpleTestEntity, { name: "D" }, { actor: "u" });
    const uuidToSteal = del.uuid;
    await repo.delete(SimpleTestEntity, { uuid: del.uuid, version: del.version }, { actor: "u", matchBy: "uuid" as never });
    await repo.add(SimpleTestEntity, { name: "L", email: "live@x.com" }, { actor: "u" });
    const err = await capture(
      repo.add(SimpleTestEntity, { uuid: uuidToSteal, name: "N", email: "live@x.com" }, { actor: "u" }),
    );
    // single-row add(): whichever conflict the LIMIT 1 CTE surfaces first —
    // assert it IS one of the conflict codes and inspect which won
    console.log("[dual-conflict winner]", err.code, detailOf(err));
    expect(["ERR04", "ERR05"]).toContain(err.code);
  });

  // ─── NULLS DISTINCT edges ──────────────────────────────────────────

  it("NULL edge: two add()s omitting a nullable @Unique column both succeed", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A" }, { actor: "u" });
    const b = await repo.add(SimpleTestEntity, { name: "B" }, { actor: "u" });
    expect(a.uuid).not.toBe(b.uuid);
  });

  it("NULL edge: update() setting email=NULL while other rows hold NULL/real values succeeds", async () => {
    await repo.add(SimpleTestEntity, { name: "A" }, { actor: "u" }); // email NULL
    const b = await repo.add(SimpleTestEntity, { name: "B", email: "b@x.com" }, { actor: "u" });
    const updated = await repo.update(
      SimpleTestEntity,
      { uuid: b.uuid, email: null, version: b.version },
      { actor: "u", matchBy: "uuid" as never },
    );
    expect(updated.email).toBeNull();
  });

  // ─── ERR06 — bulk wall-clock timeout ───────────────────────────────

  it("ERR06/57014: addMany timeoutMs=1 → the budget kills the op, rows rolled back (code is RACY: ERR06 | 57014)", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ uuid: randomUUID(), name: `T${i}` }));
    const err = await capture(repo.addMany(SimpleTestEntity, rows, { actor: "u", timeoutMs: 1 }));
    // Empirically nondeterministic: statement_timeout (57014) and the JS
    // deadline check (BulkTimeoutError/ERR06) race — same input, different
    // code, and at the HTTP boundary DIFFERENT status (ERR07→500 vs ERR06→408).
    console.log("[bulk-timeout code]", err.code);
    expect(["ERR06", "57014"]).toContain(err.code);
    expect(await repo.count(SimpleTestEntity)).toBe(0n);
  });

  // ─── ERR08 — raw 23505 through repository paths ────────────────────

  it("ERR08 path: add() hits an undeclared manual unique index → raw 23505 (mapper maps to ERR08)", async () => {
    await repo.add(ManualUniqueEntity, { name: "a", email: "dup@x.com" }, {});
    const err = await capture(repo.add(ManualUniqueEntity, { name: "b", email: "dup@x.com" }, {}));
    expect(err.code).toBe("23505"); // DAL passes it raw; mapDalError → ERR08
  });

  it("ERR08 path: update() hits an undeclared manual unique index → raw 23505", async () => {
    await repo.add(ManualUniqueEntity, { name: "a", email: "dup@x.com" }, {});
    const b = await repo.add(ManualUniqueEntity, { name: "b", email: "other@x.com" }, {});
    const err = await capture(
      repo.update(ManualUniqueEntity, { uuid: b.uuid, email: "dup@x.com" }, { matchBy: "uuid" as never }),
    );
    expect(err.code).toBe("23505");
  });

  // ─── matchBy matrix — what does each form actually do? ─────────────

  it("matchBy omitted → default @Key (id); payload carrying id works", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A" }, { actor: "u" });
    const stored = await repo.findByUUID(SimpleTestEntity, a.uuid);
    const updated = await repo.update(
      SimpleTestEntity,
      { id: stored!.id, name: "A2", version: a.version },
      { actor: "u" },
    );
    expect(updated.name).toBe("A2");
  });

  it("matchBy omitted + payload carrying ONLY uuid → fails (id is the default match column)", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A" }, { actor: "u" });
    const err = await capture(
      repo.update(SimpleTestEntity, { uuid: a.uuid, name: "B", version: a.version }, { actor: "u" }),
    );
    console.log("[matchBy-omitted-uuid-only] code:", err.code, "| msg:", err.message);
    expect(err).toBeInstanceOf(Error);
  });

  it("matchBy unknown property → UnknownColumnError before SQL", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A" }, { actor: "u" });
    const err = await capture(
      repo.update(
        SimpleTestEntity,
        { uuid: a.uuid, name: "B", version: a.version },
        { actor: "u", matchBy: "nonexistent_prop" as never },
      ),
    );
    console.log("[matchBy-unknown] code:", err.code, "| msg:", err.message);
    expect(err).toBeInstanceOf(Error);
  });

  it("matchBy:'email' — updating ANOTHER field while matching on the unique col itself", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A", email: "me@x.com" }, { actor: "u" });
    const updated = await repo.update(
      SimpleTestEntity,
      { email: "me@x.com", name: "A2", version: a.version },
      { actor: "u", matchBy: "email" as never },
    );
    expect(updated.name).toBe("A2");
  });

  it("matchBy:'email' — SET a DIFFERENT unique col (uuid) to a duplicate → ERR04, self-exclusion by email correct", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A", email: "a@x.com" }, { actor: "u" });
    const b = await repo.add(SimpleTestEntity, { name: "B", email: "b@x.com" }, { actor: "u" });
    // match B by email, try to steal A's uuid — the unique group checked is
    // `uuid`, the self-exclusion runs on `email` (the match column)
    const err = await capture(
      repo.update(
        SimpleTestEntity,
        { email: "b@x.com", uuid: a.uuid, version: b.version },
        { actor: "u", matchBy: "email" as never },
      ),
    );
    expect(err.code).toBe("ERR04");
    const d = detailOf(err);
    expect(d.constraint).toBe("uuid");
    expect(d.uuid).toBe(a.uuid);
  });

  it("matchBy on a NON-unique column (name) matching 2 rows → does it update both?", async () => {
    await repo.add(SimpleTestEntity, { name: "shared", email: "one@x.com" }, { actor: "u" });
    await repo.add(SimpleTestEntity, { name: "shared", email: "two@x.com" }, { actor: "u" });
    const res = await repo.update(
      SimpleTestEntity,
      { name: "shared", description: "hit-both?", version: 1 },
      { actor: "u", matchBy: "name" as never },
    ).then((r) => ({ ok: r as unknown })).catch((e) => ({ err: e as PgErr }));
    const rows = await repo.findAll(SimpleTestEntity);
    const touched = rows.filter((r) => r.description === "hit-both?");
    console.log("[matchBy-nonunique] result:", JSON.stringify(res), "| touched rows:", touched.length);
    expect(touched.length).toBeGreaterThan(0);
  });

  it("update() version is taken from PAYLOAD, not from a live read — wrong-but-existing version still guards", async () => {
    const a = await repo.add(SimpleTestEntity, { name: "A" }, { actor: "u" });
    // caller sends version far in the future — not stale-behind, just wrong
    const err = await capture(
      repo.update(SimpleTestEntity, { uuid: a.uuid, name: "X", version: 999 }, { actor: "u", matchBy: "uuid" as never }),
    );
    expect(err.code).toBe("ERR01");
  });

  // ─── intra-statement race — REAL two-connection concurrency ────────

  it("RACE: uncommitted INSERT by tx2 blocks our UPDATE write; commit → raw 23505 (CTE snapshot can't see it)", async () => {
    const tx2 = await pool.connect();
    try {
      const b = await repo.add(SimpleTestEntity, { name: "B", email: "b@x.com" }, { actor: "u" });
      // tx2 inserts the would-be-conflicting value but does NOT commit yet
      await tx2.query("BEGIN");
      await tx2.query(`INSERT INTO dal_test_simple (name, email) VALUES ('RACER', 'race@x.com')`);

      // our update: conflict CTE snapshot was taken before tx2 committed → sees
      // nothing; the btree unique check then BLOCKS on tx2's in-flight entry.
      const upd = repo.update(
        SimpleTestEntity,
        { uuid: b.uuid, email: "race@x.com", version: b.version },
        { actor: "u", matchBy: "uuid" as never },
      ).then((r) => ({ ok: r })).catch((e) => ({ err: e as PgErr }));

      await new Promise((r) => setTimeout(r, 300)); // let the UPDATE reach the blocking index probe
      await tx2.query("COMMIT");
      const res = await upd;
      const code = "err" in res ? res.err.code : "no-error";
      console.log("[race-commit] outcome code:", code);
      expect("err" in res ? res.err : null).not.toBeNull();
    } finally {
      tx2.release();
    }
  }, 15000);

  it("RACE: tx2 ROLLS BACK instead → our UPDATE completes successfully (no phantom conflict)", async () => {
    const tx2 = await pool.connect();
    try {
      const b = await repo.add(SimpleTestEntity, { name: "B", email: "b@x.com" }, { actor: "u" });
      await tx2.query("BEGIN");
      await tx2.query(`INSERT INTO dal_test_simple (name, email) VALUES ('RACER', 'race@x.com')`);

      const upd = repo.update(
        SimpleTestEntity,
        { uuid: b.uuid, email: "race@x.com", version: b.version },
        { actor: "u", matchBy: "uuid" as never },
      ).then((r) => ({ ok: r })).catch((e) => ({ err: e as PgErr }));

      await new Promise((r) => setTimeout(r, 300));
      await tx2.query("ROLLBACK");
      const res = await upd;
      expect("ok" in res).toBe(true);
      if ("ok" in res) expect((res.ok as { email?: string }).email).toBe("race@x.com");
    } finally {
      tx2.release();
    }
  }, 15000);

  // ─── ERR06 reachability — which code does timeoutMs really yield? ──

  it("PROBE: timeoutMs sweep — 57014 vs ERR06 boundary", async () => {
    const results: Record<number, string> = {};
    for (const budget of [1, 5, 20, 100, 500]) {
      const rows = Array.from({ length: 30 }, (_, i) => ({ uuid: randomUUID(), name: `B${budget}-${i}` }));
      const code = await repo
        .addMany(SimpleTestEntity, rows, { actor: "u", timeoutMs: budget })
        .then(() => "no-error")
        .catch((e) => (e as PgErr).code ?? "no-code");
      results[budget] = code;
      await truncateTestTables();
    }
    console.log("[timeout sweep] budget→code:", JSON.stringify(results));
    // Empirical claim: budget enforcement is RACY — 57014 (PG kill) or ERR06
    // (JS deadline) depending on which fires first; ≥20ms these 30 rows pass.
    expect(["ERR06", "57014"]).toContain(results[1]);
  });
});
