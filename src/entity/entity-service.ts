/**
 * entity-service — the ONE generic CRUD service for entity routes.
 *
 * Ported from the BE's `http/entity-service.ts` so microservices can own
 * their entities end-to-end. Every BE-specific dependency is injected —
 * this module is transport-free and BE-free by construction:
 *
 *   - `repo`        — the gateway-owned Repository. Consumers NEVER pass it:
 *                     the public construction path is `dal.entityService(cfg)`,
 *                     which injects it. `repo` stays in the config only as the
 *                     injection seam for the free factory itself and for
 *                     decorated repositories (e.g. `withCache`-wrapped) that
 *                     still flow through `dal.entityService`.
 *   - `auditPort`   — defaults to `makeTableAuditPort(repo)`; override only
 *                     for ports with extra side effects (the BE adapter also
 *                     publishes entity-changed markers, which are gateway
 *                     collaboration infra, NOT required here)
 *   - `actor`       — `() => string` supplier (US passes SDK `requireActor`)
 *
 * Auditable display names are NOT configurable: for every auditable entity
 * the read paths LEFT JOIN `public.user_profiles` via the dal-owned
 * `UserProfileRefEntity` projection and emit `created_by_name` /
 * `updated_by_name` / `deleted_by_name` (COALESCE → raw actor on miss) —
 * `public` is a cross-app platform domain, exempt via
 * `PLATFORM_SHARED_TABLES` in schema-domain.ts.
 *
 * Guarantees identical to the BE version:
 * - every write returns the row produced by `RETURNING` — there is no code
 *   path that can return `{uuid}` or `{success: true}`;
 * - `version` is always the caller-observed value (optimistic lock);
 * - audit trail, actor stamping and tx propagation are identical for every
 *   entity;
 * - per-entity variation lives ONLY in `EntityServiceConfig` — never in a
 *   copied dal.
 *
 * Deliberately dropped vs the BE version:
 * - `debugCode` env toggles (env reads are banned outside bootstrap);
 * - the cache port (wrap `repo` with `withCache` at construction instead);
 * - `getPool`/`createRepository` singletons (this is a library — the caller
 *   owns the pool lifecycle).
 */

import { randomUUID } from "node:crypto";

import { Repository } from "../repository/repository.js";
import {
  field,
  Filter,
  Sort,
  Project,
  type FieldProjector,
  type FilterExpr,
  type JoinExpr,
} from "../query/dsl.js";
import { buildAuditableJoinsSelective } from "../audit/auditable-joins.js";
import { AuditLogEntity } from "../audit/audit-log-entity.js";
import { UserProfileRefEntity } from "../entities/user-profile-ref-entity.js";
import { isAuditableEntity } from "../repository/repository.js";
import {
  DeletableFieldType,
  getEntityPersistenceMeta,
  type EntityClass,
} from "../meta/entity-decorators.js";
import { entityDateToApiIso } from "../meta/column-pg-io.js";
import {
  translateFilterConditions,
  type ListFilterCondition,
} from "../query/list-filters.js";
import type { AuditPort } from "../types/types.js";
import { NotFoundError, ValidationError } from "../errors/errors.js";
import { findAuditPage } from "./audit-query.js";

// ─── Public contract ─────────────────────────────────────────────────────────

export type EntityAction =
  | "meta"
  | "list"
  | "export"
  | "create"
  | "duplicate"
  | "bulkDelete"
  | "bulkRestore"
  | "get"
  | "update"
  | "delete"
  | "purge"
  | "restore"
  | "audit";

export interface EntityListQuery {
  search?: string;
  search_in?: string[];
  sort_key?: string;
  sort_dir?: "asc" | "desc";
  page?: number;
  page_size?: number;
  filters?: ListFilterCondition[];
  connector?: "AND" | "OR";
  deleted_records?: "EXCLUDED" | "ONLY" | "INCLUDED";
  [key: string]: unknown;
}

export interface EntityListResult<TEntity> {
  rows: TEntity[];
  page: number;
  page_size: number;
  total: bigint;
}

