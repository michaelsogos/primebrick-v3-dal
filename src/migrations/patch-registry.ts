/**
 * Per-service-schema patch registry (v2).
 *
 * Each service owns `<svc_schema>.primebrick_database_patches` — the registry is
 * domain data of the owning microservice, not a shared global table.
 * The DDL is self-bootstrapping: the engine runs it unconditionally before any
 * read, so an empty database upgrades itself.
 */

export const PATCH_REGISTRY_TABLE = "primebrick_database_patches";

export type PatchStatus =
  | "pending"
  | "applied"
  | "failed"
  | "pending_review"
  | "approved"
  | "resolved_manual";

export type PatchRegistryRow = {
  patch_name: string;
  content_sha256: string;
  status: PatchStatus;
  signed_key_id: string | null;
  attempts: number;
  duration_ms: number | null;
  error: string | null;
  applied_by: string | null;
  resolved_by: string | null;
  resolved_note: string | null;
  atomic: boolean;
  applied_at: string;
  updated_at: string;
};

export function patchRegistryDdl(schema: string): string {
  const fq = `"${schema}".${PATCH_REGISTRY_TABLE}`;
  return `CREATE SCHEMA IF NOT EXISTS "${schema}";
CREATE TABLE IF NOT EXISTS ${fq} (
  patch_name     text PRIMARY KEY,
  content_sha256 text NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  signed_key_id  text,
  attempts       int  NOT NULL DEFAULT 0,
  duration_ms    int,
  error          text,
  applied_by     text,
  resolved_by    text,
  resolved_note  text,
  atomic         boolean NOT NULL DEFAULT true,
  applied_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS primebrick_database_patches_status_idx
  ON ${fq} (status);
ALTER TABLE ${fq} DROP COLUMN IF EXISTS severity;
`;
}
