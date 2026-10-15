/**
 * Patch emitter v2 — entity intent → SQL with execution sections.
 *
 * Output shape (the engine parses the pragmas):
 *   -- pb:requires-review        ← present iff review-statements exist (gates the file)
 *   safe section                 ← tx-wrapped DDL (CREATE/ADD/partman/indexes on NEW tables)
 *   -- pb:begin-no-transaction   ← CREATE INDEX CONCURRENTLY on EXISTING tables
 *   -- pb:end-no-transaction
 *   review section               ← renames / ALTER TYPE / SET NOT NULL / FK adds on
 *                                  existing tables / index redefinitions — real SQL,
 *                                  runs only after admin approval (pending_review gate)
 *   warnings                     ← DB-only objects, never emitted as DDL
 */

import type { SchemaColumnMeta, SchemaIndexMeta, SchemaTableMeta, SchemaSnapshot } from "./schema-types.js";
import type { SchemaMetaDiffV2 } from "./schema-snapshot.js";

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** Types from DB introspection or entity snapshot (`typname` / inferred TS→PG). */
function entityPgType(col: SchemaColumnMeta): string {
  const t = (col.formatType ?? col.typname ?? col.dataType)?.trim();
  if (t) return t;
  return "text";
}

function columnTypeDdl(col: SchemaColumnMeta): string {
  if (col.isPostgresIdentity) {
    return "bigint generated always as identity";
  }
  return entityPgType(col);
}

function defaultClause(col: SchemaColumnMeta): string {
  if (!col.defaultSql) return "";
  if (col.isPostgresIdentity) return "";
  return ` DEFAULT ${col.defaultSql}`;
}

/** NOT NULL only when explicitly required (PK / UNIQUE / `nullable: false`). */
function nullClause(col: SchemaColumnMeta): string {
  if (col.isNullable === true) return "";
  if (col.isNullable === false) return " NOT NULL";
  if (col.isPrimaryKey || col.isUnique) return " NOT NULL";
  return "";
}

function slugifyIdent(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 63) || "uq";
}

