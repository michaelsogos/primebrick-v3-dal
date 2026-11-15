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

import { newUuidV7 } from "../types/uuid.js";

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
import { renderDisplayTemplate } from "../query/display-template.js";
import { getSchemaDomain } from "../meta/schema-domain.js";
import { lookupEntityService, registerEntityService } from "./entity-registry.js";
import { AuditLogEntity } from "../audit/audit-log-entity.js";
import { UserProfileRefEntity } from "../entities/user-profile-ref-entity.js";
import { ServiceRegistryRefEntity } from "../entities/service-registry-ref-entity.js";
import { isAuditableEntity } from "../repository/repository.js";
import {
  AuditableFieldType,
  CloneFieldType,
  DeletableFieldType,
  getEntityPersistenceMeta,
  isClonableEntity,
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
import {
  extJsonStringify,
  isColumnFilterable,
  searchableTextColumns,
  type EntityMeta,
  type MetaColumn,
} from "@primebrick/core";

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
  /** The entity's OWN display template (`"${name} (${code})"` syntax —
   *  `resolveDisplayTemplate(meta)` applied to the authored meta).
   *  Evaluated on self-ref joins: `cloned_from_name` projects the same
   *  string the FE uses for this entity's titles. Absent → self-join
   *  skipped, the ref cell renders the raw uid (COALESCE fallback). */
  display?: string | null;
  list: {
    /** Resolved entity meta — the single source of truth for the list wire
     *  contract: the `search_in` allowlist, the default search scope and the
     *  `filters[i][field]` allowlist all derive from its columns. When
     *  present, `searchableKeys`/`filterableKeys` are optional NARROWINGS
     *  intersected with the derived universe (the `sortableKeys` pattern);
     *  when absent (headless entities with no served meta) both stay
     *  required — a missing pair throws at construction, never mid-query. */
    meta?: EntityMeta;
    searchableKeys?: readonly string[];
    filterableKeys?: ReadonlySet<string>;
    /** Optional narrowing of the derived sortable universe (physical +
     *  calculated column keys + aggregate aliases). When omitted, every
     *  resolvable key is accepted; a `sort_key` outside the universe is
     *  rejected with `ValidationError` BEFORE any SQL — never `ORDER BY`
     *  on an arbitrary string. */
    sortableKeys?: ReadonlySet<string>;
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
  /** `options_source:"audit.actors"` vocabulary feed — the distinct
   *  writers of THIS table, label-resolved through `public.user_profiles`.
   *  `[]` on entities with no audit actor columns. */
  auditActors(): Promise<{ value: string; label: string }[]>;
  stream(query: EntityListQuery): AsyncGenerator<TEntity>;
  /** The entity's `dict` facet when the class carries `@Dict` — the
   *  entity-router injects it into served meta (`dict`). */
  dictFacet?: import("@primebrick/core").DictFacet;
  /** `@AuditTrail()` on the entity class — the entity HAS an audit-trail
   *  table. The router derives `collaboration.enabled` from this. */
  auditable?: boolean;
  /** `Clonable` mixin on the entity class — `/duplicate` may register
   *  only when true. Derived, never restated in the decl. */
  clonable?: boolean;
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
      const inserted = await repo.add(
        AuditLogEntity,
        {
          // `entity_id` exists only on pre-migration audit tables — omit the
          // key entirely for uuid-PK entities (the column is dropped there;
          // including it would target a nonexistent column).
          ...(params.entityId != null ? { entity_id: params.entityId } : {}),
          entity_uuid: params.entityUuid,
          action: params.action,
          changed_at: params.changedAt,
          changed_by: params.changedBy,
          version: params.version,
          delta: params.delta,
        },
        {
          tableName: `${params.tableName}_audit`,
          // RETURNING must reference only columns guaranteed on BOTH audit
          // shapes (post-migration tables dropped `entity_id`) — project id.
          returning: [Project.field(field(AuditLogEntity, "id"))],
        },
      );
      return inserted.id;
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

function projectAllExceptSurrogateId(entity: EntityClass): FieldProjector[] {
  const meta = getEntityPersistenceMeta(entity);
  return Object.values(meta.columns)
    .filter((c) => !(c.isKey && c.sqlName === "id"))
    .map((c) => Project.field(field(entity, c.propertyKey as never)));
}

/** Physical PG types safe for `ILIKE` — `uuid` is searched via the
 *  `CAST(col AS text)` the query-builder already applies. */
const TEXTLIKE_PG_TYPES = new Set([
  "character varying", "varchar", "character", "char",
  "text", "citext", "name", "uuid",
]);

/**
 * Wire sets derived from the RESOLVED `meta.columns` × the entity's physical
 * column types — the single implementation behind `list.meta` derivation,
 * also exported for service-side paths that run their own query (outside
 * `makeEntityService`) yet must answer to the same contract:
 *
 *  - `searchable`: `searchable`-flagged text-physical columns plus
 *    `@Calculated` projections (they render to SQL and are ILIKE-safe) —
 *    the `search_in` allowlist + default scope base (`uuid` and joined-name
 *    keys are admitted on top by the caller).
 *  - `filterable`: `filterable`-flagged columns restricted to WHERE-
 *    resolvable keys (physical + calculated).
 *
 * Meta `searchable`/`filterable` express product intent, the entity
 * decorators express physical reality — the two cannot diverge.
 */
export function deriveListWireSets(
  columns: MetaColumn[],
  entity: EntityClass,
): { searchable: ReadonlySet<string>; filterable: ReadonlySet<string> } {
  const persistence = getEntityPersistenceMeta(entity);
  const calculatedKeys = new Set(Object.keys(persistence.calculated));
  const physicalTextlike = new Set(
    Object.values(persistence.columns)
      .filter((c) =>
        TEXTLIKE_PG_TYPES.has(
          (c.pgType ?? c.inferredPgType ?? "").toLowerCase().replace(/\(.*\)/, ""),
        ),
      )
      .map((c) => c.propertyKey),
  );
  const filterResolvable = new Set<string>([
    ...Object.values(persistence.columns).map((c) => c.propertyKey),
    ...calculatedKeys,
  ]);
  return {
    searchable: new Set(
      searchableTextColumns(columns)
        .map((c) => c.key)
        .filter((k) => physicalTextlike.has(k) || calculatedKeys.has(k)),
    ),
    filterable: new Set(
      columns
        .filter((c) => isColumnFilterable(c))
        .map((c) => c.key)
        .filter((k) => filterResolvable.has(k)),
    ),
  };
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
  // Self-register under the derived api name — domain `@Ref` joins
  // resolve their target's class + display template from this map.
  registerEntityService(cfg);
  const auditPort = cfg.auditPort ?? makeTableAuditPort(repo);
  const actor = () => cfg.actor?.() ?? "system";
  const auditTable = cfg.auditTableName ?? `${meta.tableName}_audit`;

  const uuidCol = Object.entries(meta.columns).find(
    ([, c]) => c.propertyKey === "uuid" || c.isUnique,
  )?.[1];

  const hasDeletedBy = Object.values(meta.columns).some(
    (c) => c.isDeletable && c.deletableType === DeletableFieldType.DELETED_BY,
  );

  // uid + audit-actor columns are ALWAYS wire-filterable, on top of the
  // service-declared `filterableKeys`: the uid powers ref/actor label
  // `IN` lookups (`filters[i][field]=uuid`), and `*_by` columns feed
  // `options_source:"audit.actors"` — the meta auto-derivation marks them
  // filterable, so the wire allowlist must match the meta contract or the
  // governed control would serialize criteria the backend then skips.
  const wireAlwaysFilterable = new Set<string>(
    Object.values(meta.columns)
      .filter(
        (c) =>
          c.isUnique ||
          c.auditableType === AuditableFieldType.CREATED_BY ||
          c.auditableType === AuditableFieldType.UPDATED_BY ||
          c.deletableType === DeletableFieldType.DELETED_BY,
      )
      .map((c) => c.propertyKey),
  );
  const metaCols = cfg.list.meta?.columns;
  const wireSets = metaCols ? deriveListWireSets(metaCols, cfg.entity) : undefined;
  const derivedSearchable = wireSets?.searchable;
  /** `searchableKeys` narrows both the default scope and the `search_in`
   *  allowlist when present; the derived set otherwise. `uuid` and every
   *  joined-name key stay admitted on top — by construction. */
  const searchableScope: ReadonlySet<string> = cfg.list.searchableKeys
    ? new Set(
        [...cfg.list.searchableKeys].filter((k) =>
          derivedSearchable ? derivedSearchable.has(k) : true,
        ),
      )
    : (derivedSearchable ?? new Set<string>());
  const derivedFilterable = wireSets?.filterable;
  const allowedFilterFields: ReadonlySet<string> = new Set([
    ...(cfg.list.filterableKeys
      ? derivedFilterable
        ? [...cfg.list.filterableKeys].filter((k) => derivedFilterable.has(k))
        : cfg.list.filterableKeys
      : (derivedFilterable ?? [])),
    ...wireAlwaysFilterable,
  ]);
  if (derivedSearchable === undefined && cfg.list.searchableKeys === undefined) {
    throw new ValidationError(
      `EntityServiceConfig.list requires \`meta\` or \`searchableKeys\` for ${meta.entityClassName} — without either, the search scope cannot be derived.`,
    );
  }
  if (derivedFilterable === undefined && cfg.list.filterableKeys === undefined) {
    throw new ValidationError(
      `EntityServiceConfig.list requires \`meta\` or \`filterableKeys\` for ${meta.entityClassName} — without either, the filter allowlist cannot be derived.`,
    );
  }
  const auditable = isAuditableEntity(meta);
  const clonable = isClonableEntity(cfg.entity);
  /** `cloned_by` actor join — only when the column actually exists
   *  (`Clonable` mixin carries it; a hand-rolled entity may declare the
   *  `cloned_from` pointer alone). */
  const hasClonedBy = Object.values(meta.columns).some(
    (c) => c.cloneType === CloneFieldType.CLONED_BY,
  );
  /** Display template rendered once at construction — an unknown `${key}`
   *  fails here, never mid-query. `clone_src` = the self-join alias. */
  const selfDisplaySql = cfg.display
    ? renderDisplayTemplate(cfg.display, cfg.entity, "clone_src")
    : undefined;
  /** Domain `@Ref` display joins — every ref column whose target entity
   *  resolved inside this service's registry gets a LEFT JOIN projecting
   *  `{key}_name` off the target's OWN display template (the same
   *  `resolveDisplayTemplate` materialization `cloned_from_name` uses).
   *  Actor columns and `cloned_from` stay on their dedicated joins
   *  above; a ref that doesn't resolve (cross-domain, headless or
   *  unregistered entity, no display template) is SKIPPED — the cell
   *  falls back to the raw uuid and the record sheet still drills
   *  through the target service's own endpoint. Segregation holds:
   *  only same-schema or platform-shared tables may join. */
  const refDisplayJoinsFor = (): JoinExpr[] => {
    const out: JoinExpr[] = [];
    const shared = getSchemaDomain()?.sharedTables;
    for (const col of Object.values(meta.columns)) {
      if (col.refEntity === undefined) continue;
      if (col.isClone === true || col.cloneType !== undefined) continue;
      if (col.auditableType !== undefined || col.deletableType !== undefined) continue;
      const target = lookupEntityService(col.refEntity);
      if (target === undefined || target.display === null) continue;
      let targetMeta;
      try {
        targetMeta = getEntityPersistenceMeta(target.entity, meta.tableSchema);
      } catch {
        continue; // foreign-domain entity — the schema guard itself says no
      }
      const targetShared = shared !== undefined && shared.has(targetMeta.tableName);
      if (targetMeta.tableSchema !== meta.tableSchema && !targetShared) continue;
      const targetUid = Object.values(targetMeta.columns).find(
        (c) => c.propertyKey === "uuid" || c.isUnique,
      )?.propertyKey;
      if (targetUid === undefined) continue;
      const alias = `ref_${String(col.propertyKey)}`;
      out.push({
        left: field(target.entity, targetUid as never),
        right: field(cfg.entity, col.propertyKey as never),
        type: "LEFT" as const,
        alias,
        display: {
          as: `${String(col.propertyKey)}_name`,
          sql: renderDisplayTemplate(target.display, target.entity, alias),
        },
      });
    }
    return out;
  };

  const joinsFor = (): JoinExpr[] => [
    ...(auditable || clonable
      ? (buildAuditableJoinsSelective(cfg.entity, UserProfileRefEntity, {
          includeCreator: auditable,
          includeUpdater: auditable,
          includeDeleter: auditable && hasDeletedBy,
          includeCloner: clonable && hasClonedBy,
          // Platform service-registry resolution for `system:<code>`
          // actors — the second per-actor join feeds both the COALESCE'd
          // `<col>_name` display and the `<col>_ref_entity|_ref_key`
          // lazy-ref verdicts (match-driven, NULL when no join resolves).
          serviceEntity: ServiceRegistryRefEntity,
        }) as JoinExpr[])
      : []),
    ...(clonable && selfDisplaySql
      ? [{
          left: field(cfg.entity, "uuid" as never),
          right: field(cfg.entity, "cloned_from" as never),
          type: "LEFT" as const,
          alias: "clone_src",
          display: { as: "cloned_from_name", sql: selfDisplaySql },
        }]
      : []),
    ...refDisplayJoinsFor(),
  ];
  /** Joined-name descriptor per base column — derived from the joins' own
   *  `display` contracts. Search resolves `COALESCE(<expr>, <col>::text)`;
   *  `sort_key` orders on the projected `*_name` alias (the sorted
   *  surface the FE shows), never the raw uid/uuid. Rebuilt per request:
   *  the ref registry warms after construction, so the map can never be
   *  frozen against it. */
  const nameJoinsFor = (joins: JoinExpr[]) =>
    new Map(
      joins
        .filter((j) => j.display !== undefined)
        .map((j) => [
          j.right.key as string,
          { nameAlias: j.display!.as, sql: j.display!.sql },
        ]),
    );
  const repoFor = (tx?: Repository) => tx ?? repo;

  /** Fail-closed `sort_key` gate: the wire can only sort on keys that
   *  resolve to a real projection — physical columns, `@Calculated`
   *  aliases, aggregate aliases — optionally narrowed by
   *  `cfg.list.sortableKeys`. Anything else is a 400, never a 42703. */
  const sortableUniverse = new Set<string>([
    // the surrogate PK never enters the wire contract — unless it IS the
    // entity's uid (legacy id-keyed tables, where id is also @Unique, or
    // uuid-keyed tables where the PK itself is the public uid).
    ...Object.values(meta.columns)
      .filter((c) => !c.isKey || c.isUnique || c.sqlName === "uuid")
      .map((c) => c.propertyKey),
    ...Object.keys(meta.calculated),
    ...(cfg.list.aggregates ?? []).map((a) => a.name),
  ]);
  const allowedSortKeys = cfg.list.sortableKeys
    ? new Set([...cfg.list.sortableKeys].filter((k) => sortableUniverse.has(k)))
    : sortableUniverse;
  function assertSortableKey(sort_key: string): void {
    if (!allowedSortKeys.has(sort_key)) {
      throw new ValidationError(
        `Invalid sort_key "${sort_key}" for ${meta.entityClassName} — must be one of: ${[...allowedSortKeys].sort().join(", ")}`,
      );
    }
  }

  /** Read projection = physical columns + every `@Calculated` prop — the
   *  single place a calculated field becomes a SELECT column. `{self}`
   *  resolves to the qualified base-table ref (same rendering as the
   *  WHERE/ORDER BY substitution in the query builder). */
  const selfRef = `"${meta.tableSchema}"."${meta.tableName}"`;
  function projectRead(): FieldProjector[] {
    const fields = projectAllExceptSurrogateId(cfg.entity) as unknown as FieldProjector[];
    for (const c of Object.values(meta.calculated)) {
      fields.push({ kind: "expr", expr: c.expr.replaceAll("{self}", selfRef), alias: c.sqlName });
    }
    return fields;
  }

  function buildListFilters(q: EntityListQuery): FilterExpr[] {
    const filters: FilterExpr[] = [];

    if (cfg.list.extraFilters) {
      filters.push(...cfg.list.extraFilters(q));
    }

    if (q.search && q.search.trim()) {
      const raw = q.search.trim();
      const { needle, trueChars, hasEscapedWildcard } = buildIlikeNeedle(raw);
      // `search_in` wire forms — comma-joined single param (the FE's
      // canonical serialization: `search_in=a,b`), `search_in[]` brackets,
      // or repeated params — all normalize to the key array. Column keys
      // are snake_case: ',' can never appear inside one, so splitting is
      // unambiguous (same contract as be-v3's csvToStringArray).
      const fields = (q.search_in === undefined
        ? [...searchableScope]
        : Array.isArray(q.search_in)
          ? q.search_in
          : [q.search_in]
      ).flatMap((v) => String(v).split(",")) as string[];
      // `search_in` admits every joined-name key on top of the authored
      // searchable set — a column carrying a display join is searchable
      // on its `{key}_name` surface by construction.
      const nameJoins = nameJoinsFor(joinsFor());
      const allowed = new Set([
        ...searchableScope,
        "uuid",
        ...nameJoins.keys(),
      ]);
      // Fail closed like `filters[i][field]` and `sort_key`, BEFORE the
      // needle-length gate: a scope key outside the allowlist used to be
      // silently dropped, which turned "search this column" into "search
      // nothing, return all".
      const rejected = fields.filter((f) => !allowed.has(f));
      if (rejected.length) {
        throw new ValidationError(
          `Invalid search_in ${extJsonStringify(rejected)} for ${meta.entityClassName} — must be one of: ${[...allowed].sort().join(", ")}`,
        );
      }
      if (!fields.length) {
        throw new ValidationError(
          `Entity ${meta.entityClassName} exposes no searchable fields — \`search\` cannot be evaluated`,
        );
      }
      const canSearch = trueChars >= 3 || (hasEscapedWildcard && trueChars >= 1);
      if (!canSearch) {
        filters.push(Filter.group([Filter.raw("1", "=", "0")], "AND"));
      } else {
        const looksLikeUuid = UUID_RE.test(raw);
        const ors = fields
          .filter((f) => allowed.has(f))
          .flatMap((f) => {
            if (f === "uuid") {
              return looksLikeUuid
                ? [Filter.fieldValue(field(cfg.entity, "uuid" as never), "=", raw, "OR")]
                : [Filter.fieldValue(field(cfg.entity, "uuid" as never), "ILIKE", needle, "OR")];
            }
            const nameJoin = nameJoins.get(f);
            if (nameJoin) {
              // Joined-name search resolves the join's display expression —
              // the searchable surface — COALESCE'd onto the raw column
              // value (same fallback as the `*_name` projection; a uuid
              // column cannot serve ILIKE directly → 42883).
              return [Filter.expr(
                { sql: `COALESCE(${nameJoin.sql}, ${selfRef}."${f}"::text)` },
                "ILIKE",
                { sql: "? ESCAPE '#'", params: [needle] },
                "OR",
              )];
            }
            return [Filter.fieldValue(field(cfg.entity, f as never), "ILIKE", needle, "OR")];
          });
        if (ors.length) filters.push(Filter.group(ors, "OR"));
      }
    }

    if (q.filters && q.filters.length > 0) {
      const translated = translateFilterConditions(cfg.entity, q.filters, {
        allowedFields: allowedFilterFields,
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
    const hasCalculated = Object.keys(meta.calculated).length > 0;
    const joins = joinsFor();
    if (aggregates.length === 0 && !hasCalculated) {
      return {
        fields: projectAllExceptSurrogateId(cfg.entity) as unknown as FieldProjector[],
        joins,
      };
    }
    const fields: FieldProjector[] = projectRead();
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
      assertSortableKey(sort_key);

      const shape = buildListShape();
      // Joined-name sort orders on the projected `*_name` display column
      // (the sorted surface the FE shows), not the raw uuid.
      const sortNameJoin = nameJoinsFor(shape.joins).get(sort_key);
      const result = await repo.findByPage<TEntity, TEntity>(
        cfg.entity,
        page,
        page_size,
        shape.fields as never,
        {
          filters: buildListFilters(q),
          sorting: [
            sortNameJoin
              ? Sort.byAlias(sortNameJoin.nameAlias, sort_dir)
              : Sort.by(field(cfg.entity, sort_key as never), sort_dir),
          ],
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
        projectRead() as never,
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
          uuid: (prepared as { uuid?: string }).uuid ?? newUuidV7(),
        },
        {
          actor: actor(),
          audit: auditPort,
          returning: projectAllExceptSurrogateId(cfg.entity) as never,
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
          returning: projectAllExceptSurrogateId(cfg.entity) as never,
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
        returning: projectAllExceptSurrogateId(cfg.entity) as never,
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
        returning: projectAllExceptSurrogateId(cfg.entity) as never,
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
        returning: projectAllExceptSurrogateId(cfg.entity) as never,
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
      if (!isClonableEntity(cfg.entity))
        throw new ValidationError(
          `${meta.entityClassName} is not Clonable — /duplicate must not be reached`,
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

    async auditActors() {
      return repo.distinctAuditActors(cfg.entity);
    },

    async *stream(q) {
      const sort_key = (q.sort_key ?? cfg.list.defaultSort?.key ?? "updated_at") as string;
      const sort_dir =
        (q.sort_dir ?? cfg.list.defaultSort?.dir ?? "desc").toUpperCase() === "ASC"
          ? "ASC"
          : "DESC";
      assertSortableKey(sort_key);
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

    // Capability contract — derived from the entity class, consumed by the
    // router (collaboration.enabled, /duplicate gate). Never restated.
    auditable,
    clonable,
  };
}
