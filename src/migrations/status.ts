/**
 * Registry status + admin remediation helpers.
 *
 * Read surface for the `db_patch` system module (FE admin page) and the
 * transition helpers behind its retry / approve actions. Transitions are
 * plain UPDATEs on the per-schema registry — the engine's next run picks
 * them up (failed → pending retries, pending_review → approved applies).
 */

import type { Pool } from "pg";
import { PATCH_REGISTRY_TABLE, type PatchRegistryRow } from "./patch-registry.js";

const COLS = `patch_name, content_sha256, status, signed_key_id, attempts,
  duration_ms, error, applied_by, resolved_by, resolved_note, atomic,
  applied_at, updated_at`;

export async function registryStatus(pool: Pool, schema: string): Promise<PatchRegistryRow[]> {
  const fq = `"${schema}".${PATCH_REGISTRY_TABLE}`;
  const reg = await pool.query<{ oid: string | null }>(`SELECT to_regclass($1)::text AS oid`, [
    `${schema}.${PATCH_REGISTRY_TABLE}`,
  ]);
  if (!reg.rows[0]?.oid) return [];
  const r = await pool.query<PatchRegistryRow>(`SELECT ${COLS} FROM ${fq} ORDER BY patch_name`);
  return r.rows;
}

/** failed → pending: next runMigrations retries them (and past them, in order). */
export async function retryFailedPatches(
  pool: Pool,
  schema: string,
  actor?: string
): Promise<number> {
  const fq = `"${schema}".${PATCH_REGISTRY_TABLE}`;
  const r = await pool.query(
    `UPDATE ${fq} SET status='pending', error=NULL, updated_at=now(), resolved_by=$1
       WHERE status='failed'`,
    [actor ?? null]
  );
  return r.rowCount ?? 0;
}

/**
 * pending_review → approved for ONE named patch: the engine treats an
 * `approved` row as review-cleared and applies the file on the next run.
 */
export async function approvePendingReview(
  pool: Pool,
  schema: string,
  patchName: string,
  actor: string,
  note?: string
): Promise<boolean> {
  const fq = `"${schema}".${PATCH_REGISTRY_TABLE}`;
  const r = await pool.query(
    `UPDATE ${fq} SET status='approved', updated_at=now(), resolved_by=$2, resolved_note=$3
       WHERE patch_name=$1 AND status='pending_review'`,
    [patchName, actor, note ?? null]
  );
  return (r.rowCount ?? 0) === 1;
}

/** Operator escape hatch: mark a failed/pending patch as manually resolved. */
export async function resolveManually(
  pool: Pool,
  schema: string,
  patchName: string,
  actor: string,
  note: string
): Promise<boolean> {
  const fq = `"${schema}".${PATCH_REGISTRY_TABLE}`;
  const r = await pool.query(
    `UPDATE ${fq} SET status='resolved_manual', updated_at=now(), resolved_by=$2, resolved_note=$3,
            error=NULL
       WHERE patch_name=$1 AND status IN ('failed','pending','pending_review')`,
    [patchName, actor, note]
  );
  return (r.rowCount ?? 0) === 1;
}