export interface BulkItem {
  uuid: string;
  version: number;
}

export interface DuplicateResult {
  uuids: string[];
  errors: Array<{ uuid: string; error: string }>;
}

/** Declarative aggregate rollup projected into list rows. */
export interface AggregateDecl {
  /** Output column name, e.g. "user_count". */
  name: string;
  /** Aggregate SQL expression over the join alias, e.g. "COUNT(u.id)". */
  expr: string;
  /** Optional result cast — emitted as `CAST(<expr> [FILTER...] AS <cast>)`. */
  cast?: string;
  /** LEFT join feeding the aggregate. */
  join: {
    entity: EntityClass;
    alias: string;
    /** Property on the BASE entity (t.*). */
    base: string;
    /** Property on the JOINED entity (alias.*). */
    joined: string;
    /** Extra raw predicates applied via `FILTER (WHERE ...)`. */
    extra?: string;
  };
}

export interface EntityServiceConfig<TEntity> {
  /** Newable entity class (DB row shape). */
  entity: EntityClass & { new (): object };
  /** Repository — INTERNAL injection point only. `dal.entityService(cfg)`
   *  supplies the gateway-owned instance; callers of the free
   *  `makeEntityService` (tests, decorators such as BE `withCache`) must
   *  pass one explicitly. Consumer configs MUST NOT set it — a missing
   *  `repo` is a hard error, not a fallback. */
  repo?: Repository;
  /** Audit port — defaults to `makeTableAuditPort(repo)` (the standard
   *  `{table}_audit` writer). Override only for ports with extra side
   *  effects (e.g. the BE entity-changed marker publisher). */
  auditPort?: AuditPort;
  /** Actor supplier for audit stamping (e.g. SDK `requireActor`). */
  actor?: () => string;
  /** Audit trail table override — default `${tableName}_audit`. */
  auditTableName?: string;
  list: {
    searchableKeys: readonly string[];
    filterableKeys: ReadonlySet<string>;
    defaultSort?: { key: string; dir: "asc" | "desc" };
    extraFilters?: (q: EntityListQuery) => FilterExpr[];
    aggregates?: AggregateDecl[];
  };
  hooks?: {
    afterWrite?: (op: EntityAction, entity: TEntity) => void | Promise<void>;
    beforeCreate?: (
      body: Record<string, unknown>,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>;
    beforeUpdate?: (
      uuid: string,
      body: Record<string, unknown>,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  };
}

/** The contract every entity service must satisfy — enforced on the router. */
export interface EntityService<TEntity> {
  list(query: EntityListQuery): Promise<EntityListResult<TEntity>>;
  get(uuid: string): Promise<TEntity>;
  create(body: Record<string, unknown>, tx?: Repository): Promise<TEntity>;
  update(
    uuid: string,
    body: Record<string, unknown> & { version: number },
    tx?: Repository,
  ): Promise<TEntity>;
  delete(uuid: string, version: number): Promise<TEntity>;
  restore(uuid: string, version: number): Promise<TEntity>;
  purge(uuid: string, version: number): Promise<TEntity>;
  duplicate(uuids: string[]): Promise<DuplicateResult>;
  bulkDelete(items: BulkItem[]): Promise<unknown>;
  bulkRestore(items: BulkItem[]): Promise<unknown>;
  audit(uuid: string, page: number, limit: number): Promise<unknown>;
  stream(query: EntityListQuery): AsyncGenerator<TEntity>;
}

// ─── Standard audit port ─────────────────────────────────────────────────────

/**
 * `makeTableAuditPort` — writes audit log rows to `{tableName}_audit` via the
 * given repository. This is the service-side counterpart of the BE's
 * `EntityAuditPort`, minus the Redis/NATS entity-changed markers (those
 * belong to gateway collaboration infra). The audit row write itself is
 * always performed.
 */
export function makeTableAuditPort(repo: Repository): AuditPort {
  return {
    async writeAudit(params) {
      await repo.add(
        AuditLogEntity,
        {
          entity_id: params.entityId,
          entity_uuid: params.entityUuid,
          action: params.action,
          changed_at: params.changedAt,
          changed_by: params.changedBy,
          version: params.version,
          delta: params.delta,
        },
        { tableName: `${params.tableName}_audit` },
      );
    },
  };
}

// ─── Generic implementation ─────────────────────────────────────────────────

function buildIlikeNeedle(raw: string): {
  needle: string;
  trueChars: number;
  hasEscapedWildcard: boolean;
} {
  let out = "";
  let trueChars = 0;
  let hasEscapedWildcard = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "\\") {
      const next = raw[i + 1];
      if (next === "*" || next === "?") {
        out += next === "*" ? "%" : "_";
        hasEscapedWildcard = true;
        i++;
        continue;
      }
      out += "\\";
      trueChars++;
      continue;
    }
    if (ch === "%") out += "#%";
    else if (ch === "_") out += "#_";
    else if (ch === "#") out += "##";
    else out += ch;
    trueChars++;
  }
  return { needle: `%${out}%`, trueChars, hasEscapedWildcard };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDto<T>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[k] = v instanceof Date ? entityDateToApiIso(v) : v;
  }
  return out as T;
}

