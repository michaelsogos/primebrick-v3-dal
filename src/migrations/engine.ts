/**
 * Migration engine — the apply side of the Primebrick DB migration system.
 *
 * Runs inside the owning microservice at boot (createMicroservice step 2.5):
 * dedicated connection, advisory lock, manifest-verified patch files,
 * per-patch atomicity (registry row in the SAME transaction as the DDL),
 * per-schema registry (v2). Every patch is required: any failure or a
 * review gate degrades the service (domain routes 503 until remediated).
 *
 * Guarantees:
 * - one reserved client for BEGIN/patch/registry/COMMIT — a patch is
 *   applied-and-registered atomically, or not at all;
 * - pg advisory lock is session-scoped — a crash releases it, no zombies;
 * - ordering is total (filename sort) — the runner stops at the first
 *   blocking failure or `pending_review` gate;
 * - provenance: only manifest-listed files whose sha matches are eligible.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Pool, PoolClient } from "pg";

import type { LoggerPort } from "../types/types.js";
import { normalizePatchEol, patchNameFromFilename, sha256Hex } from "../schema-diff/patch-naming.js";
import {
  loadKeyring,
  loadManifest,
  manifestPaths,
  verifyManifest,
  ManifestError,
  type PatchManifest,
  type TrustedKey,
} from "./manifest.js";
import {
  patchRegistryDdl,
  PATCH_REGISTRY_TABLE,
  type PatchRegistryRow,
} from "./patch-registry.js";
import { parsePatchSegments, splitSqlStatements, stripTxControl, isTxControlStatement } from "./sql-splitter.js";

export type MigrationMode = "apply" | "check" | "off";

export type MigrationEngineOptions = {
  pool: Pool;
  /** Owning service schema — registry lives at <schema>.primebrick_database_patches. */
  schema: string;
  /** Directory containing the .sql patch files (usually db-meta/patches). */
  patchesDir: string;
  /** db-meta dir holding MANIFEST.json + keys.json — defaults to dirname(patchesDir). */
  dbMetaDir?: string;
  /** Trust levels accepted for the manifest signature. Default ["release"]. */
  allowedTrust?: readonly ("release" | "dev")[];
  /** Patches the admin approved via db-migration-apply-review (names, no .sql). */
  approvedReviews?: readonly string[];
  /** applied_by stamp — service instance id or admin user uuid. */
  actor?: string;
  /** Max ms to wait for the advisory lock. Default 30_000. */
  lockWaitMs?: number;
  logger?: LoggerPort;
};

export type MigrationRunResult = {
  mode: MigrationMode;
  /** Config value re-read AFTER applying (a patch may have changed it). */
  nextMode?: string;
  degraded: boolean;
  applied: string[];
  failed: { patch_name: string; error: string }[];
  pendingReview: string[];
  skipped: string[];
  securityEvents: string[];
};

type PatchFile = {
  filename: string;
  patchName: string;
  raw: string;
  /** Canonical hash (EOL-normalized) — manifest + new registry rows. */
  sha256: string;
  /** Raw-bytes hash — accepted at the registry for pre-normalization rows. */
  sha256Raw: string;
  requiresReview: boolean;
  noTransaction: boolean;
};

const noopLogger: LoggerPort = { error() {}, warn() {}, info() {} };

/** Parse the `-- pb:*` pragma header of a patch file. */
export function parsePatchPragmas(raw: string): {
  requiresReview: boolean;
  noTransaction: boolean;
} {
  let requiresReview = false;
  let noTransaction = false;
  for (const line of raw.split("\n").slice(0, 40)) {
    const m = /^\s*--\s*pb:([a-z-]+)(?:\s+(\S+))?/.exec(line);
    if (!m) continue;
    if (m[1] === "requires-review") requiresReview = true;
    if (m[1] === "no-transaction") noTransaction = true;
  }
  return { requiresReview, noTransaction };
}

function listPatchFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}

async function readMode(client: PoolClient, schema: string): Promise<string | undefined> {
  const reg = await client.query<{ oid: string | null }>(
    `SELECT to_regclass($1)::text AS oid`,
    [`${schema}.config_entries`]
  );
  if (!reg.rows[0]?.oid) return undefined;
  const r = await client.query<{ value: string }>(
    `SELECT value FROM "${schema}".config_entries WHERE key = 'db_migration.mode' LIMIT 1`
  );
  return r.rows[0]?.value;
}