function indexDdl(ix: SchemaIndexMeta, t: { schema: string; name: string }, concurrently: boolean): string {
  const fq = `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;
  const cols = ix.columns.map((c) => (ix.opclass ? `${quoteIdent(c)} ${ix.opclass}` : quoteIdent(c))).join(", ");
  const unique = ix.isUnique ? "UNIQUE " : "";
  const using = ix.using === "btree" ? "" : ` USING ${ix.using}`;
  const where = ix.where ? ` WHERE ${ix.where}` : "";
  const conc = concurrently ? " CONCURRENTLY" : "";
  return `CREATE ${unique}INDEX${conc} IF NOT EXISTS ${quoteIdent(slugifyIdent(ix.name))} ON ${fq}${using} (${cols})${where};`;
}

function fkActionSql(action: string): string {
  const map: Record<string, string> = {
    restrict: "RESTRICT",
    cascade: "CASCADE",
    set_null: "SET NULL",
    set_default: "SET DEFAULT",
    no_action: "NO ACTION",
  };
  return map[action] ?? action.toUpperCase();
}

/** partman wiring for a @PartitionField-declared parent. */
function partitionSetupSql(t: SchemaTableMeta): string[] {
  const p = t.partition!;
  const fq = `${t.schema}.${t.name}`;
  const lines = [
    `SELECT partman.create_parent('${fq}', '${p.column}', 'native', '${p.interval}'${p.premake !== undefined ? `, ${p.premake}` : ""});`,
  ];
  const sets: string[] = [];
  if (p.retention !== undefined) sets.push(`retention = '${p.retention}'`);
  sets.push(`retention_keep_table = ${p.keepTable}`);
  lines.push(`UPDATE partman.part_config SET ${sets.join(", ")} WHERE parent_table = '${fq}';`);
  return lines;
}

/** Full CREATE TABLE block for a new entity table (safe section). */
function createTableSql(t: SchemaTableMeta): string[] {
  const lines: string[] = [];
  const fq = `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;
  const cols = Object.values(t.columns).sort(
    (a, b) => (a.ordinalPosition ?? 9999) - (b.ordinalPosition ?? 9999)
  );
  const parts: string[] = [];
  for (const c of cols) {
    parts.push(`  ${quoteIdent(c.name)} ${columnTypeDdl(c)}${defaultClause(c)}${nullClause(c)}`);
  }
  // PK: @Key columns; partitioned parents must include the partition column
  const pkCols = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
  if (t.partition && !pkCols.includes(t.partition.column)) pkCols.push(t.partition.column);
  if (pkCols.length) parts.push(`  PRIMARY KEY (${pkCols.map(quoteIdent).join(", ")})`);
  // composite uniques → table-level UNIQUE groups (single-col uniques get indexes instead)
  const groups = new Map<string, { col: string; order: number }[]>();
  for (const c of cols) {
    if (!c.isUnique || c.isPrimaryKey) continue;
    const name = `${t.name}_uq`; // group key for constraint emission — named via uniqueIndexName if present
    const key = (c as { uniqueIndexName?: string }).uniqueIndexName ?? `${name}_${c.name}`;
    const g = groups.get(key) ?? [];
    g.push({ col: c.name, order: (c as { uniqueIndexOrder?: number }).uniqueIndexOrder ?? 0 });
    groups.set(key, g);
  }
  for (const [gname, gcols] of groups) {
    if (gcols.length > 1) {
      const ordered = gcols.sort((a, b) => a.order - b.order).map((c) => quoteIdent(c.col));
      parts.push(`  CONSTRAINT ${quoteIdent(slugifyIdent(gname))} UNIQUE (${ordered.join(", ")})`);
    }
  }
  // FKs inline on new tables
  for (const f of t.foreignKeys ?? []) {
    parts.push(
      `  CONSTRAINT ${quoteIdent(slugifyIdent(f.name))} FOREIGN KEY (${quoteIdent(f.column)})` +
        ` REFERENCES ${quoteIdent(f.refSchema)}.${quoteIdent(f.refTable)} (${quoteIdent(f.refColumn)})` +
        ` ON DELETE ${fkActionSql(f.onDelete)} ON UPDATE ${fkActionSql(f.onUpdate)}`
    );
  }
  const partitioned = Boolean(t.partition);
  lines.push(`CREATE TABLE IF NOT EXISTS ${fq} (`);
  lines.push(parts.join(",\n"));
  lines.push(`)${partitioned ? ` PARTITION BY RANGE (${quoteIdent(t.partition!.column)})` : ""};`);
  return lines;
}

/**
 * Best-effort SQL to move **TARGET database** toward **entity** intent.
 * Destructive changes (DROP) are never emitted — DB-only objects are WARN comments.
 */
