/**
 * audit-query — paged reads over a `{table}_audit` partition-parent table.
 *
 * The `public.user_profiles` display-name join is UNCONDITIONAL and owned
 * by this library: `public` is a cross-app platform domain (exempt via
 * `PLATFORM_SHARED_TABLES` in schema-domain.ts), so every service gets
 * `changed_by_display_name` (COALESCE → raw actor on join miss) and
 * `changed_by_idp_code` for free.
 */

import { AuditLogEntity } from "../audit/audit-log-entity.js";
import { UserProfileRefEntity } from "../entities/user-profile-ref-entity.js";
import { getEntityPersistenceMeta } from "../meta/entity-decorators.js";
import { Project, Filter, Sort, field } from "../query/dsl.js";
import { quoteIdent } from "../query/query-builder.js";
import { buildAuditTrailJoins } from "../audit/auditable-joins.js";
import type { Repository } from "../repository/repository.js";

/** Structural minimum the audit page query needs — satisfied by both the
 *  gateway `Dal` and a tx-scoped/raw `Repository`. */
export type AuditQueryable = Pick<Repository, "findByPage">;

export interface AuditPageOptions {
  /** e.g. "customers_audit" — the partition parent table name. */
  tableName: string;
  entityUuid: string;
  page: number;
  limit: number;
}

export interface AuditRow {
  id: bigint;
  entity_id: bigint;
  entity_uuid: string;
  action: string;
  changed_at: string;
  changed_by: string;
  changed_by_display_name: string | null;
  changed_by_idp_code: string | null;
  version: number;
  delta: Record<string, unknown>;
}

export interface AuditPageResult {
  data: AuditRow[];
  pagination: {
    page: number;
    limit: number;
    total: bigint;
    hasMore: boolean;
  };
}

function entityDateToApiIso(date: Date): string {
  return date.toISOString();
}

/**
 * Page through an entity audit table, newest first.
 * `changed_by` is always LEFT JOINed to `public.user_profiles` —
 * `changed_by_display_name` COALESCEs onto the raw actor (uuid / "system")
 * when no profile row matches.
 */
export async function findAuditPage(
  repo: AuditQueryable,
  opts: AuditPageOptions,
): Promise<AuditPageResult> {
  const auditMeta = getEntityPersistenceMeta(AuditLogEntity);
  const baseRef = `${quoteIdent(auditMeta.tableSchema)}.${quoteIdent(opts.tableName)}`;
  const { joins, projections } = buildAuditTrailJoins(
    AuditLogEntity,
    UserProfileRefEntity,
    baseRef,
  );

  const result = await repo.findByPage<AuditLogEntity, Record<string, unknown>>(
    AuditLogEntity,
    opts.page,
    opts.limit,
    [
      Project.field(field(AuditLogEntity, "id")),
      Project.field(field(AuditLogEntity, "entity_id")),
      Project.field(field(AuditLogEntity, "entity_uuid")),
      Project.field(field(AuditLogEntity, "action")),
      Project.field(field(AuditLogEntity, "changed_at")),
      Project.field(field(AuditLogEntity, "changed_by")),
      Project.field(field(AuditLogEntity, "version")),
      Project.field(field(AuditLogEntity, "delta")),
      ...projections,
    ],
    {
      filters: [
        Filter.fieldValue(field(AuditLogEntity, "entity_uuid"), "=", opts.entityUuid),
      ],
      sorting: [Sort.by(field(AuditLogEntity, "changed_at"), "DESC")],
      tableName: opts.tableName,
      joins,
    } as never,
  );

  const rows = result.entities as unknown as Array<Record<string, unknown>>;

  return {
    data: rows.map((row) => ({
      id: row.id as bigint,
      entity_id: row.entity_id as bigint,
      entity_uuid: row.entity_uuid as string,
      action: row.action as string,
      changed_at:
        row.changed_at instanceof Date
          ? entityDateToApiIso(row.changed_at)
          : (row.changed_at as string),
      changed_by: row.changed_by as string,
      changed_by_display_name: (row.changed_by_display_name as string | null) ?? null,
      changed_by_idp_code: (row.changed_by_idp_code as string | null) ?? null,
      version: row.version as number,
      delta: (row.delta as Record<string, unknown>) ?? {},
    })),
    pagination: {
      page: opts.page,
      limit: opts.limit,
      total: result.total_records,
      hasMore: BigInt(opts.page * opts.limit) < result.total_records,
    },
  };
}