async function acquireAdvisoryLock(
  client: PoolClient,
  schema: string,
  waitMs: number,
  logger: LoggerPort
): Promise<boolean> {
  // DB-scoped, one lock only → no lock-ordering, no deadlock possible.
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('primebrick:migrate:' || $1)) AS locked`,
      [schema]
    );
    if (r.rows[0]?.locked) return true;
    if (Date.now() >= deadline) return false;
    logger.warn("migration advisory lock held by another process — waiting");
    await new Promise((res) => setTimeout(res, 1000));
  }
}

export async function runMigrations(opts: MigrationEngineOptions): Promise<MigrationRunResult> {
  const logger = opts.logger ?? noopLogger;
  const schema = opts.schema;
  const registryFq = `"${schema}".${PATCH_REGISTRY_TABLE}`;
  const result: MigrationRunResult = {
    mode: "apply",
    degraded: false,
    applied: [],
    failed: [],
    pendingReview: [],
    skipped: [],
    securityEvents: [],
  };

  const filenames = listPatchFiles(opts.patchesDir);
  const client = await opts.pool.connect();
  try {
    // ── registry self-bootstrap ──────────────────────────────────────────
    await client.query(patchRegistryDdl(schema));

    // ── mode (config_entries — DB, not env; to_regclass-guarded) ─────────
    const rawMode = await readMode(client, schema);
    const mode: MigrationMode =
      rawMode === "check" || rawMode === "off" ? rawMode : "apply";
    result.mode = mode;

    if (filenames.length === 0) {
      logger.info("db-migration: no patch files — nothing to do", {});
      return result;
    }
    if (mode === "off") {
      logger.info("db-migration: mode=off — skipping", {});
      return result;
    }

    // ── manifest provenance gate ─────────────────────────────────────────
    const dbMetaDir = opts.dbMetaDir ?? dirname(opts.patchesDir);
    const { manifestPath, keysPath } = manifestPaths(dbMetaDir);
    const manifest = loadManifest(manifestPath);
    let signingKey: TrustedKey | undefined;
    if (!manifest) {
      result.securityEvents.push("manifest_missing");
      throw new Error(
        `db-migration: ${filenames.length} patch file(s) present but ${MANIFEST_MISSING(manifestPath)} — refusing (fail-closed)`
      );
    }
    try {
      signingKey = verifyManifest(manifest, loadKeyring(keysPath), opts.allowedTrust ?? ["release"]);
    } catch (e) {
      result.securityEvents.push(e instanceof ManifestError ? e.code : "manifest_error");
      throw e;
    }

    const files: PatchFile[] = [];
    for (const filename of filenames) {
      const raw = readFileSync(join(opts.patchesDir, filename), "utf8");
      const patchName = patchNameFromFilename(filename);
      const sha = sha256Hex(normalizePatchEol(raw));
      const shaRaw = sha256Hex(raw);
      const declared = manifest.patches[patchName];
      if (declared === undefined) {
        result.securityEvents.push(`patch_unknown:${patchName}`);
        throw new Error(`db-migration: ${filename} is not in MANIFEST.json — refusing (fail-closed)`);
      }
      if (declared !== sha) {
        result.securityEvents.push(`patch_sha_mismatch:${patchName}`);
        throw new Error(`db-migration: ${filename} content sha256 ≠ manifest — refusing (fail-closed)`);
      }
      files.push({ filename, patchName, raw, sha256: sha, sha256Raw: shaRaw, ...parsePatchPragmas(raw) });
    }

    // ── registry prefetch (ONE query, in-memory map) ─────────────────────
    const regRows = await client.query<PatchRegistryRow>(
      `SELECT patch_name, content_sha256, status, signed_key_id, attempts,
              duration_ms, error, applied_by, resolved_by, resolved_note, atomic,
              applied_at, updated_at
         FROM ${registryFq}`
    );
    const byName = new Map(regRows.rows.map((r) => [r.patch_name, r]));

    // immutability: an applied patch whose content changed → refuse everything
    for (const f of files) {
      const row = byName.get(f.patchName);
      if (
        row &&
        (row.status === "applied" || row.status === "resolved_manual") &&
        row.content_sha256 !== f.sha256 &&
        row.content_sha256 !== f.sha256Raw
      ) {
        throw new Error(
          `db-migration: ${f.filename} is registered as ${row.status} with a different sha256 — immutable patch changed, refusing`
        );
      }
    }

    if (mode === "check") {
      const pending = files.filter((f) => {
        const r = byName.get(f.patchName);
        return !r || (r.status !== "applied" && r.status !== "resolved_manual");
      });
      if (pending.length) {
        logger.warn(`db-migration: mode=check — ${pending.length} pending patch(es) NOT applied: ${pending.map((p) => p.patchName).join(", ")}`);
      } else {
        logger.info("db-migration: mode=check — no pending patches", {});
      }
      return result;
    }

    // ── advisory lock ────────────────────────────────────────────────────
    const locked = await acquireAdvisoryLock(client, schema, opts.lockWaitMs ?? 30_000, logger);
    if (!locked) throw new Error("db-migration: advisory lock not acquired within wait budget — another migrator running?");

    try {
      await client.query(`SET lock_timeout = '10s'`);
      await client.query(`SET idle_in_transaction_session_timeout = '60s'`);

      for (const f of files) {
        const row = byName.get(f.patchName);
        if (row && (row.status === "applied" || row.status === "resolved_manual")) {
          result.skipped.push(f.patchName);
          continue;
        }
        if (
          f.requiresReview &&
          row?.status !== "approved" &&
          !(opts.approvedReviews ?? []).includes(f.patchName)
        ) {
          await upsertStatus(client, registryFq, f, "pending_review", signingKey, opts.actor);
          result.pendingReview.push(f.patchName);
          result.degraded = true;
          logger.warn(`db-migration: ${f.filename} requires review — schema incomplete, service degraded until an admin approves`);
          break;
        }

        const startedAt = Date.now();
        try {
          const segments = parsePatchSegments(f.raw);
          const atomic = segments.length === 1 && segments[0]!.kind === "tx";
          if (atomic) {
            // strongest form: DDL + registry row in the SAME transaction
            await client.query("BEGIN");
            try {
              await client.query(`SET LOCAL statement_timeout = '5min'`);
              // engine owns the transaction — embedded BEGIN/COMMIT in the
              // file (legacy style) are stripped, not executed
              await client.query(stripTxControl(segments[0]!.sql));
              await upsertStatus(client, registryFq, f, "applied", signingKey, opts.actor, {
                durationMs: Date.now() - startedAt,
                atomic: true,
              });
              await client.query("COMMIT");
            } catch (e) {
              await client.query("ROLLBACK");
              throw e;
            }
          } else {
            // mixed / non-transactional: tx segments in their own tx, notx per-statement
            for (const seg of segments) {
              if (seg.kind === "tx") {
                await client.query("BEGIN");
                try {
                  await client.query(`SET LOCAL statement_timeout = '5min'`);
                  await client.query(stripTxControl(seg.sql));
                  await client.query("COMMIT");
                } catch (e) {
                  await client.query("ROLLBACK");
                  throw e;
                }
              } else {
                for (const stmt of splitSqlStatements(seg.sql)) {
                  if (isTxControlStatement(stmt)) continue;
                  await client.query(stmt);
                }
              }
            }
            // registry insert runs AFTER all segments (its own mini-tx) — the file
            // is inherently non-atomic, so segment DDL must be authored idempotent
            await client.query("BEGIN");
            try {
              await upsertStatus(client, registryFq, f, "applied", signingKey, opts.actor, {
                durationMs: Date.now() - startedAt,
                atomic: false,
              });
              await client.query("COMMIT");
            } catch (e) {
              await client.query("ROLLBACK");
              throw e;
            }
          }
          result.applied.push(f.patchName);
          logger.info(`db-migration: applied ${f.filename} (${Date.now() - startedAt}ms)`);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          // failure marker goes in its OWN transaction — must survive the patch rollback
          await upsertStatus(client, registryFq, f, "failed", signingKey, opts.actor, {
            error: message,
          });
          result.failed.push({ patch_name: f.patchName, error: message });
          logger.error(`db-migration: ${f.filename} failed: ${message}`);
          // every patch is required — any failure degrades and stops ordering
          result.degraded = true;
          break;
        }
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('primebrick:migrate:' || $1))`, [schema]).catch(() => {});
    }

    // ── pre-patch read reload invariant: re-read mode (a patch may have changed it)
    result.nextMode = await readMode(client, schema).catch(() => undefined);
    if (result.nextMode && result.nextMode !== mode) {
      logger.warn(`db-migration: db_migration.mode changed by applied patches → next run mode '${result.nextMode}'`);
    }

    return result;
  } finally {
    client.release();
  }
}

