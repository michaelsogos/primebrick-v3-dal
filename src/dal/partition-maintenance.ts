/**
 * Partition maintenance — the generic pg_partman retention executor.
 *
 * Driven entirely by entity metadata (`@PartitionField` parents,
 * `@PartitionChildOf` children) — no per-entity code anywhere.
 *
 * For every partitioned entity with a retention configured (entity meta is
 * the source of truth; `partman.part_config` must confirm registration):
 *
 *   1. Children purge — set-based DELETE on every `@PartitionChildOf`
 *      table for rows whose parent is expired. MUST run before the
 *      partition drop: DDL partition drops bypass row-level FK/cascade
 *      semantics (and a partitioned parent cannot host a plain FK anyway),
 *      so without this step the children of dropped conversations would be
 *      orphaned.
 *   2. Default-partition strays — rows whose partition key had no covering
 *      partition land in `<table>_default`; the default partition is never
 *      dropped by retention, so expired strays are deleted row-level.
 *   3. `partman.run_maintenance(parent)` per processed parent — drops (or
 *      detaches, per `retention_keep_table`) expired partitions, premakes
 *      future ones. Deliberately NOT the global `run_maintenance_proc()`:
 *      that iterates every `part_config` row and aborts on any unrelated
 *      stale parent — each service maintains only its own schema.
 *
 * Runs inside a single client (`dal.withClient`) so the purge/drop pair is
 * one transactional unit per invocation.
 */

import type { PoolClient } from "pg";

import { getEntityPersistenceMeta, type EntityClass } from "../meta/entity-decorators.js";
import { quoteIdent } from "../query/query-builder.js";

export interface PartitionParentReport {
  /** `"schema"."table"` of the partitioned parent. */
  table: string;
  partition_column: string;
  /** Effective retention interval actually applied (part_config wins). */
  retention: string | null;
  /** `"schema"."child"` → rows deleted for expired parents. */
  children_purged: Record<string, number>;
  /** Expired rows removed from the default partition (never dropped). */
  strays_deleted: number;
  /** Live partition count before/after `run_maintenance_proc()`. */
  partitions_before: number;
  partitions_after: number;
  /** Set when the parent was skipped — reason string. */
  skipped?: string;
}

export interface RetentionSweepReport {
  /** `"schema"."table"` swept. */
  table: string;
  column: string;
  retention: string;
  rows_deleted: number;
}

export interface PartitionMaintenanceReport {
  parents: PartitionParentReport[];
  /** `@Retention` sweeps on non-partitioned tables. */
  sweeps: RetentionSweepReport[];
  /** Whether `partman.run_maintenance_proc()` ran. */
  maintenance_ran: boolean;
}

/**
 * Every retention-bearing surface this executor maintains:
 * - `@Partition` domain parents (pg_partman drop/detach),
 * - `{table}_audit` parents synthesized from `@AuditTrail()` entities —
 *   audit tables are not entity classes, so they are derived here with the
 *   fixed shape (`changed_at` key, `auditRetention ?? "12 months"`),
 * - `@Retention` sweeps on non-partitioned tables (row-level DELETE).
 */
type ParentTarget = {
  tableSchema: string;
  tableName: string;
  partition: { column: string; retention?: string };
};

/**
 * Boot-time gate for the `partition_maintenance` system job — `true` when
 * the registry contains ANY retention-bearing surface: a `@Partition`
 * parent, an `@AuditTrail()` entity (its `{table}_audit` is a maintained
 * parent), or a `@Retention` sweep. `false` = nothing to maintain → the
 * SDK mounts no callable and materializes no trigger.
 */
export function needsPartitionMaintenance(entities: readonly EntityClass[]): boolean {
  return entities.some((e) => {
    const m = getEntityPersistenceMeta(e);
    return m.isAuditable === true || m.partition !== undefined || m.retention !== undefined;
  });
}

