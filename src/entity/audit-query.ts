/**
 * audit-query — paged reads over a `{table}_audit` partition-parent table.
 *
 * Ported from the BE's `db/audit-query-helper.ts` so microservices can serve
 * their own entity audit routes. The only difference vs the BE version is
 * that the `user_profiles` join is OPTIONAL: `userEntity` is injected by the
 * caller (the BE passes `UserProfileEntity`; a microservice that does not
 * own a user_profiles table simply omits it and gets `changed_by_display_name`
 * / `changed_by_idp_code` as null — the raw `changed_by` uuid is always
 * present).
 */

import {
  AuditLogEntity,
  Project,
  Filter,
  Sort,
  field,
  buildAuditTrailJoins,
} from "../index.js";
import type { EntityClass, Repository } from "../index.js";

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
 * `userEntity` — optional auditable-display-name join target (BE:
 * `UserProfileEntity`). Without it, display-name columns are null.
 */
export async function findAuditPage(
  repo: Repository,
  opts: AuditPageOptions & { userEntity?: EntityClass },
): Promise<AuditPageResult> {
  const { joins, projections } = opts.userEntity
    ? buildAuditTrailJoins(AuditLogEntity, opts.userEntity)
    : { joins: [], projections: [] as ReturnType<typeof Project.field>[] };

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