function MANIFEST_MISSING(p: string): string {
  return `no MANIFEST.json at ${p}`;
}

async function upsertStatus(
  client: PoolClient,
  registryFq: string,
  f: PatchFile,
  status: string,
  signingKey: TrustedKey | undefined,
  actor: string | undefined,
  extra?: { error?: string; durationMs?: number; atomic?: boolean }
): Promise<void> {
  await client.query(
    `INSERT INTO ${registryFq}
       (patch_name, content_sha256, status, signed_key_id, attempts,
        duration_ms, error, applied_by, atomic, applied_at, updated_at)
     VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8, now(), now())
     ON CONFLICT (patch_name) DO UPDATE SET
       -- content_sha256 follows the FILE THAT ACTUALLY RAN this attempt —
       -- a failed→fixed retry must overwrite the failed attempt's sha,
       -- otherwise the immutability check refuses every future boot.
       -- Applied rows never reach this upsert (skipped before apply), so
       -- the applied-content invariant is preserved.
       content_sha256 = EXCLUDED.content_sha256,
       status       = EXCLUDED.status,
       signed_key_id= EXCLUDED.signed_key_id,
       attempts     = ${PATCH_REGISTRY_TABLE}.attempts + 1,
       duration_ms  = COALESCE(EXCLUDED.duration_ms, ${PATCH_REGISTRY_TABLE}.duration_ms),
       error        = EXCLUDED.error,
       applied_by   = COALESCE(EXCLUDED.applied_by, ${PATCH_REGISTRY_TABLE}.applied_by),
       atomic       = EXCLUDED.atomic,
       applied_at   = CASE WHEN EXCLUDED.status IN ('applied','resolved_manual')
                           THEN now() ELSE ${PATCH_REGISTRY_TABLE}.applied_at END,
       updated_at   = now()`,
    [
      f.patchName,
      f.sha256,
      status,
      signingKey?.key_id ?? null,
      extra?.durationMs ?? null,
      extra?.error ?? null,
      actor ?? null,
      extra?.atomic ?? !f.noTransaction,
    ]
  );
}