export async function runPartitionMaintenance(
  client: PoolClient,
  entities: readonly EntityClass[],
): Promise<PartitionMaintenanceReport> {
  const metas = entities.map((e) => getEntityPersistenceMeta(e));
  const parents: ParentTarget[] = [
    ...metas
      .filter((m) => m.partition)
      .map((m) => ({
        tableSchema: m.tableSchema,
        tableName: m.tableName,
        partition: { column: m.partition!.column, retention: m.retention?.duration },
      })),
    ...metas
      .filter((m) => m.isAuditable)
      .map((m) => ({
        tableSchema: m.tableSchema,
        tableName: `${m.tableName}_audit`,
        partition: { column: "changed_at", retention: m.auditRetention ?? "12 months" },
      })),
  ];
  const sweeps = metas
    .filter((m) => m.retention && !m.partition)
    .map((m) => ({
      tableSchema: m.tableSchema,
      tableName: m.tableName,
      retention: m.retention!,
    }));
  const report: PartitionMaintenanceReport = { parents: [], sweeps: [], maintenance_ran: false };
  if (parents.length === 0 && sweeps.length === 0) return report;

  for (const s of sweeps) {
    const fq = `${quoteIdent(s.tableSchema)}.${quoteIdent(s.tableName)}`;
    const del = await client.query(
      `DELETE FROM ${fq} WHERE ${quoteIdent(s.retention.column)} < now() - $1::interval`,
      [s.retention.duration],
    );
    report.sweeps.push({
      table: fq,
      column: s.retention.column,
      retention: s.retention.duration,
      rows_deleted: del.rowCount ?? 0,
    });
  }

  const countPartitions = async (regclassName: string): Promise<number> =>
    Number(
      (
        await client.query<{ c: string }>(
          `SELECT count(*)::int AS c FROM pg_inherits WHERE inhparent = $1::regclass`,
          [regclassName],
        )
      ).rows[0]?.c ?? 0,
    );

  for (const p of parents) {
    const fq = `${quoteIdent(p.tableSchema)}.${quoteIdent(p.tableName)}`;
    const regclass = `${p.tableSchema}.${p.tableName}`;
    const part = p.partition;
    const pr: PartitionParentReport = {
      table: fq,
      partition_column: part.column,
      retention: part.retention ?? null,
      children_purged: {},
      strays_deleted: 0,
      partitions_before: 0,
      partitions_after: 0,
    };
    report.parents.push(pr);

    // partman registration is required — the entity declares intent but the
    // actual retention lives in part_config (applied by the generated patch).
    const cfg = await client.query<{ retention: string | null }>(
      `SELECT retention FROM partman.part_config WHERE parent_table = $1`,
      [regclass],
    );
    if ((cfg.rowCount ?? 0) === 0) {
      pr.skipped = "not registered in partman.part_config";
      continue;
    }
    const retention = cfg.rows[0]!.retention ?? part.retention;
    if (!retention) {
      pr.skipped = "no retention configured (entity meta nor part_config)";
      continue;
    }
    pr.retention = retention;
    pr.partitions_before = await countPartitions(regclass);

    // 1. Children purge — every entity declaring @PartitionChildOf(parent).
    for (const c of metas) {
      const co = c.partitionChildOf;
      if (!co || co.parentTable !== p.tableName || co.parentSchema !== p.tableSchema) continue;
      const childFq = `${quoteIdent(c.tableSchema)}.${quoteIdent(c.tableName)}`;
      const del = await client.query(
        `DELETE FROM ${childFq} WHERE ${quoteIdent(co.refColumn)} IN (
           SELECT ${quoteIdent(co.parentRefColumn)} FROM ${fq}
           WHERE ${quoteIdent(part.column)} < now() - $1::interval
         )`,
        [retention],
      );
      pr.children_purged[childFq] = del.rowCount ?? 0;
    }

    // 2. Default-partition strays.
    const def = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = $1::regclass AND c.relname LIKE '%\\_default' ESCAPE '\\'`,
      [regclass],
    );
    for (const d of def.rows) {
      const del = await client.query(
        `DELETE FROM ${quoteIdent(p.tableSchema)}.${quoteIdent(d.relname)}
         WHERE ${quoteIdent(part.column)} < now() - $1::interval`,
        [retention],
      );
      pr.strays_deleted += del.rowCount ?? 0;
    }
  }

  // 3. Drop/detach expired partitions + premake future ones — scoped to
  // THIS service's parents only. `run_maintenance_proc()` would iterate
  // every part_config row globally (a stale/missing parent elsewhere would
  // abort the whole run); `run_maintenance(parent)` is the per-parent
  // function form and keeps each service's executor inside its own schema.
  for (const p of parents) {
    const pr = report.parents.find((r) => r.table === `${quoteIdent(p.tableSchema)}.${quoteIdent(p.tableName)}`);
    if (!pr || pr.skipped) continue;
    await client.query(
      `SELECT partman.run_maintenance($1, p_analyze := false, p_jobmon := false)`,
      [`${p.tableSchema}.${p.tableName}`],
    );
    report.maintenance_ran = true;
  }

  for (const p of report.parents) {
    if (p.skipped) continue;
    p.partitions_after = await countPartitions(p.table.replaceAll('"', ""));
  }
  return report;
}
