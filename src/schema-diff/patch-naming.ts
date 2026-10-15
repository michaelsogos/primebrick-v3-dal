import { createHash } from "node:crypto";

import type { SchemaMetaDiffV2 } from "./schema-snapshot.js";

export function utcTimestampForFilename(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

export function slugifyPatchSegment(s: string): string {
  const x = s
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toLowerCase()
    .slice(0, 72);
  return x || "patch";
}

export function patchSlugFromDiff(diff: SchemaMetaDiffV2): string {
  if (diff.onlyInEntityTables.length > 0) {
    return slugifyPatchSegment(`create_${diff.onlyInEntityTables.join("__")}`);
  }
  const alterTables = Object.entries(diff.tables)
    .filter(([, t]) => t.onlyInEntityColumns.length > 0)
    .map(([k]) => k);
  if (alterTables.length > 0) {
    return slugifyPatchSegment(`addcols_${alterTables.join("__")}`);
  }
  const renames = Object.entries(diff.tables).filter(([, t]) => t.likelyRenames.length > 0);
  if (renames.length > 0) {
    return slugifyPatchSegment(`rename_${renames.map(([k]) => k).join("__")}`);
  }
  const drift = Object.entries(diff.tables).filter(
    ([, t]) => t.typeMismatches.length > 0 || t.nullabilityMismatches.length > 0
  );
  if (drift.length > 0) {
    return slugifyPatchSegment(`drift_${drift.map(([k]) => k).join("__")}`);
  }
  return "noop";
}

export function buildPatchFilename(diff: SchemaMetaDiffV2, d = new Date()): string {
  return `${utcTimestampForFilename(d)}_${patchSlugFromDiff(diff)}.sql`;
}

/** The registry identity of a patch is its filename minus the `.sql` extension. */
export function patchNameFromFilename(filename: string): string {
  return filename.replace(/\.sql$/i, "");
}

export function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}
