/**
 * Migration engine — failure-model test matrix (plan §11).
 * Fake PoolClient records every query on ONE connection so we can assert
 * atomicity (registry row inside the patch tx), ordering, lock handling,
 * manifest gating and resume semantics.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import type { PoolClient } from "pg";

import {
  runMigrations,
  parsePatchPragmas,
  signManifest,
  splitSqlStatements,
  type PatchManifest,
} from "../src/index.js";

// ─── fake pg client ─────────────────────────────────────────────────────────

type Script = Record<string, unknown>;

class FakeClient {
  queries: { text: string; params?: unknown[]; inTx: boolean }[] = [];
  inTx = false;
  registry = new Map<string, Record<string, unknown>>();
  lockFree = true;
  configEntries: Record<string, string> | null = {};
  /** patch_name → throw on first/always attempt */
  failOn: Record<string, string | undefined> = {};
  throwOnce = new Set<string>();
  script: Script[] = [];

  async query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number }> {
    this.queries.push({ text, params, inTx: this.inTx });
    const t = text.trim();

    if (t === "BEGIN") { this.inTx = true; return { rows: [], rowCount: 0 }; }
    if (t === "COMMIT") { this.inTx = false; return { rows: [], rowCount: 0 }; }
    if (t === "ROLLBACK") { this.inTx = false; return { rows: [], rowCount: 0 }; }
    if (/^SET /.test(t) || /SET LOCAL/.test(t)) return { rows: [], rowCount: 0 };

    if (/to_regclass/.test(t)) {
      return { rows: [{ oid: this.configEntries ? "x" : null }], rowCount: 1 };
    }
    if (/config_entries/.test(t) && /db_migration\.mode/.test(t)) {
      return { rows: this.configEntries?.["db_migration.mode"] ? [{ value: this.configEntries["db_migration.mode"] }] : [], rowCount: 1 };
    }
    if (/pg_try_advisory_lock/.test(t)) {
      return { rows: [{ locked: this.lockFree }], rowCount: 1 };
    }
    if (/pg_advisory_unlock/.test(t)) return { rows: [], rowCount: 0 };

    if (/FROM "?test"?\.primebrick_database_patches/.test(t) && /SELECT/.test(t) && !/INSERT/.test(t)) {
      return { rows: [...this.registry.values()], rowCount: this.registry.size };
    }
    if (/CREATE SCHEMA|CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS primebrick/.test(t)) {
      return { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO "?test"?\.primebrick_database_patches/.test(t) || /primebrick_database_patches[\s\S]*VALUES/.test(t)) {
      const [patch_name, content_sha256, status, signed_key_id, duration_ms, error, applied_by, atomic] = params as any[];
      const prev = this.registry.get(patch_name);
      this.registry.set(patch_name, {
        patch_name, content_sha256, status, signed_key_id,
        attempts: (prev?.attempts as number ?? 0) + 1,
        duration_ms, error, applied_by, atomic,
        applied_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      return { rows: [], rowCount: 0 };
    }

    // patch body execution — failOn keyed by a marker string inside the SQL
    for (const [marker, msg] of Object.entries(this.failOn)) {
      if (msg && t.includes(marker)) {
        if (this.throwOnce.has(marker)) { this.throwOnce.delete(marker); continue; }
        throw new Error(msg);
      }
    }
    return { rows: [], rowCount: 0 };
  }

  release() { this.released = true; }
  released = false;
}

function fakePool(client: FakeClient) {
  return { connect: async () => client as unknown as PoolClient } as any;
}

// ─── fixtures ───────────────────────────────────────────────────────────────

let dir: string;
let patchesDir: string;
let keys: { pub: string; priv: string };
let second: { pub: string; priv: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pbe-mig-"));
  patchesDir = join(dir, "patches");
  mkdirSync(patchesDir, { recursive: true });
  const a = generateKeyPairSync("ed25519");
  keys = {
    pub: a.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    priv: a.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
  const b = generateKeyPairSync("ed25519");
  second = {
    pub: b.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    priv: b.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writePatch(name: string, sql: string, pragma = "") {
  writeFileSync(join(patchesDir, `${name}.sql`), `${pragma}${pragma ? "\n" : ""}${sql}`);
}

async function shaOf(name: string) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(readFileSync(join(patchesDir, `${name}.sql`), "utf8")).digest("hex");
}

async function writeManifestAndKeys(names: string[], keyId = "dev-key", trust: "dev" | "release" = "dev", priv = keys.priv, sign = true) {
  const patches: Record<string, string> = {};
  for (const n of names) patches[n] = await shaOf(n);
  const unsigned = { version: 1 as const, key_id: keyId, issued_at: new Date().toISOString(), patches };
  const manifest: PatchManifest = sign ? signManifest(unsigned, priv) : ({ ...unsigned, signature: "AA==" } as PatchManifest);
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "keys.json"), JSON.stringify([
    { key_id: "dev-key", algo: "ed25519", public_key: keys.pub, trust: "dev" },
    { key_id: "rel-key", algo: "ed25519", public_key: second.pub, trust: "release" },
  ]));
}

function opts(client: FakeClient, extra: Record<string, unknown> = {}) {
  const logs: { level: string; msg: string }[] = [];
  const logger = {
    info: (m: string) => logs.push({ level: "info", msg: m }),
    warn: (m: string) => logs.push({ level: "warn", msg: m }),
    error: (m: string) => logs.push({ level: "error", msg: m }),
  };
  return {
    options: {
      pool: fakePool(client),
      schema: "test",
      patchesDir,
      dbMetaDir: dir,
      allowedTrust: ["dev", "release"] as const,
      logger,
      ...extra,
    } as any,
    logs,
  };
}

// ─── matrix ─────────────────────────────────────────────────────────────────

describe("migrations engine", () => {
  it("1. happy path: applies pending patches in filename order, registry row inside tx", async () => {
    writePatch("20260101000000_a", "CREATE TABLE t1(id int);");
    writePatch("20260101000001_b", "CREATE TABLE t2(id int);");
    writePatch("20260101000002_c", "CREATE TABLE t3(id int);");
    await writeManifestAndKeys(["20260101000000_a", "20260101000001_b", "20260101000002_c"]);

    const client = new FakeClient();
    const { options, logs } = opts(client);
    const res = await runMigrations(options);

    expect(res.applied).toEqual(["20260101000000_a", "20260101000001_b", "20260101000002_c"]);
    expect(res.degraded).toBe(false);

    // registry INSERT executed inside the patch transaction
    for (const name of res.applied) {
      const patchSql = client.queries.findIndex((q) => q.text.includes(`CREATE TABLE`));
      const ins = client.queries.findIndex((q) => q.params?.[0] === name);
      expect(ins).toBeGreaterThan(-1);
      expect(client.queries[ins]!.inTx).toBe(true);
      void patchSql;
    }
    expect(client.registry.size).toBe(3);
    expect(logs.filter((l) => l.level === "info").length).toBeGreaterThanOrEqual(3);
  });

  it("2. mid-apply failure rolls back; restart resumes at the failed patch", async () => {
    writePatch("20260101000000_a", "CREATE TABLE t1(id int);");
    writePatch("20260101000001_boom", "ALTER TABLE t1 ADD boom_col int; -- BOOM");
    writePatch("20260101000002_c", "CREATE TABLE t3(id int);");
    await writeManifestAndKeys(["20260101000000_a", "20260101000001_boom", "20260101000002_c"]);

    // run 1: boom fails critically
    const c1 = new FakeClient();
    c1.failOn = { boom_col: "syntax error at or near boom" };
    const r1 = await runMigrations(opts(c1).options);
    expect(r1.applied).toEqual(["20260101000000_a"]);
    expect(r1.degraded).toBe(true);
    expect(r1.failed[0]!.patch_name).toBe("20260101000001_boom");
    // c must NOT have been attempted (ordering stops)
    expect(c1.queries.some((q) => q.text.includes("t3"))).toBe(false);
    expect(c1.registry.get("20260101000001_boom")!.status).toBe("failed");

    // run 2: same client registry (persisted), boom now works → resume from failed
    const c2 = new FakeClient();
    c2.registry = c1.registry;
    const r2 = await runMigrations(opts(c2).options);
    expect(r2.applied).toEqual(["20260101000001_boom", "20260101000002_c"]);
    expect(c2.registry.get("20260101000001_boom")!.attempts).toBe(2);
  });

  it("3. any patch failure → degraded=true and ordering stops (all patches are required)", async () => {
    writePatch("20260101000000_a", "SELECT FAILME;");
    writePatch("20260101000001_b", "CREATE TABLE t2(id int);");
    await writeManifestAndKeys(["20260101000000_a", "20260101000001_b"]);
    const c = new FakeClient();
    c.failOn = { FAILME: "division by zero" };
    const res = await runMigrations(opts(c).options);
    expect(res.degraded).toBe(true);
    expect(res.failed).toHaveLength(1);
    // later patch never attempted — chronological ordering is total
    expect(c.queries.some((q) => q.text.includes("t2"))).toBe(false);
  });

  it("5. applied patch with different sha → refuse all (immutability)", async () => {
    writePatch("20260101000000_a", "CREATE TABLE t1(id int);");
    await writeManifestAndKeys(["20260101000000_a"]);
    const c1 = new FakeClient();
    await runMigrations(opts(c1).options);

    // tamper with file + re-sign manifest
    writePatch("20260101000000_a", "CREATE TABLE t1(id int); SELECT 1;");
    await writeManifestAndKeys(["20260101000000_a"]);

    const c2 = new FakeClient();
    c2.registry = c1.registry;
    await expect(runMigrations(opts(c2).options)).rejects.toThrow(/immutable/);
  });

  it("6. unknown patch file (not in manifest) → refused", async () => {
    writePatch("20260101000000_a", "CREATE TABLE t1(id int);");
    writePatch("20260101000001_evil", "DROP SCHEMA public CASCADE;");
    await writeManifestAndKeys(["20260101000000_a"]); // evil not listed
    const c = new FakeClient();
    const o = opts(c);
    await expect(runMigrations(o.options)).rejects.toThrow(/not in MANIFEST/);
    expect(c.queries.some((q) => q.text.includes("DROP SCHEMA"))).toBe(false);
  });

  it("7. bad manifest signature → refuse all", async () => {
    writePatch("20260101000000_a", "CREATE TABLE t1(id int);");
    await writeManifestAndKeys(["20260101000000_a"], "dev-key", "dev", keys.priv, false);
    const c = new FakeClient();
    await expect(runMigrations(opts(c).options)).rejects.toThrow(/signature/);
  });

  it("7b. manifest signed by untrusted key_id → refused", async () => {
    writePatch("20260101000000_a", "CREATE TABLE t1(id int);");
    // sign with a key whose id is not in keyring
    const a = generateKeyPairSync("ed25519");
    const roguePriv = a.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    await writeManifestAndKeys(["20260101000000_a"], "rogue", "dev", roguePriv);
    const c = new FakeClient();
    await expect(runMigrations(opts(c).options)).rejects.toThrow(/not in trusted keyring/);
  });

  it("8. requires-review → pending_review gate stops ordering; approval applies it", async () => {
    writePatch("20260101000000_a", "CREATE TABLE t1(id int);", "-- pb:requires-review");
    writePatch("20260101000001_b", "CREATE TABLE t2(id int);");
    await writeManifestAndKeys(["20260101000000_a", "20260101000001_b"]);

    const c1 = new FakeClient();
    const r1 = await runMigrations(opts(c1).options);
    expect(r1.pendingReview).toEqual(["20260101000000_a"]);
    expect(r1.applied).toEqual([]); // gate blocks everything (a is first)
    expect(r1.degraded).toBe(true); // schema incomplete → degraded, not a free pass
    expect(c1.registry.get("20260101000000_a")!.status).toBe("pending_review");

    const c2 = new FakeClient();
    c2.registry = c1.registry;
    const r2 = await runMigrations(opts(c2, { approvedReviews: ["20260101000000_a"] }).options);
    expect(r2.applied).toEqual(["20260101000000_a", "20260101000001_b"]);
  });

  it("9. advisory lock contention → clear error, client released", async () => {
    writePatch("20260101000000_a", "CREATE TABLE t1(id int);");
    await writeManifestAndKeys(["20260101000000_a"]);
    const c = new FakeClient();
    c.lockFree = false;
    await expect(runMigrations(opts(c, { lockWaitMs: 50 }).options)).rejects.toThrow(/advisory lock/);
    expect(c.released).toBe(true);
  });

  it("10. no-transaction patch: statements run autocommit, atomic=false", async () => {
    writePatch(
      "20260101000000_idx",
      "CREATE INDEX CONCURRENTLY a ON t(x); CREATE INDEX CONCURRENTLY b ON t(y);",
      "-- pb:no-transaction"
    );
    await writeManifestAndKeys(["20260101000000_idx"]);
    const c = new FakeClient();
    const res = await runMigrations(opts(c).options);
    expect(res.applied).toEqual(["20260101000000_idx"]);
    // registry insert runs in its own mini-tx; the DDL statements are autocommit
    const idx = c.queries.filter((q) => q.text.includes("CREATE INDEX CONCURRENTLY"));
    expect(idx).toHaveLength(2);
    expect(idx.every((q) => q.inTx === false)).toBe(true);
    expect(c.registry.get("20260101000000_idx")!.atomic).toBe(false);
  });

  it("10b. segmented patch: tx part in tx, notx part autocommit", async () => {
    writePatch(
      "20260101000000_mix",
      `ALTER TABLE t ADD COLUMN x int;
-- pb:begin-no-transaction
CREATE INDEX CONCURRENTLY i ON t(x);
-- pb:end-no-transaction
ALTER TABLE t ADD COLUMN y int;`
    );
    await writeManifestAndKeys(["20260101000000_mix"]);
    const c = new FakeClient();
    const res = await runMigrations(opts(c).options);
    expect(res.applied).toEqual(["20260101000000_mix"]);
    const ddl = c.queries.filter((q) => /ALTER TABLE|CREATE INDEX/.test(q.text));
    expect(ddl.find((q) => q.text.includes("ADD COLUMN x"))!.inTx).toBe(true);
    expect(ddl.find((q) => q.text.includes("CONCURRENTLY"))!.inTx).toBe(false);
    expect(ddl.find((q) => q.text.includes("ADD COLUMN y"))!.inTx).toBe(true);
    expect(c.registry.get("20260101000000_mix")!.atomic).toBe(false);
  });

  it("11. mode=check does not apply but reports; mode=off skips", async () => {
    writePatch("20260101000000_a", "CREATE TABLE t1(id int);");
    await writeManifestAndKeys(["20260101000000_a"]);

    const cCheck = new FakeClient();
    cCheck.configEntries = { "db_migration.mode": "check" };
    const o1 = opts(cCheck);
    const r1 = await runMigrations(o1.options);
    expect(r1.mode).toBe("check");
    expect(r1.applied).toEqual([]);
    expect(o1.logs.some((l) => l.msg.includes("pending patch"))).toBe(true);

    const cOff = new FakeClient();
    cOff.configEntries = { "db_migration.mode": "off" };
    const r2 = await runMigrations(opts(cOff).options);
    expect(r2.mode).toBe("off");
    expect(cOff.queries.some((q) => q.text.includes("CREATE TABLE t1"))).toBe(false);
  });

  it("12. mode key changed by an applied patch → nextMode reflects re-read", async () => {
    writePatch("20260101000000_a", "CREATE TABLE t1(id int);");
    await writeManifestAndKeys(["20260101000000_a"]);
    const c = new FakeClient();
    // mode flips to 'check' after the patch applies
    const origQuery = c.query.bind(c);
    c.query = async (t: string, p?: unknown[]) => {
      const r = await origQuery(t, p);
      if (/CREATE TABLE t1/.test(t)) c.configEntries = { "db_migration.mode": "check" };
      return r;
    };
    const res = await runMigrations(opts(c).options);
    expect(res.nextMode).toBe("check");
  });

  it("13. empty-DB bootstrap: no config table → default apply", async () => {
    writePatch("20260101000000_a", "CREATE TABLE t1(id int);");
    await writeManifestAndKeys(["20260101000000_a"]);
    const c = new FakeClient();
    c.configEntries = null; // table does not exist
    const res = await runMigrations(opts(c).options);
    expect(res.mode).toBe("apply");
    expect(res.applied).toEqual(["20260101000000_a"]);
  });

  it("missing manifest with patches present → refuse (fail-closed)", async () => {
    writePatch("20260101000000_a", "CREATE TABLE t1(id int);");
    writeFileSync(join(dir, "keys.json"), "[]");
    const c = new FakeClient();
    await expect(runMigrations(opts(c).options)).rejects.toThrow(/MANIFEST/);
  });

  it("no patches → clean no-op without manifest", async () => {
    const c = new FakeClient();
    const res = await runMigrations(opts(c).options);
    expect(res.applied).toEqual([]);
    expect(res.degraded).toBe(false);
  });

  it("parsePatchPragmas reads the header contract", () => {
    expect(parsePatchPragmas("-- pb:requires-review\n-- pb:no-transaction\nSQL")).toEqual({
      requiresReview: true, noTransaction: true,
    });
    expect(parsePatchPragmas("SELECT 1;")).toEqual({
      requiresReview: false, noTransaction: false,
    });
  });

  it("splitSqlStatements handles $$ bodies, strings and comments", () => {
    const sql = `
      CREATE FUNCTION f() RETURNS int AS $$
      BEGIN RETURN 1; END;
      $$ LANGUAGE plpgsql;
      -- comment with ; inside
      SELECT 'a;b' AS semi;
      CREATE INDEX CONCURRENTLY x ON t ("a\"b");
    `;
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toContain("plpgsql");
    expect(stmts[1]).toContain("'a;b'");
    expect(stmts[2]).toContain("CREATE INDEX CONCURRENTLY");
  });
});