function projectAllExceptPk(entity: EntityClass): FieldProjector[] {
  const meta = getEntityPersistenceMeta(entity);
  return Object.values(meta.columns)
    .filter((c) => !c.isKey)
    .map((c) => Project.field(field(entity, c.propertyKey as never)));
}

export function makeEntityService<TEntity extends Record<string, unknown>>(
  cfg: EntityServiceConfig<TEntity>,
): EntityService<TEntity> {
  const meta = getEntityPersistenceMeta(cfg.entity);
  const repo = cfg.repo;
  if (!repo) {
    throw new ValidationError(
      "EntityServiceConfig.repo is required — use `dal.entityService(cfg)` so the gateway injects its own Repository",
    );
  }
  const auditPort = cfg.auditPort ?? makeTableAuditPort(repo);
  const actor = () => cfg.actor?.() ?? "system";
  const auditTable = cfg.auditTableName ?? `${meta.tableName}_audit`;

  const uuidCol = Object.entries(meta.columns).find(
    ([, c]) => c.propertyKey === "uuid" || c.isUnique,
  )?.[1];

  const hasDeletedBy = Object.values(meta.columns).some(
    (c) => c.isDeletable && c.deletableType === DeletableFieldType.DELETED_BY,
  );
  const auditable = isAuditableEntity(meta);
  const joinsFor = (): JoinExpr[] =>
    auditable
      ? (buildAuditableJoinsSelective(cfg.entity, UserProfileRefEntity, {
          includeDeleter: hasDeletedBy,
        }) as JoinExpr[])
      : [];
  const repoFor = (tx?: Repository) => tx ?? repo;

  function buildListFilters(q: EntityListQuery): FilterExpr[] {
    const filters: FilterExpr[] = [];

    if (cfg.list.extraFilters) {
      filters.push(...cfg.list.extraFilters(q));
    }

    if (q.search && q.search.trim()) {
      const raw = q.search.trim();
      const { needle, trueChars, hasEscapedWildcard } = buildIlikeNeedle(raw);
      const canSearch = trueChars >= 3 || (hasEscapedWildcard && trueChars >= 1);
      if (!canSearch) {
        filters.push(Filter.group([Filter.raw("1", "=", "0")], "AND"));
      } else {
        const looksLikeUuid = UUID_RE.test(raw);
        const fields = (q.search_in?.length
          ? q.search_in
          : [...cfg.list.searchableKeys]) as string[];
        const allowed = new Set([...cfg.list.searchableKeys, "uuid"]);
        const ors = fields
          .filter((f) => allowed.has(f))
          .flatMap((f) => {
            if (f === "uuid") {
              return looksLikeUuid
                ? [Filter.fieldValue(field(cfg.entity, "uuid" as never), "=", raw, "OR")]
                : [Filter.fieldValue(field(cfg.entity, "uuid" as never), "ILIKE", needle, "OR")];
            }
            return [Filter.fieldValue(field(cfg.entity, f as never), "ILIKE", needle, "OR")];
          });
        if (ors.length) filters.push(Filter.group(ors, "OR"));
      }
    }

    if (q.filters && q.filters.length > 0) {
      const translated = translateFilterConditions(cfg.entity, q.filters, {
        allowedFields: cfg.list.filterableKeys,
        connector: q.connector ?? "AND",
      });
      if (translated) filters.push(...translated);
    }

    return filters;
  }

  function buildListShape(): {
    fields: FieldProjector[] | null;
    joins: JoinExpr[];
    groupBy?: ReturnType<typeof field>[];
  } {
    const aggregates = cfg.list.aggregates ?? [];
    const joins = joinsFor();
    if (aggregates.length === 0) {
      return {
        fields: projectAllExceptPk(cfg.entity) as unknown as FieldProjector[],
        joins,
      };
    }
    const fields: FieldProjector[] = [
      ...(projectAllExceptPk(cfg.entity) as unknown as FieldProjector[]),
    ];
    const pkProp = Object.values(meta.columns).find((c) => c.isKey)?.propertyKey;
    for (const agg of aggregates) {
      joins.push({
        left: field(agg.join.entity, agg.join.joined as never),
        right: field(cfg.entity, agg.join.base as never),
        type: "LEFT",
        alias: agg.join.alias,
      });
      const filtered = `${agg.expr}${agg.join.extra ? ` FILTER (WHERE ${agg.join.extra})` : ""}`;
      const expr = agg.cast ? `CAST(${filtered} AS ${agg.cast})` : filtered;
      fields.push({ kind: "expr", expr, alias: agg.name });
    }
    return { fields, joins, groupBy: pkProp ? [field(cfg.entity, pkProp as never)] : [] };
  }

  async function fireAfterWrite(op: EntityAction, entity: TEntity): Promise<void> {
    await cfg.hooks?.afterWrite?.(op, entity);
  }

  return {
    async list(q) {
      const page = q.page ?? 1;
      const page_size = q.page_size ?? 25;
      const sort_key = (q.sort_key ?? cfg.list.defaultSort?.key ?? "updated_at") as string;
      const sort_dir =
        (q.sort_dir ?? cfg.list.defaultSort?.dir ?? "desc").toUpperCase() === "ASC"
          ? "ASC"
          : "DESC";

      const shape = buildListShape();
      const result = await repo.findByPage<TEntity, TEntity>(
        cfg.entity,
        page,
        page_size,
        shape.fields as never,
        {
          filters: buildListFilters(q),
          sorting: [Sort.by(field(cfg.entity, sort_key as never), sort_dir)],
          deletedRecords: q.deleted_records ?? "EXCLUDED",
          joins: shape.joins,
          groupBy: shape.groupBy,
        } as never,
      );

      return {
        rows: result.entities.map((r) => toDto(r)),
        page,
        page_size,
        total: result.total_records,
      };
    },

    async get(uuid) {
      const row = await repo.find<TEntity, TEntity>(
        cfg.entity,
        projectAllExceptPk(cfg.entity) as never,
        {
          filters: [Filter.fieldValue(field(cfg.entity, "uuid" as never), "=", uuid)],
          joins: joinsFor(),
          throwIfNotFound: false,
        } as never,
      );
      if (!row)
        throw new NotFoundError(`The requested ${meta.entityClassName} could not be found`);
      return toDto(row);
    },

    async create(body, tx) {
      const prepared = (await cfg.hooks?.beforeCreate?.(body)) ?? body;
      const row = await (repoFor(tx) as any).add(
        cfg.entity,
        {
          ...(prepared as Record<string, unknown>),
          uuid: (prepared as { uuid?: string }).uuid ?? randomUUID(),
        },
        {
          actor: actor(),
          audit: auditPort,
          returning: projectAllExceptPk(cfg.entity) as never,
        },
      );
      const dto = toDto(row) as unknown as TEntity;
      if (!tx) await fireAfterWrite("create", dto);
      return dto;
    },

    async update(uuid, body, tx) {
      const prepared = (await cfg.hooks?.beforeUpdate?.(uuid, body)) ?? body;
      const row = await (repoFor(tx) as any).update(
        cfg.entity,
        { ...(prepared as Record<string, unknown>), uuid },
        {
          actor: actor(),
          audit: auditPort,
          returning: projectAllExceptPk(cfg.entity) as never,
        },
      );
      const dto = toDto(row) as unknown as TEntity;
      if (!tx) await fireAfterWrite("update", dto);
      return dto;
    },

    async delete(uuid, version) {
      const row = await (repo as any).delete(cfg.entity, { uuid, version } as never, {
        actor: actor(),
        audit: auditPort,
        matchBy: "uuid" as never,
        returning: projectAllExceptPk(cfg.entity) as never,
      });
      const dto = toDto(row) as unknown as TEntity;
      await fireAfterWrite("delete", dto);
      return dto;
    },

    async restore(uuid, version) {
      const row = await (repo as any).restore(cfg.entity, { uuid, version } as never, {
        actor: actor(),
        audit: auditPort,
        matchBy: "uuid" as never,
        returning: projectAllExceptPk(cfg.entity) as never,
      });
      const dto = toDto(row) as unknown as TEntity;
      await fireAfterWrite("restore", dto);
      return dto;
    },

    async purge(uuid, version) {
      const row = await (repo as any).hardDelete(cfg.entity, { uuid, version } as never, {
        actor: actor(),
        audit: auditPort,
        matchBy: "uuid" as never,
        returning: projectAllExceptPk(cfg.entity) as never,
      });
      const dto = toDto(row) as unknown as TEntity;
      await fireAfterWrite("purge", dto);
      return dto;
    },

    async duplicate(uuids) {
      if (!uuidCol)
        throw new NotFoundError(
          `${meta.entityClassName} has no uuid column — duplicate unsupported`,
        );
      const results: string[] = [];
      const errors: Array<{ uuid: string; error: string }> = [];
      for (const uuid of uuids) {
        try {
          const cloned = (await (repo as any).clone(cfg.entity, uuid, {
            actor: actor(),
            audit: auditPort,
          })) as TEntity;
          results.push((cloned as unknown as { uuid: string }).uuid);
        } catch (e) {
          errors.push({ uuid, error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (results.length)
        await fireAfterWrite("duplicate", { uuids: results } as unknown as TEntity);
      return { uuids: results, errors };
    },

    async bulkDelete(items) {
      return (repo as any).deleteMany(cfg.entity, items as never, {
        actor: actor(),
        audit: auditPort,
        matchBy: "uuid" as never,
      });
    },

    async bulkRestore(items) {
      return (repo as any).restoreMany(cfg.entity, items as never, {
        actor: actor(),
        audit: auditPort,
        matchBy: "uuid" as never,
      });
    },

    async audit(uuid, page, limit) {
      const r = await findAuditPage(repo, {
        tableName: auditTable,
        entityUuid: uuid,
        page,
        limit,
      });
      return {
        ...r,
        data: r.data.map((row) => ({
          ...row,
          changed_by_name: row.changed_by_display_name ?? null,
        })),
      };
    },

    async *stream(q) {
      const sort_key = (q.sort_key ?? cfg.list.defaultSort?.key ?? "updated_at") as string;
      const sort_dir =
        (q.sort_dir ?? cfg.list.defaultSort?.dir ?? "desc").toUpperCase() === "ASC"
          ? "ASC"
          : "DESC";
      const shape = buildListShape();
      const iterable = await repo.findAll<TEntity, TEntity>(
        cfg.entity,
        shape.fields as never,
        {
          filters: buildListFilters(q),
          sorting: [Sort.by(field(cfg.entity, sort_key as never), sort_dir)],
          deletedRecords: q.deleted_records ?? "EXCLUDED",
          joins: shape.joins,
          groupBy: shape.groupBy,
          stream: true,
        } as never,
      );
      for await (const row of iterable as AsyncIterable<TEntity>) {
        yield toDto(row);
      }
    },
  };
}