export function buildSqlPatchFromMetaDiff(entitySnap: SchemaSnapshot, diff: SchemaMetaDiffV2): string {
  const safe: string[] = [];
  const notx: string[] = [];
  const review: string[] = [];
  const warns: string[] = [];

  // UUID default providers: ensure required extension exists when using defaultSql.
  const needsPgcrypto = Object.values(entitySnap.tables).some((t) =>
    Object.values(t.columns).some((c) => c.defaultSql?.includes("gen_random_uuid()"))
  );
  const needsUuidOssp = Object.values(entitySnap.tables).some((t) =>
    Object.values(t.columns).some((c) => c.defaultSql?.includes("uuid_generate_v4()"))
  );
  if (needsPgcrypto) safe.push('CREATE EXTENSION IF NOT EXISTS "pgcrypto";', "");
  else if (needsUuidOssp) safe.push('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";', "");

  // ── new tables (safe section) ────────────────────────────────────────
  for (const tableKey of diff.onlyInEntityTables) {
    const t = entitySnap.tables[tableKey];
    if (!t) continue;
    const fq = `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;

    // schema itself
    if (t.schema !== "public") {
      safe.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(t.schema)};`, "");
    }
    safe.push(...createTableSql(t), "");

    // @PartitionField → pg_partman parent
    if (t.partition) {
      safe.push(...partitionSetupSql(t), "");
    }

    // indexes (new table → plain CREATE INDEX, always fast on empty tables).
    // Unique groups are already emitted as UNIQUE constraints / *_uq indexes below.
    for (const ix of t.indexes ?? []) {
      if (ix.isUnique) continue;
      safe.push(indexDdl(ix, t, false));
    }
    // single-column uniques not covered by composite UNIQUE constraints
    const grouped = new Set<string>();
    for (const ix of t.indexes ?? []) {
      if (ix.isUnique && ix.columns.length > 1) for (const c of ix.columns) grouped.add(c);
    }
    for (const c of cols_sorted(t)) {
      if (c.isUnique && !c.isPrimaryKey && !grouped.has(c.name)) {
        const ix = slugifyIdent(`${t.name}_${c.name}_uq`);
        safe.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(ix)} ON ${fq} (${quoteIdent(c.name)});`);
      }
    }
    safe.push("");

    // audit table + monthly partman partitioning (fixed shape)
    if (t.isAuditable) {
      const auditTableName = `${t.name}_audit`;
      const fqAudit = `${quoteIdent(t.schema)}.${quoteIdent(auditTableName)}`;
      safe.push(
        `CREATE TABLE IF NOT EXISTS ${fqAudit} (`,
        `  "id" bigint generated always as identity NOT NULL,`,
        `  "entity_id" bigint NOT NULL,`,
        `  "entity_uuid" uuid NOT NULL,`,
        `  "action" text NOT NULL,`,
        `  "changed_at" timestamptz NOT NULL,`,
        `  "changed_by" text NOT NULL DEFAULT 'system',`,
        `  "version" integer NOT NULL,`,
        `  "delta" jsonb NOT NULL,`,
        `  PRIMARY KEY ("id")`,
        `);`,
        "",
        `SELECT partman.create_parent('${fqAudit}', 'changed_at', 'native', 'monthly');`,
        "",
        `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${auditTableName}_entity_uuid_idx`)} ON ${fqAudit} ("entity_uuid");`,
        `CREATE INDEX IF NOT EXISTS ${quoteIdent(`${auditTableName}_action_idx`)} ON ${fqAudit} ("action");`,
        ""
      );
    }
  }

  // ── existing tables ──────────────────────────────────────────────────
  for (const [tableKey, tab] of Object.entries(diff.tables)) {
    const tmeta = entitySnap.tables[tableKey];
    if (!tmeta) continue;
    const fq = `${quoteIdent(tmeta.schema)}.${quoteIdent(tmeta.name)}`;
    const tableReview = Boolean(tab.renameHeuristicUserReviewRequired);

    for (const col of tab.onlyInEntityColumns) {
      const cmeta = tmeta.columns[col];
      if (!cmeta) continue;
      const typeSql = columnTypeDdl(cmeta);
      const def = defaultClause(cmeta);
      const nn = nullClause(cmeta);
      safe.push(`ALTER TABLE ${fq} ADD COLUMN IF NOT EXISTS ${quoteIdent(col)} ${typeSql}${def}${nn};`);
      if (cmeta.isPrimaryKey) {
        warns.push(`-- WARN: PK column "${col}" added; ensure table/backfill before relying on NOT NULL + PK`);
      }
    }

    // new indexes on existing tables → CONCURRENTLY in the no-transaction segment
    for (const name of tab.onlyInEntityIndexes) {
      const ix = (tmeta.indexes ?? []).find((i) => i.name === name);
      if (!ix) continue;
      notx.push(indexDdl(ix, tmeta, true));
    }

    if (tab.likelyRenames.length > 0) {
      review.push("");
      if (tableReview || diff.renameHeuristicUserReviewRequired) {
        review.push("/* Heuristic RENAME — ambiguity detected; uncomment after choice:");
        for (const r of tab.likelyRenames) review.push(`-- ${r.suggestedSql}`);
        review.push("*/");
      } else {
        review.push("-- Heuristic renames (no ambiguity flag on this table):");
        for (const r of tab.likelyRenames) review.push(r.suggestedSql);
      }
      review.push("");
    }

    for (const m of tab.typeMismatches) {
      const target = entityPgType(tmeta.columns[m.column] ?? { name: m.column });
      review.push(
        `-- REVIEW type change "${m.column}" entity≈${m.entityComparable} db≈${m.databaseComparable} (may rewrite the table)`,
        `ALTER TABLE ${fq} ALTER COLUMN ${quoteIdent(m.column)} TYPE ${target};`
      );
    }
    for (const m of tab.nullabilityMismatches) {
      const op = m.entityNullable === false ? "SET NOT NULL" : "DROP NOT NULL";
      review.push(
        `-- REVIEW nullability "${m.column}" entity=${m.entityNullable} db=${m.databaseNullable} (SET NOT NULL fails on existing NULLs)`,
        `ALTER TABLE ${fq} ALTER COLUMN ${quoteIdent(m.column)} ${op};`
      );
    }

    // index redefinitions: same name, different definition → DROP + CREATE (review)
    for (const m of tab.indexMismatches) {
      const ix = (tmeta.indexes ?? []).find((i) => i.name === m.name);
      if (!ix) continue;
      review.push(
        `-- REVIEW index "${m.name}" redefined (entity using=${m.entityUsing} cols=${m.entityColumns.join(",")} vs db using=${m.databaseUsing} cols=${m.databaseColumns.join(",")})`,
        `DROP INDEX IF EXISTS ${quoteIdent(tmeta.schema)}.${quoteIdent(m.name)};`,
        indexDdl(ix, tmeta, false)
      );
    }

    // FK adds on existing tables → review
    for (const name of tab.onlyInEntityForeignKeys) {
      const f = (tmeta.foreignKeys ?? []).find((x) => x.name === name);
      if (!f) continue;
      review.push(
        `-- REVIEW new foreign key "${name}" on existing table`,
        `ALTER TABLE ${fq} ADD CONSTRAINT ${quoteIdent(slugifyIdent(f.name))} FOREIGN KEY (${quoteIdent(f.column)})` +
          ` REFERENCES ${quoteIdent(f.refSchema)}.${quoteIdent(f.refTable)} (${quoteIdent(f.refColumn)})` +
          ` ON DELETE ${fkActionSql(f.onDelete)} ON UPDATE ${fkActionSql(f.onUpdate)};`
      );
    }

    for (const col of tab.onlyInDatabaseColumns) {
      warns.push(`-- WARN: DB-only column "${col}" on ${tableKey} — not dropped`);
    }
    for (const name of tab.onlyInDatabaseIndexes) {
      warns.push(`-- WARN: DB-only index "${name}" on ${tableKey} — not dropped`);
    }
    for (const name of tab.onlyInDatabaseForeignKeys) {
      warns.push(`-- WARN: DB-only foreign key "${name}" on ${tableKey} — not dropped`);
    }
  }

  for (const tableKey of diff.onlyInDatabaseTables) {
    warns.push(`-- WARN: table only in database: ${tableKey} — not dropped`);
  }

  // ── assemble with section pragmas ────────────────────────────────────
  const header: string[] = ["-- Primebrick: entity → database patch"];
  const hasReview =
    review.length > 0 || diff.renameHeuristicUserReviewRequired === true;
  if (hasReview) header.push("-- pb:requires-review");
  if (notx.length) header.push("-- pb:segments");
  header.push(`-- generatedAt: ${diff.generatedAt}`, "");
  if (diff.renameHeuristicUserReviewRequired) {
    header.push("-- WARN: renameHeuristicUserReviewRequired — ambiguous renames commented below; resolve before approval.", "");
  }

  const out = [...header, ...safe];
  if (notx.length) {
    out.push("-- pb:begin-no-transaction", ...notx, "-- pb:end-no-transaction", "");
  }
  if (review.length) {
    out.push("-- ── review section (runs only after approval) ──", ...review, "");
  }
  if (warns.length) out.push(...warns);

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function cols_sorted(t: SchemaTableMeta): SchemaColumnMeta[] {
  return Object.values(t.columns).sort(
    (a, b) => (a.ordinalPosition ?? 9999) - (b.ordinalPosition ?? 9999)
  );
}
