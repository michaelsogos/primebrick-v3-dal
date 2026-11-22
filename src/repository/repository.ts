import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";

import type { EntityClass } from "../meta/entity-meta.js";
import type { EntityPersistenceMeta } from "../meta/entity-decorators.js";
import {
  getColumnName,
  getEntityPersistenceMeta,
  getQualifiedTableName,
  getPrimaryKeyColumn,
  syncImplicitEntityColumns,
} from "../meta/entity-meta.js";
import {
  AuditableFieldType,
  CloneFieldType,
  DeletableFieldType,
  getRelationFacet,
} from "../meta/entity-decorators.js";
import {
  columnHintsFromMetaColumn,
  type ColumnPgPersistenceHints,
  effectivePgStorageType,
  jsValueToPgParam,
} from "../meta/column-pg-io.js";

import type { FieldProjector, FieldRef, FilterExpr, JoinExpr, SortingExpr } from "../query/dsl.js";
import { field, Filter } from "../query/dsl.js";
import { buildSelectQuery, buildVectorSearchQuery, quoteIdent } from "../query/query-builder.js";
import { createStream } from "../query/streaming.js";
import { SequenceCounterEntity } from "../entities/sequence-counter-entity.js";
import { SequenceEntity } from "../entities/sequence-entity.js";
import {
  extJsonStringify,
  parseSequenceDirective,
  parseSequencePattern,
  validateSequencePartitions,
  sequencePartitionKey,
  derivePeriodKey,
  renderSequenceValue,
  renderSequenceRange,
  type SequenceDecl,
  type SequenceDirective,
  type SequencePattern,
  type SequencePartitions,
} from "@primebrick/core";
import type { SequenceBound } from "../meta/entity-decorators.js";
import { sequenceBoundUuid } from "../meta/entity-decorators.js";
import { getSchemaDomain } from "../meta/schema-domain.js";
import { sha256Hex } from "../schema-diff/patch-naming.js";
import type {
  FindByIdOptions,
  FindOptions,
  FindByUUIDOptions,
  PaginatedEntity,
  WriteOptions,
  AuditableWriteOptions,
  MatchByOptions,
  VectorSearchOptions,
  BulkOptions,
  UpsertOptions,
  AuditPort,
  LoggerPort,
  BulkResult,
} from "../types/types.js";
import { AuditAction } from "../types/types.js";
import { NotFoundError, MultipleRowsError, UnknownColumnError, ValidationError, MissingVersionError, RecordVanishedError, DuplicateRecordError, BulkTimeoutError, OptimisticLockError, MatchSelectorError, IdentityConflictError, SequenceNotFoundError } from "../errors/errors.js";
import { DalErrorCodes } from "../errors/error-codes.js";
import type { IAuditableEntity, IDeletableEntity, IClonableEntity } from "../types/entities.js";
import { isUuidV7, newUuidV7 } from "../types/uuid.js";
import { calculateDelta, calculateDeltaWithForcedFields } from "../audit/delta-calculator.js";
import { entityApiName } from "../entity/entity-registry.js";
import { entityEventsEnabled, type EntityEventDraft, type EntityWriteAction } from "../entity/events.js";

/** @internal — structural client/pool surface used by Repository; also used by the deferred-transaction capture layer. */
export type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

/**
 * @internal Construction token — only dal-pg internals (Dal factories, tx
 * plumbing) may build a Repository. NOT re-exported from the package index
 * and unreachable through the package exports map, so consumers cannot
 * produce a value of this type: `new Repository(...)` outside this package
 * is a compile-time error by construction.
 */
export const REPO_INTERNAL: unique symbol = Symbol("dal-pg:repo-internal");

/** Escape a JS string as a single-quoted SQL literal. */
function escapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Wire-sanitize a record for the entity-event payload/delta — BigInt
 *  values cannot cross JSON.stringify (throws) or the event wire, so they
 *  degrade to Number the same way the audit hardDelete delta does.
 *  @internal — shared with the deferred-transaction commit-time drain. */
export function eventSafeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = typeof v === "bigint" ? Number(v) : v;
  }
  return out;
}

/** No-op logger — used when no LoggerPort is injected. */
const noopLogger: LoggerPort = {
  error() {},
  warn() {},
  info() {},
};

/** Find the PK column from entity metadata. */
function findPkColumn(meta: ReturnType<typeof getEntityPersistenceMeta>): {
  sqlName: string;
  propertyKey: string;
} | null {
  const col = Object.values(meta.columns).find((c) => c.isKey);
  if (!col) return null;
  return { sqlName: col.sqlName, propertyKey: col.propertyKey };
}

/** True while the entity still carries the legacy surrogate `id` column —
 *  false once it migrates to a uuid primary key (`uuid` becomes @Key). */
function hasSurrogateId(meta: ReturnType<typeof getEntityPersistenceMeta>): boolean {
  return meta.columns["id"] !== undefined;
}

/** uuid-PK boundary guard — a caller-supplied value for a uuid @Key column
 *  must be a well-formed uuid v7 (enforcer at the boundary, not docs). */
function assertUuidV7Value(entityName: string, propertyKey: string, value: unknown): void {
  if (!isUuidV7(value)) {
    throw new ValidationError(
      `${entityName}: '${propertyKey}' must be a uuid v7 value, got ${String(value)}`,
    );
  }
}

/** The audit `entity_id` mirrors the legacy surrogate `id` — null once the
 *  entity migrated to a uuid PK (its `*_audit` table drops the column). */
function auditEntityId(
  ...records: Array<Record<string, unknown> | undefined>
): bigint | null {
  for (const r of records) {
    const v = r?.["id"];
    if (v !== undefined && v !== null) return v as bigint;
  }
  return null;
}

/**
 * Resolve which column to use as the WHERE left operand for BULK write ops
 * (single-column selector — the multi-identity design is single-row only).
 * matchBy may arrive as a string or 1-element array (shared option type);
 * arrays with >1 props are rejected — bulk composite match is not
 * implemented (ERR09).
 */
/** A single identity condition: `WHERE <sqlName> = <param>` on the payload value. */
interface MatchCondition {
  propertyKey: string;
  sqlName: string;
  value: unknown;
  hints: ColumnPgPersistenceHints;
}

/** Render `a = $i AND b = $j ...` for the identity conditions (shared by all CTEs + the write). */
function identityWhere(conditions: MatchCondition[], paramStart: number, alias?: string): string {
  const p = alias ? `${alias}.` : "";
  return conditions
    .map((c, i) => `${p}${quoteIdent(c.sqlName)} = $${paramStart + i}`)
    .join(" AND ");
}

/** NOT(ALL identity equal) — used to exclude the target row from the conflict scan. */
function identitySelfExclusion(conditions: MatchCondition[], paramStart: number, alias: string): string {
  return conditions
    .map((c, i) => `${alias}.${quoteIdent(c.sqlName)} IS DISTINCT FROM $${paramStart + i}`)
    .join(" OR ");
}

/** Find the @AuditableField(VERSION) column from entity metadata, if any. */
function findVersionColumn(meta: ReturnType<typeof getEntityPersistenceMeta>): {
  sqlName: string;
  propertyKey: string;
} | null {
  const col = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);
  if (!col) return null;
  return { sqlName: col.sqlName, propertyKey: col.propertyKey };
}

/**
 * Extract the `version` value from the payload and remove it from the SET clause.
 * Used by `update`/`delete`/`restore`/`hardDelete` for optimistic concurrency control.
 *
 * Throws `MissingVersionError` (ERR02) if the entity is auditable (has a version column)
 * but `version` is not present in the payload.
 *
 * For non-auditable entities, returns `null` (no version guard applied).
 */
function extractVersion(
  payload: Record<string, unknown>,
  versionCol: { sqlName: string; propertyKey: string } | null,
  entityClassName: string,
): { expectedVersion: number; remainingPayload: Record<string, unknown> } | null {
  if (!versionCol) return null; // non-auditable entity — no guard
  const versionValue = payload[versionCol.propertyKey];
  if (versionValue === undefined || versionValue === null) {
    throw new MissingVersionError(
      `Auditable entity write requires a 'version' field; entity ${entityClassName} is auditable but no version was provided.`,
    );
  }
  const remainingPayload = { ...payload };
  delete remainingPayload[versionCol.propertyKey];
  return { expectedVersion: Number(versionValue), remainingPayload };
}

/**
 * Disambiguate a zero-row update/delete/restore into ERR01 (version mismatch) or ERR03 (row vanished).
 *
 * Runs a `SELECT 1 FROM t WHERE matchCol = $match` — if 0 rows, the row was hard-deleted
 * (throw RecordVanishedError ERR03); if 1 row, the row exists but version didn't match
 * (execute PG `RAISE EXCEPTION ... ERRCODE='ERR01'`).
 *
 * Called only on the error path (rare), so the extra round-trip is acceptable.
 */
async function disambiguateZeroRows(
  db: Queryable,
  table: string,
  conditions: MatchCondition[],
  entityClassName: string,
  expectedVersion: number,
  versionColSqlName: string,
): Promise<never> {
  const condSql = conditions.map((c, i) => `${quoteIdent(c.sqlName)} = $${i + 1}`).join(" AND ");
  const condParams = conditions.map((c) => jsValueToPgParam(c.value, c.hints));
  const checkSql = `SELECT 1 FROM ${table} WHERE ${condSql} LIMIT 1`;
  const checkResult = await db.query(checkSql, condParams);
  if (checkResult.rowCount === 0) {
    // Identity incoherence probe: does a row exist under ANY SINGLE
    // identity field? (e.g. uuid matches but id differs → ERR10, not ERR03)
    for (const c of conditions) {
      const partial = await db.query(
        `SELECT 1 FROM ${table} WHERE ${quoteIdent(c.sqlName)} = $1 LIMIT 1`,
        [jsValueToPgParam(c.value, c.hints)],
      );
      if ((partial.rowCount ?? 0) > 0) {
        throw new IdentityConflictError(
          `Entity ${entityClassName}: identity mismatch — a row exists for ${c.sqlName} but the supplied identity fields do not converge on it.`,
        );
      }
    }
    throw new RecordVanishedError(
      `Entity ${entityClassName}: record vanished — the row was deleted by another writer between read and write.`,
    );
  }
  // Row exists but version doesn't match → PG raises ERR01
  const raiseSql = `DO $$ BEGIN RAISE EXCEPTION 'Optimistic Concurrency Violation' USING ERRCODE = 'ERR01', DETAIL = 'The record exists but the provided version (${expectedVersion}) does not match the current version of ${entityClassName}.'; END $$;`;
  await db.query(raiseSql);
  // Should not reach here — RAISE EXCEPTION aborts the query
  throw new Error(`Entity ${entityClassName}: disambiguation failed to raise ERR01`);
}

/** Runtime check: does this entity metadata have auditable columns? */
export function isAuditableEntity(meta: ReturnType<typeof getEntityPersistenceMeta>): boolean {
  return meta.isAuditable === true || Object.values(meta.columns).some((c) => c.isAuditable);
}

/** Runtime mirror of the `AuditableWriteOptions` contract: a write on an
 *  auditable entity with no resolvable actor throws — an `as any` bypass of
 *  the type overloads must not silently skip actor stamping (audit columns
 *  and trail rows would carry a NULL author). */
function assertWriteActor(meta: ReturnType<typeof getEntityPersistenceMeta>, actor: unknown): void {
  if (isAuditableEntity(meta) && actor === undefined) {
    throw new ValidationError(
      `Write on auditable entity ${meta.entityClassName} requires options.actor — audit columns cannot be stamped without it`,
    );
  }
}

/**
 * Build the RETURNING clause for a single-row write, honoring TResult.
 *
 * - `fields` given: emit exactly those projections (`field` → `"col" AS "alias"`,
 *   `expr` → `expr AS "alias"`). Field projections must target the base entity —
 *   RETURNING cannot reference joined tables.
 * - `fields` absent: emit every persisted column EXCEPT the identity PK
 *   (`id` bigint — not JSON-safe), aliased to its property key.
 *
 * Internal bookkeeping columns (`id`, `uuid`, `version`) are always emitted so
 * the audit path can still read them; they are stripped from the returned
 * object unless the caller explicitly projected them.
 */
/** @internal — shared with the deferred-transaction finalizer (same projection semantics as direct exec). */
export function buildReturningClause(
  entity: EntityClass,
  fields?: FieldProjector[] | null,
): { clause: string; visibleKeys: string[]; rowKeyToSqlName: Map<string, string> } {
  const meta = getEntityPersistenceMeta(entity);
  const pk = findPkColumn(meta);
  const projections: string[] = [];
  const visibleKeys: string[] = [];
  const emittedSqlNames = new Set<string>();
  const rowKeyToSqlName = new Map<string, string>();

  const emit = (sqlName: string, alias: string, visible: boolean) => {
    projections.push(`${quoteIdent(sqlName)} AS ${quoteIdent(alias)}`);
    rowKeyToSqlName.set(alias, sqlName);
    if (visible) visibleKeys.push(alias);
    emittedSqlNames.add(sqlName);
  };

  if (fields && fields.length > 0) {
    for (const f of fields) {
      if (f.kind === "expr") {
        projections.push(`${f.expr} AS ${quoteIdent(f.alias)}`);
        rowKeyToSqlName.set(f.alias, f.alias);
        visibleKeys.push(f.alias);
      } else {
        if (f.field.entity !== entity) {
          throw new ValidationError("returning: field projections must target the base entity — RETURNING cannot reference joined tables");
        }
        const sqlName = getColumnName(entity, f.field.key);
        emit(sqlName, f.alias ?? sqlName, true);
      }
    }
    // Internal bookkeeping — needed by the audit path even when not projected.
    const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);
    for (const sqlName of [pk?.sqlName, "uuid", versionCol?.sqlName]) {
      if (sqlName && meta.columns[sqlName] && !emittedSqlNames.has(sqlName)) {
        emit(sqlName, sqlName, false);
      }
    }
  } else {
    // The PK is hidden only while it is the non-JSON-safe surrogate bigint
    // `id`. A uuid PK is the public uid — it must stay in the response.
    const stripPk = pk !== null && hasSurrogateId(meta);
    for (const c of Object.values(meta.columns)) {
      const isPk = stripPk && c.sqlName === pk!.sqlName;
      emit(c.sqlName, c.propertyKey, !isPk);
    }
  }
  return { clause: `RETURNING ${projections.join(", ")}`, visibleKeys, rowKeyToSqlName };
}

/** Strip internal bookkeeping keys — the result carries exactly the projected keys. @internal */
export function pickReturningRow<TResult>(raw: Record<string, unknown>, visibleKeys: string[]): TResult {
  const out: Record<string, unknown> = {};
  for (const k of visibleKeys) out[k] = raw[k];
  return out as TResult;
}

/** Rebuild a sqlName-keyed record from a RETURNING row (for audit deltas). */
function remapReturningRow(raw: Record<string, unknown>, rowKeyToSqlName: Map<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[rowKeyToSqlName.get(k) ?? k] = v;
  return out;
}

/** Auto-calculate safe batch size to stay under PG's 65535 parameter limit. */
function autoBatchSize(columnCount: number): number {
  if (columnCount <= 0) return 1000;
  return Math.min(1000, Math.floor(65535 / columnCount));
}

export class Repository {
  /**
   * @param bulkTimeoutMs Whole-operation wall-clock budget (ms) for every
   *   *Many method — the transaction must complete within this bound or it is
   *   aborted and rolled back. `0`/`undefined` disables the budget.
   *   Per-call override: `BulkOptions.timeoutMs`.
   */
  constructor(
    private readonly db: Queryable,
    token: typeof REPO_INTERNAL,
    private readonly bulkTimeoutMs: number = 1800000,
  ) {
    if (token !== REPO_INTERNAL) {
      throw new ValidationError(
        "Repository construction is internal to dal-pg — use dal.entityService()/dal.tableAuditPort()",
      );
    }
  }

  /**
   * @internal Entity-event buffer — set by `dal.transaction` on the
   *  tx-scoped Repository. When present, `emitEntityEvent` appends drafts
   *  here instead of publishing: the tx drains them post-COMMIT through
   *  `dal.eventPort`, drops them on ROLLBACK — an event never precedes
   *  its durable write.
   */
  eventBuffer?: EntityEventDraft[];

  /**
   * Emit one entity-domain event for a row that was just written —
   * fire-and-forget (a failing port NEVER fails the write), gated by the
   * entity's `events` meta (`@Entity(..., {events:false|{except}})`).
   * Inside a `dal.transaction` the draft buffers on this repo and is
   * drained by the tx wrapper after COMMIT.
   */
  private emitEntityEvent(
    entity: EntityClass,
    meta: EntityPersistenceMeta,
    options: WriteOptions<any>,
    evt: {
      action: EntityWriteAction;
      uuid: string;
      version?: number;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      delta: Record<string, { old: unknown; new: unknown }> | null;
      entities?: EntityEventDraft["entities"];
    },
  ): void {
    if (!entityEventsEnabled(meta.events, evt.action)) return;
    // Audit-trail INSERTs are internal bookkeeping, not domain writes —
    // without this gate every audited write would emit a shadow event.
    if (meta.isAuditTrailEntity) return;
    if (!this.eventBuffer && !options.events) return;
    const actor = (options as AuditableWriteOptions).actor ?? options.eventActor ?? "system";
    const draft: EntityEventDraft = {
      event: {
        schema: 2,
        entity: entityApiName(entity),
        action: evt.action,
        uuid: evt.uuid,
        version: evt.version,
        emitted_by: actor,
        emitted_at: new Date().toISOString(),
      },
      entity: {
        before: evt.before ? eventSafeRecord(evt.before) : null,
        after: evt.after ? eventSafeRecord(evt.after) : null,
        delta: evt.delta,
      },
      ...(evt.entities ? { entities: evt.entities } : {}),
    };
    if (this.eventBuffer) {
      this.eventBuffer.push(draft);
      return;
    }
    void options.events!.emit(draft).catch((err) =>
      (options.logger ?? noopLogger).error("[DAL Entity Event Error]", err),
    );
  }

  /**
   * Emit THIN per-item events for a bulk op — TEMP-TABLE bulk paths have
   * no RETURNING/oldRecord by contract, so `before`/`after`/`delta` are
   * null; every resolvable `uuid` in the match/row set gets its own event
   * so per-uuid trigger bindings keep working inside a bulk. The grouped
   * op rides `entities` on every member event: `batch` correlates them,
   * `uuids` carries the op's full outcome — each thin event is
   * self-contained. Items without a `uuid` value emit nothing.
   */
  private emitBulkEntityEvents(
    entity: EntityClass,
    meta: EntityPersistenceMeta,
    options: WriteOptions<any>,
    action: EntityWriteAction,
    items: Array<Record<string, unknown>>,
    affected: number,
  ): void {
    if (affected === 0) return;
    if (!entityEventsEnabled(meta.events, action)) return;
    if (!this.eventBuffer && !options.events) return;
    const uuids = items
      .map((item) => item["uuid"])
      .filter((u): u is string => typeof u === "string" && u.length > 0);
    if (uuids.length === 0) return;
    const entities = { batch: newUuidV7(), uuids };
    for (const uuid of uuids) {
      this.emitEntityEvent(entity, meta, options, {
        action,
        uuid,
        before: null,
        after: null,
        delta: null,
        entities,
      });
    }
  }

  /**
   * Opens a dedicated-client transaction for a bulk operation and applies the
   * operation time budget. Budget is enforced twice: `SET LOCAL
   * statement_timeout` bounds each statement (PG-side kill → 57014), and the
   * returned deadline is checked between statements so the whole op cannot
   * outlive the budget even across many fast statements.
   */
  private async bulkBegin(options: { timeoutMs?: number } | undefined): Promise<{ client: PoolClient; deadline: number | null; owned: boolean }> {
    const client = await this.getClient();
    // `owned` = this bulk op opened its own transaction. On a tx-bound
    // repo (dal.transaction) the caller's BEGIN/COMMIT owns the boundary —
    // a nested BEGIN here would warn-no-op and a COMMIT would commit the
    // caller's work early, so both are skipped.
    const owned = this.poolBound();
    if (owned) {
      await client.query("BEGIN");
    }
    const budget = options?.timeoutMs ?? this.bulkTimeoutMs;
    let deadline: number | null = null;
    if (budget !== undefined && budget !== null && budget > 0) {
      await client.query(`SET LOCAL statement_timeout TO ${budget}`);
      deadline = Date.now() + budget;
    }
    return { client, deadline, owned };
  }

  /** Throws when the bulk operation has outlived its wall-clock budget. */
  private assertBulkAlive(deadline: number | null, op: string): void {
    if (deadline !== null && Date.now() >= deadline) {
      throw new BulkTimeoutError(`${op}: exceeded bulk operation timeout — transaction rolled back`);
    }
  }

  /** Rollback for bulk transactions — release stays in the caller's finally. */
  private async bulkAbort(client: PoolClient): Promise<void> {
    await client.query("ROLLBACK").catch(() => {});
  }

  // ─── Finders ───────────────────────────────────────────────────────────────

  /**
   * @deprecated Internal/FK-driven use only. API paths must identify rows by
   * uuid — the INT8 `id` exists for FK/JOIN performance, never for callers.
   */
  async findById<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    id: bigint | string,
    options?: FindByIdOptions
  ): Promise<TResult | null> {
    const throwIfNotFound = options?.throwIfNotFound ?? true;
    const meta = getEntityPersistenceMeta(entity);
    const pk = findPkColumn(meta);
    if (!pk) throw new Error(`Entity ${meta.entityClassName} has no @Key() column`);

    const q = buildSelectQuery({
      entity,
      filters: [Filter.fieldValue(field(entity, pk.propertyKey as any), "=", id)],
      deletedRecords: options?.deletedRecords,
    });

    const r = await this.db.query(q.text, q.values);
    const rows = (r.rows ?? []) as TResult[];

    if (!throwIfNotFound) return rows[0] ?? null;
    if (rows.length === 0) throw new NotFoundError(`No ${meta.tableName} found with id ${id}`);
    if (rows.length > 1) throw new MultipleRowsError(`Expected exactly 1 row, got ${rows.length} for ${meta.tableName} with id ${id}`);
    return rows[0];
  }

  async findByUUID<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    uuid: string,
    options?: FindByUUIDOptions
  ): Promise<TResult | null> {
    const throwIfNotFound = options?.throwIfNotFound ?? true;
    if (!isUuidV7(uuid)) {
      throw new ValidationError(
        `findByUUID on ${getEntityPersistenceMeta(entity).entityClassName}: expected a uuid v7 value, got ${uuid}`,
      );
    }
    const meta = getEntityPersistenceMeta(entity);
    const uuidCol = Object.values(meta.columns).find((c) => c.sqlName === "uuid");
    if (!uuidCol) throw new Error(`Entity ${meta.entityClassName} has no uuid column`);

    const q = buildSelectQuery({
      entity,
      filters: [Filter.fieldValue(field(entity, uuidCol.propertyKey as any), "=", uuid)],
      deletedRecords: options?.deletedRecords,
    });

    const r = await this.db.query(q.text, q.values);
    const rows = (r.rows ?? []) as TResult[];

    if (!throwIfNotFound) return rows[0] ?? null;
    if (rows.length === 0) throw new NotFoundError(`No ${meta.tableName} found with uuid ${uuid}`);
    if (rows.length > 1) throw new MultipleRowsError(`Expected exactly 1 row, got ${rows.length} for ${meta.tableName} with uuid ${uuid}`);
    return rows[0];
  }

  async find<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    fields?: FieldProjector[] | null,
    options?: FindOptions
  ): Promise<TResult | null> {
    const throwIfNotFound = options?.throwIfNotFound ?? true;
    const meta = getEntityPersistenceMeta(entity);

    const q = buildSelectQuery({
      entity,
      fields: fields ?? undefined,
      joins: options?.joins,
      filters: options?.filters,
      sorting: options?.sorting,
      deletedRecords: options?.deletedRecords,
      tableName: options?.tableName,
      groupBy: options?.groupBy,
      having: options?.having,
      limit: 1,
    });
    const r = await this.db.query(q.text, q.values);
    const rows = (r.rows ?? []) as TResult[];

    if (rows.length === 0) {
      if (throwIfNotFound) throw new NotFoundError(`No ${meta.tableName} found matching filters`);
      return null;
    }
    return rows[0];
  }

  /**
   * `exists` — boolean existence probe: `SELECT EXISTS(SELECT 1 …)`. Honors
   * the same `FindOptions` doors that shape a read (`filters`, `joins`,
   * `deletedRecords`, `tableName`, `groupBy`/`having`); sorting/projection
   * are meaningless on a boolean and ignored. Short-circuits at the first
   * matching row — strictly cheaper than `COUNT(*)` or fetching a row to
   * truthiness-check it.
   */
  async exists<TEntity extends object>(
    entity: EntityClass,
    options?: FindOptions
  ): Promise<boolean> {
    const q = buildSelectQuery({
      entity,
      joins: options?.joins,
      filters: options?.filters,
      deletedRecords: options?.deletedRecords,
      tableName: options?.tableName,
      groupBy: options?.groupBy,
      having: options?.having,
      exists: true,
    });
    const r = await this.db.query(q.text, q.values);
    return (r.rows?.[0] as Record<string, unknown> | undefined)?.exists === true;
  }

  async findAll<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    fields?: FieldProjector[] | null,
    options?: FindOptions
  ): Promise<TResult[] | AsyncIterable<TResult>> {
    const meta = getEntityPersistenceMeta(entity);

    if (options?.stream) {
      const q = buildSelectQuery({
        entity,
        fields: fields ?? undefined,
        joins: options.joins,
        filters: options.filters,
        sorting: options.sorting,
        deletedRecords: options.deletedRecords,
        tableName: options.tableName,
        groupBy: options.groupBy,
        having: options.having,
      });
      return createStream<TResult>(this.db, q.text, q.values);
    }

    const q = buildSelectQuery({
      entity,
      fields: fields ?? undefined,
      joins: options?.joins,
      filters: options?.filters,
      sorting: options?.sorting,
      deletedRecords: options?.deletedRecords,
      tableName: options?.tableName,
      groupBy: options?.groupBy,
      having: options?.having,
    });
    const r = await this.db.query(q.text, q.values);
    return (r.rows ?? []) as TResult[];
  }

  /**
   * pgvector nearest-neighbour search — the DAL-native replacement for raw
   * `<=>`-style similarity queries.
   *
   * Emits `ORDER BY <vectorField> <op> $n::vector LIMIT <topK>` with the
   * query vector always bound as a parameter (required for HNSW/ivfflat
   * index usage — never interpolated). Entity-generic: schema, tableName
   * override, filters, projections and soft-delete scoping behave exactly
   * like `findAll`.
   *
   * The result carries a `similarity` score column when `distance` is the
   * default `"<=>"` (cosine — `1 - distance`, higher = closer). For other
   * operators the projected column is `distance` (raw distance, lower =
   * closer).
   */
  async vectorSearch<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    vectorField: FieldRef<TEntity, keyof TEntity & string>,
    queryVector: number[] | string,
    options?: VectorSearchOptions<TEntity>,
  ): Promise<Array<TResult & { similarity?: number; distance?: number }>> {
    const topK = options?.topK ?? 10;
    if (topK <= 0) throw new ValidationError("vectorSearch: topK must be a positive integer");
    const op = options?.distance ?? "<=>";
    const scoreAlias = options?.scoreAlias ?? (op === "<=>" ? "similarity" : "distance");
    const vectorLiteral = Array.isArray(queryVector) ? `[${queryVector.join(",")}]` : queryVector;

    const hybrid = Boolean(
      options?.lexical || options?.keywordBoost?.terms?.length || options?.scoreAdjust
    );
    if (hybrid) {
      if (options?.joins?.length) {
        throw new ValidationError("vectorSearch: hybrid channels do not support joins");
      }
      const q = buildVectorSearchQuery({
        entity,
        field: vectorField,
        op,
        vectorLiteral,
        topK,
        oversample: options?.oversample,
        filters: options?.filters,
        fields: options?.fields ?? undefined,
        deletedRecords: options?.deletedRecords,
        tableName: options?.tableName,
        lexical: options?.lexical,
        keywordBoost: options?.keywordBoost,
        scoreAdjust: options?.scoreAdjust,
      });
      const r = await this.db.query(q.text, q.values);
      return (r.rows ?? []) as Array<TResult & { similarity?: number; distance?: number }>;
    }

    const q = buildSelectQuery({
      entity,
      fields: options?.fields ?? undefined,
      joins: options?.joins,
      filters: options?.filters,
      deletedRecords: options?.deletedRecords,
      tableName: options?.tableName,
      vectorOrder: {
        field: vectorField,
        op,
        vectorLiteral,
        scoreAlias,
      },
      limit: topK,
    });
    const r = await this.db.query(q.text, q.values);
    return (r.rows ?? []) as Array<TResult & { similarity?: number; distance?: number }>;
  }

  async findByPage<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    page: number,
    recordsPerPage: number,
    fields?: FieldProjector[] | null,
    options?: FindOptions
  ): Promise<PaginatedEntity<TResult>> {
    if (page <= 0) throw new ValidationError("Cannot query with page number lower than 1");
    if (recordsPerPage <= 0) throw new ValidationError("Cannot query with records per page lower than 1");

    const limit = recordsPerPage;
    const offset = recordsPerPage * (page - 1);

    const q = buildSelectQuery({
      entity,
      fields: fields ?? undefined,
      joins: options?.joins,
      filters: options?.filters,
      sorting: options?.sorting,
      deletedRecords: options?.deletedRecords,
      tableName: options?.tableName,
      groupBy: options?.groupBy,
      having: options?.having,
      limit,
      offset,
      includeTotalRecordsWindow: true,
    });
    const r = await this.db.query(q.text, q.values);

    const rows = (r.rows ?? []) as Array<TResult & { _total_records?: bigint | null }>;
    const total_records = rows[0]?._total_records ?? 0n;

    const entities = rows.map((x) => {
      const { _total_records, ...rest } = x as any;
      return rest as TResult;
    });

    return { entities, total_records };
  }

  async count(entity: EntityClass, options?: { tableName?: string }): Promise<bigint> {
    const table = options?.tableName
      ? `${quoteIdent(getEntityPersistenceMeta(entity).tableSchema)}.${quoteIdent(options.tableName)}`
      : getQualifiedTableName(entity);
    const r = await this.db.query<{ n: bigint }>(`SELECT COUNT(*) AS n FROM ${table}`, []);
    return r.rows?.[0]?.n ?? 0n;
  }

  /**
   * sequenceAllocate — the ONE counter claim primitive. INTERNAL ENGINE:
   * services call it inside their own `dal.transaction` — it has no route,
   * no RPC, no remote surface. The claim is a single atomic statement:
   *
   *   - the row's own UPDATE takes the row lock — concurrent claimers
   *     serialize on commit order, never interleave ranges (no doubles);
   *   - it lives in the consumer tx, so a ROLLBACK returns the range —
   *     no holes either (unlike PG `nextval`, which can never roll back);
   *   - INSERT..ON CONFLICT covers the first claim of a
   *     (period, partition) atomically — no create-if-missing race.
   *
   * `counter` is NEXT-TO-EMIT: emitting `count` codes with `step` consumes
   * `[counter, counter + (count-1)·step]` and stores `counter + count·step`.
   * RETURNING `first`/`last` is uniform across the INSERT and UPDATE
   * branches. `start` is only used when the counter row is created.
   *
   * SQL moves integers only — the code STRING never touches the database;
   * interpolation lives in `core/sequence.ts` (`renderSequenceRange`).
   */
  async sequenceAllocate(spec: {
    sequence_uuid: string;
    period_key: string;
    partition_key: string;
    count: number;
    step: bigint;
    start: bigint;
    actor: string;
  }): Promise<{ first: bigint; last: bigint }> {
    return this.sequenceAllocateOn(this.db, spec);
  }

  /** The claim primitive bound to an explicit queryable — the seq-bound
   *  resolver calls it on the caller's tx (lazy mini-tx, bulk `client`,
   *  or the inherited tx connection) so counter claim + entity write are
   *  ONE atomic unit. INTERNAL — never routed. */
  private async sequenceAllocateOn(q: Queryable, spec: {
    sequence_uuid: string;
    period_key: string;
    partition_key: string;
    count: number;
    step: bigint;
    start: bigint;
    actor: string;
  }): Promise<{ first: bigint; last: bigint }> {
    if (!Number.isInteger(spec.count) || spec.count < 1) {
      throw new ValidationError(`sequenceAllocate: count must be a positive integer, got ${spec.count}`);
    }
    if (spec.step === 0n) {
      throw new ValidationError("sequenceAllocate: step must be non-zero");
    }
    const table = getQualifiedTableName(SequenceCounterEntity);
    const r = await q.query<{ first: bigint; last: bigint }>(
      `INSERT INTO ${table}
         (uuid, sequence_uuid, period_key, partition_key, counter,
          last_alloc_at, last_alloc_by, last_alloc_count,
          created_at, created_by, updated_at, updated_by, version)
       VALUES (uuidv7(), $1, $2, $3, $4::bigint + $5::bigint * $6::bigint,
               now(), $7, $5::bigint, now(), $8, now(), $8, 1)
       ON CONFLICT (sequence_uuid, period_key, partition_key) DO UPDATE
         SET counter = ${table}.counter + $5::bigint * $6::bigint,
             last_alloc_at = now(),
             last_alloc_by = $7,
             last_alloc_count = $5::bigint,
             updated_at = now(),
             updated_by = $8,
             version = ${table}.version + 1
       RETURNING counter - $5::bigint * $6::bigint AS first,
                 counter - $6::bigint AS last`,
      [
        spec.sequence_uuid,
        spec.period_key,
        spec.partition_key,
        spec.start,
        spec.count,
        spec.step,
        spec.actor,
        spec.actor,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new ValidationError("sequenceAllocate: claim returned no row — identity constraint unreachable");
    return { first: row.first, last: row.last };
  }

  /** Governed counter SET — writes an EXPLICIT next-to-emit value into
   *  `sequence_counters`: the operator's re-seed after legacy imports or
   *  drift. Never allocates, never emits a rendered value. A single
   *  UPSERT is atomic on its own — on a tx-bound repo it joins the
   *  caller's transaction like every other repo op. `actor` is required:
   *  SET exists only behind the governed `sequence.set` RPC which always
   *  has an authenticated operator. */
  async sequenceSet(spec: {
    seq: { uuid: string };
    next: bigint;
    sez?: string | null;
    sez2?: string | null;
    sez3?: string | null;
    at?: Date;
    actor: string;
  }): Promise<{ counter_uuid: string; period_key: string; partition_key: string; counter: bigint }> {
    if (typeof spec.next !== "bigint") {
      throw new ValidationError("sequenceSet: next must be a bigint");
    }
    const q = this.db as Queryable;
    const s = await this.loadSequence(q, spec.seq);
    const parts = validateSequencePartitions(s.pattern, {
      ...(spec.sez !== undefined ? { sez: spec.sez } : {}),
      ...(spec.sez2 !== undefined ? { sez2: spec.sez2 } : {}),
      ...(spec.sez3 !== undefined ? { sez3: spec.sez3 } : {}),
    } as SequencePartitions);
    const partition_key = sequencePartitionKey(s.pattern, parts);
    const period_key = derivePeriodKey(s.pattern.period_kind, spec.at ?? new Date(), s.tz ?? undefined);
    const table = getQualifiedTableName(SequenceCounterEntity);
    const r = await q.query<{ uuid: string; counter: bigint }>(
      `INSERT INTO ${table}
         (uuid, sequence_uuid, period_key, partition_key, counter,
          last_alloc_at, last_alloc_by, last_alloc_count,
          created_at, created_by, updated_at, updated_by, version)
       VALUES (uuidv7(), $1, $2, $3, $4::bigint, NULL, NULL, NULL,
               now(), $5, now(), $5, 1)
       ON CONFLICT (sequence_uuid, period_key, partition_key) DO UPDATE
         SET counter = $4::bigint,
             updated_at = now(),
             updated_by = $6,
             version = ${table}.version + 1
       RETURNING uuid, counter`,
      [s.uuid, period_key, partition_key, spec.next, spec.actor, spec.actor],
    );
    const row = r.rows[0];
    if (!row) throw new ValidationError("sequenceSet: upsert returned no row — identity constraint unreachable");
    return { counter_uuid: row.uuid, period_key, partition_key, counter: row.counter };
  }

  /** Read-only column-usage analysis for a sequence pattern — the
   *  operator's pre-check before `sequenceSet` (or a fresh bind): scans a
   *  physical text column inside the module's own schema with a
   *  pattern-exact, fully-anchored regex (never a prefix LIKE — sibling
   *  sequences sharing a prefix never pollute each other's report).
   *  Target resolves from explicit `table`/`column`, else the bound NAME
   *  `<table>.<field>` carried by the row. Pure SELECTs — nothing is
   *  created or mutated. */
  async sequenceAnalyze(spec: {
    seq: { uuid: string };
    table?: string;
    column?: string;
    sez?: string | null;
    sez2?: string | null;
    sez3?: string | null;
    at?: Date;
  }): Promise<{
    table: string; column: string;
    in_use: bigint;
    max_value: bigint | null;
    suggested_start: bigint;
    next_proposed: string | null;
    next_in_use: boolean;
    conflicts_above: bigint | null;
    partitions: { partition_key: string; in_use: bigint; max_value: bigint | null }[];
    ambiguous: string[];
  }> {
    const q = this.db as Queryable;
    const s = await this.loadSequence(q, spec.seq);
    const pattern = s.pattern;

    // ── target column: explicit, else derived from the `<table>.<field>`
    //    bound NAME carried by the row (display data, not an identity)
    const IDENT = /^[a-z_][a-z0-9_]*$/;
    let table = spec.table;
    let column = spec.column;
    if (table === undefined && column === undefined) {
      const parts = s.name.split(".");
      if (parts.length === 2) { table = parts[0]; column = parts[1]; }
    }
    if (table === undefined || column === undefined) {
      throw new ValidationError(
        "sequenceAnalyze: table and column are required (the sequence name carries no derivable <table>.<field> binding)",
      );
    }
    if (!IDENT.test(table) || !IDENT.test(column)) {
      throw new ValidationError("sequenceAnalyze: table/column must be snake_case identifiers");
    }
    const schema = getSchemaDomain()?.primary ?? "public";
    const colMeta = await q.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      [schema, table, column],
    );
    if (!colMeta.rows[0]) {
      throw new ValidationError(`sequenceAnalyze: ${schema}.${table}.${column} does not exist`);
    }
    if (colMeta.rows[0].data_type !== "character varying" && colMeta.rows[0].data_type !== "text") {
      throw new ValidationError(
        `sequenceAnalyze: ${schema}.${table}.${column} is ${colMeta.rows[0].data_type}, expected text/varchar`,
      );
    }
    const hasDeletedAt = (await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = 'deleted_at'`,
      [schema, table],
    )).rows[0]!.n > 0;

    // ── pattern → anchored POSIX regex; counter + given sez slots are capture groups
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const DATE_W: Record<string, string> = { yyyy: "4", yy: "2", MM: "2", dd: "2", q: "1" };
    let seqIdx = 0;
    const sezIdx = new Map<string, number>();
    let groups = 0;
    const rx = "^" + pattern.segments.map((seg) => {
      if (seg.kind === "literal") return esc(seg.text);
      if (seg.kind === "counter") { seqIdx = ++groups; return `([0-9]{${seg.width > 0 ? `${seg.width},` : ""}})`; }
      if (seg.kind === "date") {
        // `{q}` renders `Q<digit>` (e.g. `Q4`) — a bare width would never match.
        return seg.token === "q" ? "Q[1-4]" : `[0-9]{${DATE_W[seg.token]}}`;
      }
      // time tokens all render zero-padded 2-digit (HH/hh/mm/ss)
      if (seg.kind === "time") return "[0-9]{2}";
      // sez: an explicit ctx value narrows to that partition, else a charset group
      const v = spec[seg.slot];
      if (v !== undefined && v !== null && v !== "") return esc(v);
      sezIdx.set(seg.slot, ++groups);
      return `([A-Za-z0-9][A-Za-z0-9_.\\-/]*)`;
    }).join("") + "$";

    // ── per-partition scan: GROUP BY the captured sez segments
    const qualified = `"${schema}"."${table}"`;
    const alive = hasDeletedAt ? ` AND t."deleted_at" IS NULL` : "";
    const slots = [...pattern.sez_slots];
    const scan = await q.query<{ m: string[] }>(
      `SELECT m FROM (
         SELECT (regexp_match(t."${column}", $1)) AS m
           FROM ${qualified} t WHERE t."${column}" ~ $1${alive}
       ) x`,
      [rx],
    );
    const groups2 = new Map<string, { partition_key: string; in_use: bigint; max_value: bigint | null }>();
    let in_use = 0n;
    let max_value: bigint | null = null;
    for (const r of scan.rows) {
      const m = r.m as string[];
      const n = BigInt(m[seqIdx - 1]);
      in_use += 1n;
      if (max_value === null || n > max_value) max_value = n;
      const key = slots.map((slot, i) => String(m[(sezIdx.get(slot) ?? 0) - 1] ?? "")).join("\x1f");
      const g = groups2.get(key) ?? { partition_key: key, in_use: 0n, max_value: null as bigint | null };
      g.in_use += 1n;
      if (g.max_value === null || n > g.max_value) g.max_value = n;
      groups2.set(key, g);
    }

    // ── counter context for the CURRENT period + default partition —
    //    meaningful only when the partition is fully determined: a
    //    partitioned pattern scanned without sez ctx gets per-partition
    //    stats in `partitions[]` and null counter-context fields.
    const fullyPartitioned = pattern.sez_slots.every(
      (slot) => spec[slot] !== undefined && spec[slot] !== null && spec[slot] !== "",
    );
    let next_proposed: string | null = null;
    let next_in_use = false;
    let conflicts_above: bigint | null = null;
    if (pattern.sez_slots.length === 0 || fullyPartitioned) {
      const parts = validateSequencePartitions(pattern, {
        ...(spec.sez !== undefined ? { sez: spec.sez } : {}),
        ...(spec.sez2 !== undefined ? { sez2: spec.sez2 } : {}),
        ...(spec.sez3 !== undefined ? { sez3: spec.sez3 } : {}),
      } as SequencePartitions);
      const partition_key = sequencePartitionKey(pattern, parts);
      const at = spec.at ?? new Date();
      const period_key = derivePeriodKey(pattern.period_kind, at, s.tz ?? undefined);
      const counterTable = getQualifiedTableName(SequenceCounterEntity);
      const crow = await q.query<{ counter: bigint }>(
        `SELECT counter FROM ${counterTable}
          WHERE sequence_uuid = $1 AND period_key = $2 AND partition_key = $3`,
        [s.uuid, period_key, partition_key],
      );
      const current = crow.rows[0] ? BigInt(crow.rows[0].counter) : s.start;
      next_proposed = renderSequenceValue(pattern, current, at, { tz: s.tz ?? undefined, partitions: parts });
      const [nextHit, conflicts] = await Promise.all([
        q.query<{ n: number }>(`SELECT 1 AS n FROM ${qualified} t WHERE t."${column}" = $1${alive} LIMIT 1`, [next_proposed]),
        q.query<{ n: bigint }>(
          `SELECT count(*)::bigint AS n FROM (
             SELECT (regexp_match(t."${column}", $1)) AS m
               FROM ${qualified} t WHERE t."${column}" ~ $1${alive}
           ) x WHERE (m)[${seqIdx}]::bigint >= $2`,
          [rx, current],
        ),
      ]);
      next_in_use = nextHit.rows.length > 0;
      conflicts_above = BigInt(conflicts.rows[0]!.n);
    }

    // ── ambiguity: OTHER registry sequences whose pattern also matches
    const seqTable = getQualifiedTableName(SequenceEntity);
    const others = await q.query<{ name: string; pattern: string }>(
      `SELECT name, pattern FROM ${seqTable} WHERE uuid <> $1 AND deleted_at IS NULL`,
      [s.uuid],
    );
    const ambiguous: string[] = [];
    for (const o of others.rows) {
      let opattern: SequencePattern;
      try {
        opattern = parseSequencePattern(o.pattern);
      } catch {
        continue; // a corrupt registry pattern can match nothing — skip
      }
      const orx = "^" + opattern.segments.map((seg) => {
        if (seg.kind === "literal") return esc(seg.text);
        if (seg.kind === "counter") return `[0-9]{${seg.width > 0 ? `${seg.width},` : ""}}`;
        if (seg.kind === "date") {
          return seg.token === "q" ? "Q[1-4]" : `[0-9]{${DATE_W[seg.token]}}`;
        }
        if (seg.kind === "time") return "[0-9]{2}";
        return `[A-Za-z0-9][A-Za-z0-9_.\\-/]*`;
      }).join("") + "$";
      const hit = await q.query(`SELECT 1 FROM ${qualified} t WHERE t."${column}" ~ $1${alive} LIMIT 1`, [orx]);
      if (hit.rows.length > 0) ambiguous.push(o.name);
    }

    return {
      table, column,
      in_use,
      max_value,
      suggested_start: (max_value ?? s.start - s.step) + s.step,
      next_proposed,
      next_in_use,
      conflicts_above,
      partitions: [...groups2.values()],
      ambiguous,
    };
  }

  // ─── seq-bound column resolution ──────────────────────────────────────
  // A column bound via @SequenceField never stores a raw literal through
  // the Repository: on write the value is either a sequence directive —
  // `{seq:uuid}` / `{seq:{uuid}}` / `{seq:{pattern,step,start}}` — or
  // omitted on create, which allocates the field's default sequence
  // (`<table>.<field>`). The counter claim and the entity write always
  // share ONE transaction: pool-bound calls run inside a lazy mini-tx,
  // a tx-bound repo joins the caller's transaction.

  /** Columns carrying a @SequenceField binding. */
  private seqBoundColumns(meta: EntityPersistenceMeta) {
    return Object.values(meta.columns).filter((c) => c.seqBound !== undefined);
  }

  /** Lazy atomicity wrapper for pool-bound seq work: opens a mini-tx on
   *  a dedicated client and runs `fn` against a client-bound repo. Events
   *  the inner repo emits buffer and drain AFTER COMMIT through the
   *  caller's events port — the same post-commit contract
   *  `dal.transaction` gives its txRepo. A tx-bound repo never reaches
   *  this wrapper — it resolves inline on the caller's connection. */
  private async withSeqTx<T>(
    options: WriteOptions<any>,
    fn: (r: Repository) => Promise<T>,
  ): Promise<T> {
    const client = await (this.db as Pool).connect();
    const txRepo = new Repository(client, REPO_INTERNAL, this.bulkTimeoutMs);
    txRepo.eventBuffer = [];
    try {
      await client.query("BEGIN");
      const out = await fn(txRepo);
      await client.query("COMMIT");
      const drafts = txRepo.eventBuffer ?? [];
      txRepo.eventBuffer = undefined;
      for (const d of drafts) {
        void options.events?.emit(d).catch((err) =>
          (options.logger ?? noopLogger).error("[DAL Entity Event Error]", err));
      }
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Is this repo pool-bound (needs the lazy mini-tx) or already
   *  transaction-bound (joins the caller tx inline)? The discriminator is
   *  `release` — a PoolClient has it, a Pool does not; BOTH have `connect`
   *  (PoolClient.connect throws once connected). */
  private poolBound(): boolean {
    return typeof (this.db as PoolClient).release !== "function";
  }

  /** Fetch a sequence row by uuid — null when absent/soft-deleted. */
  private async querySequence(
    q: Queryable,
    by: { uuid: string },
  ): Promise<{ uuid: string; name: string; pattern: SequencePattern; step: bigint; start: bigint; tz: string | null } | null> {
    const table = getQualifiedTableName(SequenceEntity);
    const r = await q.query<{ uuid: string; name: string; pattern: string; step: bigint; start: bigint; tz: string | null }>(
      `SELECT "uuid","name","pattern","step","start","tz" FROM ${table}
        WHERE "uuid" = $1 AND "deleted_at" IS NULL`,
      [by.uuid],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      uuid: row.uuid,
      name: row.name,
      pattern: parseSequencePattern(row.pattern),
      // bigint columns arrive as strings on pools without the INT8 parser
      // (bare probe pools, non-dal consumers) — coerce so JS arithmetic
      // never silently degrades to string concat.
      step: BigInt(row.step),
      start: BigInt(row.start),
      tz: row.tz,
    };
  }

  /** Strict sequence lookup — missing → SEQUENCE_NOT_FOUND carrying the
   *  requested uuid (never a silent fallback to a default). */
  private async loadSequence(
    q: Queryable,
    by: { uuid: string },
  ): Promise<{ uuid: string; name: string; pattern: SequencePattern; step: bigint; start: bigint; tz: string | null }> {
    const spec = await this.querySequence(q, by);
    if (!spec) throw new SequenceNotFoundError(by.uuid);
    return spec;
  }

  /** Idempotent sequence-row provisioning — INSERT ... ON CONFLICT (uuid)
   *  DO NOTHING, then re-read the STORED row: an operator-managed row
   *  under the same deterministic uuid always wins over the decl. The
   *  uuid is derived (`sequenceBoundUuid(seed)`) — the row identity is
   *  known before it exists, so uuid is the ONLY functional key. */
  private async materializeSequenceRow(
    q: Queryable,
    uuid: string,
    name: string,
    decl: SequenceDecl,
    actor: string,
  ): Promise<{ uuid: string; name: string; pattern: SequencePattern; step: bigint; start: bigint; tz: string | null }> {
    const table = getQualifiedTableName(SequenceEntity);
    await q.query(
      `INSERT INTO ${table}
         ("uuid","name","pattern","step","start","tz","created_at","created_by","updated_at","updated_by","version")
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7, now(), $7, 1)
       ON CONFLICT ("uuid") DO NOTHING`,
      [uuid, name, decl.pattern, decl.step, decl.start, decl.tz ?? null, actor],
    );
    const spec = await this.querySequence(q, { uuid });
    if (!spec) throw new SequenceNotFoundError(uuid);
    return spec;
  }

  /** Field-scoped expression materialization: an expr directive owns a
   *  sequence row whose uuid derives as `<bound.name>|expr|<hash16>` —
   *  identical exprs on DIFFERENT fields never share a counter; runtime
   *  sharing only happens through an explicit `{seq:{uuid}}` mapping.
   *  The row's NAME (`<table>.<field>@expr_<hash>`) is display-only.
   *  Idempotent via ON CONFLICT (uuid). */
  private async materializeExprSequence(
    q: Queryable,
    bound: SequenceBound,
    decl: SequenceDecl,
    actor: string,
  ): Promise<{ uuid: string; name: string; pattern: SequencePattern; step: bigint; start: bigint; tz: string | null }> {
    const hash = sha256Hex(`${decl.pattern}|${decl.step}|${decl.start}|${decl.tz ?? ""}`).slice(0, 16);
    return this.materializeSequenceRow(
      q,
      sequenceBoundUuid(`${bound.name}|expr|${hash}`),
      `${bound.name}@expr_${hash}`.slice(0, 100),
      decl,
      actor,
    );
  }

  /** The field's declared default: strict lookup, self-provisioning from
   *  the @SequenceField decl when the registry row is absent — an
   *  operator-edited row stays authoritative via ON CONFLICT. */
  private async loadOrMaterializeBound(
    q: Queryable,
    bound: SequenceBound,
    actor: string,
  ): Promise<{ uuid: string; name: string; pattern: SequencePattern; step: bigint; start: bigint; tz: string | null }> {
    const found = await this.querySequence(q, { uuid: bound.uuid });
    return found ?? this.materializeSequenceRow(q, bound.uuid, bound.name, bound, actor);
  }

  /** Resolve the sequence spec for a directive (or null = field default). */
  private async sequenceSpecFor(
    q: Queryable,
    bound: SequenceBound,
    dir: SequenceDirective | null,
    actor: string,
  ): Promise<{
    uuid: string;
    pattern: SequencePattern;
    step: bigint;
    start: bigint;
    tz: string | null;
    partitions: SequencePartitions;
    at?: Date;
  }> {
    const base = (spec: {
      uuid: string; name: string; pattern: SequencePattern; step: bigint; start: bigint; tz: string | null;
    }, ctx: { partitions: SequencePartitions; at?: Date }) => ({ ...spec, ...ctx });
    if (dir === null) {
      return base(await this.loadOrMaterializeBound(q, bound, actor), { partitions: {} });
    }
    const s = dir.seq;
    if (typeof s === "string") {
      return base(await this.loadSequence(q, { uuid: s }), { partitions: {} });
    }
    const ctx: { partitions: SequencePartitions; at?: Date } = {
      partitions: Object.fromEntries(
        (["sez", "sez2", "sez3"] as const).filter((k) => s[k] !== undefined).map((k) => [k, s[k]!]),
      ) as SequencePartitions,
      ...(s.at !== undefined ? { at: new Date(s.at) } : {}),
    };
    if ("uuid" in s) {
      return base(await this.loadSequence(q, { uuid: s.uuid }), ctx);
    }
    return base(await this.materializeExprSequence(q, bound, s, actor), ctx);
  }

  /** Claim `count` values on the resolved spec and render them. */
  private async allocateAndRender(
    q: Queryable,
    spec: Awaited<ReturnType<Repository["sequenceSpecFor"]>>,
    colLength: number | undefined,
    count: number,
    actor: string,
  ): Promise<string[]> {
    const { uuid, pattern, step, start, tz, partitions } = spec;
    const parts = validateSequencePartitions(pattern, partitions);
    const partition_key = sequencePartitionKey(pattern, parts);
    const at = spec.at ?? new Date();
    const period_key = derivePeriodKey(pattern.period_kind, at, tz ?? undefined);
    const claim = await this.sequenceAllocateOn(q, {
      sequence_uuid: uuid,
      period_key,
      partition_key,
      count,
      step,
      start,
      actor,
    });
    const rendered =
      count === 1
        ? [renderSequenceValue(pattern, claim.first, at, { tz: tz ?? undefined, partitions: parts })]
        : renderSequenceRange(pattern, claim.first, step, count, at, { tz: tz ?? undefined, partitions: parts });
    for (const value of rendered) {
      if (colLength !== undefined && value.length > colLength) {
        throw new ValidationError(
          `sequence value exceeds column length ${colLength}: ${value.length} chars rendered by pattern "${pattern.source}"`,
        );
      }
    }
    return rendered;
  }

  /** Single-row seq resolution — mutates `rec` in place: every seq-bound
   *  column exits holding a rendered literal (or absent on update).
   *  STRICT: a raw literal reaching the repository is rejected even when
   *  the API-layer predicate was bypassed. */
  private async resolveSeqColumns(
    q: Queryable,
    meta: EntityPersistenceMeta,
    rec: Record<string, unknown>,
    mode: "create" | "update",
    actor: string,
  ): Promise<void> {
    for (const col of Object.values(meta.columns)) {
      const bound = col.seqBound;
      if (!bound) continue;
      const value = rec[col.propertyKey];
      if (value === undefined || value === null) {
        if (mode === "update") continue;
        const spec = await this.sequenceSpecFor(q, bound, null, actor);
        [rec[col.propertyKey]] = await this.allocateAndRender(q, spec, col.length, 1, actor);
        continue;
      }
      const dir = parseSequenceDirective(value);
      if (!dir) {
        throw new ValidationError(
          `${meta.entityClassName}.${col.propertyKey}: seq-bound column accepts only a sequence directive — raw literals are rejected`,
        );
      }
      const spec = await this.sequenceSpecFor(q, bound, dir, actor);
      [rec[col.propertyKey]] = await this.allocateAndRender(q, spec, col.length, 1, actor);
    }
  }

  /** Bulk seq resolution — STRICT bulk contract: a seq-bound column must
   *  carry the SAME directive on every row, or be absent on every row
   *  (absent = field-default allocation on create). Mixed directives or
   *  mixed presence are rejected. ONE contiguous counter claim covers the
   *  whole group (`count:N`), then literals map back row-by-row. */
  private async resolveSeqRows(
    q: Queryable,
    meta: EntityPersistenceMeta,
    rows: Array<Record<string, unknown>>,
    actor: string,
    mode: "create" | "update",
  ): Promise<void> {
    for (const col of Object.values(meta.columns)) {
      const bound = col.seqBound;
      if (!bound) continue;
      const groups = new Map<string, { dir: SequenceDirective | null; idxs: number[] }>();
      rows.forEach((rec, i) => {
        const value = rec[col.propertyKey];
        const dir = value === undefined || value === null ? null : parseSequenceDirective(value);
        if (value !== undefined && value !== null && !dir) {
          throw new ValidationError(
            `${meta.entityClassName}.${col.propertyKey}: seq-bound column accepts only a sequence directive — raw literals are rejected`,
          );
        }
        const groupKey = dir === null ? "" : sha256Hex(extJsonStringify(dir.seq));
        const g = groups.get(groupKey) ?? { dir, idxs: [] };
        g.idxs.push(i);
        groups.set(groupKey, g);
      });
      if (groups.size > 1) {
        throw new ValidationError(
          `${meta.entityClassName}.${col.propertyKey}: bulk seq-bound writes require the same directive on every row (or none) — mixed directives are rejected`,
        );
      }
      for (const g of groups.values()) {
        // update mode: all-absent = column untouched, never default-allocates.
        if (mode === "update" && g.dir === null) continue;
        const spec = await this.sequenceSpecFor(q, bound, g.dir, actor);
        const rendered = await this.allocateAndRender(q, spec, col.length, g.idxs.length, actor);
        g.idxs.forEach((rowIdx, j) => {
          rows[rowIdx]![col.propertyKey] = rendered[j];
        });
      }
    }
  }

  /**
   * distinctAuditActors — the governed vocabulary behind
   * `options_source:"audit.actors"`: DISTINCT values across the entity's
   * audit actor columns (`@AuditableField(CREATED_BY|UPDATED_BY)` +
   * `@DeletableField(DELETED_BY)`), label-resolved through
   * `public.user_profiles` — the same cross-app platform join every
   * auditable read already performs. uuid-shaped actors get the profile
   * `display_name`; fictitious writers (`system`, `migration-*`, nats
   * subjects) have no profile row and surface their raw value — the
   * vocab is "actors that wrote THIS table", NOT the users table, so a
   * plain entity-ref combo could never offer them.
   */
  async distinctAuditActors(
    entity: EntityClass,
  ): Promise<{ value: string; label: string }[]> {
    const meta = getEntityPersistenceMeta(entity);
    const actorCols = Object.values(meta.columns)
      .filter(
        (c) =>
          c.auditableType === AuditableFieldType.CREATED_BY ||
          c.auditableType === AuditableFieldType.UPDATED_BY ||
          c.deletableType === DeletableFieldType.DELETED_BY,
      )
      .map((c) => c.sqlName);
    if (actorCols.length === 0) return [];
    const table = `${quoteIdent(meta.tableSchema)}.${quoteIdent(meta.tableName)}`;
    const union = actorCols
      .map(
        (c) =>
          `SELECT ${quoteIdent(c)} AS actor FROM ${table} WHERE ${quoteIdent(c)} IS NOT NULL`,
      )
      .join("\n    UNION\n    ");
    // The regex guardrail on the LEFT side mirrors the audit-trail join —
    // a non-uuid actor must not trip the uuid comparison cast. The second
    // join resolves `system:<code>` writers through the platform registry
    // (the CASE guard keeps other `x:<code>` actors from false-matching) —
    // `migration-*` and other unresolvable writers keep the raw value.
    const r = await this.db.query<{ value: unknown; label: unknown }>(
      `SELECT a.actor AS value, COALESCE(up."display_name", sr."name", a.actor) AS label
       FROM (
         ${union}
       ) a
       LEFT JOIN "public"."user_profiles" up
         ON a.actor ~ '^[0-9a-fA-F-]{36}$' AND up."uuid"::text = a.actor
       LEFT JOIN "public"."service_registry" sr
         ON sr."code" = CASE WHEN a.actor LIKE 'system:%' THEN split_part(a.actor, ':', 2) END
       ORDER BY label`,
      [],
    );
    return (r.rows ?? []).map((row) => ({
      value: String(row.value),
      label: row.label === null || row.label === undefined ? String(row.value) : String(row.label),
    }));
  }

  /**
   * Physical table reset — `TRUNCATE TABLE <schema>.<table>` resolved through
   * entity metadata, like every other entity op: the schema-domain guard
   * applies (entities outside the declared domain throw before any SQL).
   * For auditable tables prefer soft-delete; TRUNCATE is for caches, KB
   * stores, and test teardown.
   */
  async truncate(
    entity: EntityClass,
    options?: { restartIdentity?: boolean; cascade?: boolean },
  ): Promise<void> {
    const table = getQualifiedTableName(entity);
    const flags = `${options?.restartIdentity ? " RESTART IDENTITY" : ""}${options?.cascade ? " CASCADE" : ""}`;
    await this.db.query(`TRUNCATE TABLE ${table}${flags}`);
  }

  // ─── Write ops ─────────────────────────────────────────────────────────────

  /** Add — auditable entity (actor required). */
  async add<TEntity extends object & IAuditableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions<TEntity>,
  ): Promise<TResult>;
  /** Add — non-auditable entity (actor rejected). */
  async add<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions<TEntity>,
  ): Promise<TResult>;
  async add<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions<TEntity> | AuditableWriteOptions<TEntity>,
  ): Promise<TResult> {
    const meta = getEntityPersistenceMeta(entity);
    const table = options.tableName
      ? `${quoteIdent(meta.tableSchema)}.${quoteIdent(options.tableName)}`
      : getQualifiedTableName(entity);
    const pk = findPkColumn(meta);
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    assertWriteActor(meta, actor);

    // Seq-bound columns: directives resolve to literals and omissions on
    // create allocate the field default — inside ONE transaction with the
    // INSERT (lazy mini-tx when pool-bound, the caller's tx otherwise).
    const seqCols = this.seqBoundColumns(meta);
    if (seqCols.length > 0) {
      if (actor === undefined) {
        throw new ValidationError(
          `add: seq-bound write on ${meta.entityClassName} requires options.actor — the counter claim is audited`,
        );
      }
      if (this.poolBound()) {
        return this.withSeqTx(options, (r) => r.add(entity as never, row as never, options as never) as Promise<TResult>);
      }
      await this.resolveSeqColumns(this.db, meta, row as Record<string, unknown>, "create", actor);
    }

    const rec = row as Record<string, unknown>;
    let keys = Object.keys(rec).filter((k) => rec[k] !== undefined);

    // Drop identity PK unless explicitly provided
    if (pk && meta.columns[pk.sqlName]?.usePostgresIdentity) {
      keys = keys.filter((k) => k !== pk!.propertyKey);
    }

    if (keys.length === 0) {
      throw new ValidationError("add: no columns to insert (all undefined?)");
    }

    // Validate keys exist in meta
    for (const k of keys) {
      const sqlName = getColumnName(entity, k);
      if (!meta.columns[sqlName]) {
        throw new UnknownColumnError(`add: unknown column/property ${k}`);
      }
    }

    // App-injected uids must be v7 (the PG uuidv7() default only covers omissions)
    const uidCol = Object.values(meta.columns).find((c) => c.sqlName === "uuid");
    if (uidCol && rec[uidCol.propertyKey] !== undefined) {
      assertUuidV7Value(meta.entityClassName, uidCol.propertyKey, rec[uidCol.propertyKey]);
    }

    // Stamp audit fields if entity is auditable
    const now = new Date();
    const values: unknown[] = [];
    const colsSql: string[] = [];
    const params: string[] = [];

    // Attempted insert values by property key → "$n" — reused by the
    // conflict-reporting predicates (the attempted value is what identifies
    // a pre-existing conflicting row).
    const attemptedParam = new Map<string, string>();

    for (const k of keys) {
      const sqlName = getColumnName(entity, k);
      const colMeta = meta.columns[sqlName];
      colsSql.push(quoteIdent(sqlName));
      const rawVal = rec[k] ?? null;
      const pgVal = colMeta ? jsValueToPgParam(rawVal, columnHintsFromMetaColumn(colMeta)) : rawVal;
      values.push(pgVal);
      params.push(`$${values.length}`);
      attemptedParam.set(k, `$${values.length}`);
    }

    // Add audit stamping
    if (auditable && actor !== undefined) {
      const createdAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.CREATED_AT);
      const createdByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.CREATED_BY);
      const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
      const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);

      if (createdAtCol && !keys.includes(createdAtCol.propertyKey)) {
        colsSql.push(quoteIdent(createdAtCol.sqlName));
        values.push(now);
        params.push(`$${values.length}`);
        attemptedParam.set(createdAtCol.propertyKey, `$${values.length}`);
      }
      if (createdByCol && !keys.includes(createdByCol.propertyKey)) {
        colsSql.push(quoteIdent(createdByCol.sqlName));
        values.push(actor);
        params.push(`$${values.length}`);
        attemptedParam.set(createdByCol.propertyKey, `$${values.length}`);
      }
      if (updatedAtCol && !keys.includes(updatedAtCol.propertyKey)) {
        colsSql.push(quoteIdent(updatedAtCol.sqlName));
        values.push(now);
        params.push(`$${values.length}`);
        attemptedParam.set(updatedAtCol.propertyKey, `$${values.length}`);
      }
      if (updatedByCol && !keys.includes(updatedByCol.propertyKey)) {
        colsSql.push(quoteIdent(updatedByCol.sqlName));
        values.push(actor);
        params.push(`$${values.length}`);
        attemptedParam.set(updatedByCol.propertyKey, `$${values.length}`);
      }
    }

    const onConflict = options.onConflict ?? "raise";
    const ret = buildReturningClause(entity, options.returning);
    const insertSql = `INSERT INTO ${table} (${colsSql.join(", ")}) VALUES (${params.join(", ")})`;

    let sql: string;
    let reporting = false;
    if (onConflict === "ignore") {
      // Statement-level idempotent insert: bare ON CONFLICT DO NOTHING skips a
      // conflicting row without aborting the surrounding transaction
      // (RETURNING yields zero rows → inserted undefined).
      sql = `${insertSql} ON CONFLICT DO NOTHING ${ret.clause}`;
    } else {
      // "raise" — conflict-reporting CTE. The attempted values are matched
      // against the entity's unique groups to find the pre-existing row; the
      // `raised` CTE calls pg_raise so PG itself emits ERR04 (live row) or
      // ERR05 (soft-deleted row) with uuid + constraint in DETAIL.
      const predicates = this.uniqueConflictPredicates(entity, meta, attemptedParam, options.conflictKeys);
      if (predicates.length === 0) {
        // No identifiable unique group (e.g. only DB-generated uniques) —
        // fall back to a plain strict INSERT; a raw 23505 still surfaces.
        sql = `${insertSql} ${ret.clause}`;
      } else {
        reporting = true;
        const uuidSel = meta.columns["uuid"] ? `t.${quoteIdent("uuid")}` : "NULL";
        const deletedAtCol = Object.values(meta.columns).find(
          (c) => c.deletableType === DeletableFieldType.DELETED_AT,
        );
        const deletedSel = deletedAtCol ? `t.${quoteIdent(deletedAtCol.sqlName)}` : "NULL";
        const whereOr = predicates.map((p) => `(${p.sql})`).join("\n        OR ");
        const constraintCase = predicates
          .map((p) => `WHEN (${p.sql}) THEN ${escapeLiteral(p.name)}`)
          .join(" ");
        const keysCase = predicates
          .map(
            (p) =>
              `WHEN (${p.sql}) THEN jsonb_build_object(${p.keyRefs
                .map((k) => `${escapeLiteral(k.sqlName)}, ${k.ref}`)
                .join(", ")})`,
          )
          .join(" ");
        sql = `WITH ins AS (
  ${insertSql}
  ON CONFLICT DO NOTHING
  ${ret.clause}
),
conflict AS (
  SELECT ${uuidSel} AS c_uuid, ${deletedSel} AS c_deleted_at,
         CASE ${constraintCase} END AS c_constraint,
         CASE ${keysCase} END AS c_keys
  FROM ${table} t
  WHERE ${whereOr}
  LIMIT 1
),
raised AS (
  SELECT public.pg_raise(
    ${this.conflictErrCode(entity, meta, "c.c_deleted_at", "c.c_constraint")},
    ${escapeLiteral(`add: unique constraint violation on ${meta.entityClassName}`)},
    jsonb_build_object(
      'entity', ${escapeLiteral(meta.entityClassName)},
      'table', ${escapeLiteral(`${meta.tableSchema}.${meta.tableName}`)},
      'uuid', c.c_uuid::text,
      'constraint', c.c_constraint,
      'keys', c.c_keys
    )::text
  ) AS _raised
  FROM conflict c
)
SELECT ins.* FROM ins WHERE NOT EXISTS (SELECT 1 FROM raised)`;
      }
    }

    const result = await this.db.query(sql, values);
    const inserted = result.rows?.[0] as Record<string, unknown> | undefined;

    // raise-mode CTE returned zero rows: a unique conflict happened on a group
    // whose attempted values were not all identifiable (e.g. a DB-generated
    // uuid) — no row to report, so raise the generic typed error.
    if (!inserted && reporting) {
      throw new DuplicateRecordError(
        `add: unique constraint violation on ${meta.entityClassName} — conflicting row not identifiable`,
      );
    }

    const insertedRecord = inserted ? remapReturningRow(inserted, ret.rowKeyToSqlName) : undefined;

    // Write audit if port is injected (skipped when the row was a no-op conflict)
    if (insertedRecord && auditable && options.audit && pk && actor !== undefined) {
      const entityId = auditEntityId(insertedRecord);
      const entityUuid = (insertedRecord["uuid"] ?? "") as string;
      // Use the full inserted record (RETURNING) as the delta source —
      // all projected columns plus internal bookkeeping (id/uuid/version).
      const delta = calculateDelta({}, insertedRecord);
      options.audit.writeAudit({
        entityClassName: meta.entityClassName,
        tableName: meta.tableName,
        entityId,
        entityUuid,
        action: AuditAction.INSERT,
        changedAt: now,
        version: 1,
        changedBy: actor,
        delta,
      }).catch((err) => (options.logger ?? noopLogger).error("[DAL Audit Error]", err));
    }

    if (insertedRecord && pk) {
      const safe = eventSafeRecord(insertedRecord);
      this.emitEntityEvent(entity, meta, options, {
        action: "create",
        uuid: (insertedRecord["uuid"] as string) ?? "",
        version: (insertedRecord["version"] as number) ?? 1,
        before: null,
        after: insertedRecord,
        delta: calculateDelta({}, safe),
      });
    }

    // May be undefined when onConflict === "ignore" and the row was skipped.
    return inserted === undefined ? (undefined as TResult) : pickReturningRow<TResult>(inserted, ret.visibleKeys);
  }

  /**
   * Unique groups of the entity, derived purely from metadata:
   * - `@Unique()` single-column → group keyed by the column's sqlName.
   * - `@Unique(name, order)` → all columns sharing `name`, ordered by `order`.
   */
  private uniqueConflictGroups(
    meta: EntityPersistenceMeta,
  ): { name: string; cols: EntityPersistenceMeta["columns"][string][] }[] {
    type Col = EntityPersistenceMeta["columns"][string];
    const groups: { name: string; cols: Col[] }[] = [];
    const named = new Map<string, Col[]>();
    for (const c of Object.values(meta.columns)) {
      if (!c.isUnique) continue;
      if (c.uniqueIndexName) {
        const arr = named.get(c.uniqueIndexName) ?? [];
        arr.push(c);
        named.set(c.uniqueIndexName, arr);
      } else {
        groups.push({ name: c.sqlName, cols: [c] });
      }
    }
    for (const [name, cols] of named) {
      cols.sort((a, b) => (a.uniqueIndexOrder ?? 0) - (b.uniqueIndexOrder ?? 0));
      groups.push({ name, cols });
    }
    return groups;
  }

  /**
   * Resolve the full identity condition set for a single-row write.
   *
   * Rules (ERR09 = MatchSelectorError, thrown pre-SQL):
   * - `id` (@Key) and `uuid` present in the payload always become AND
   *   conditions (implicit cross-check — incoherent pairs surface as
   *   ERR10 downstream).
   * - Each `matchBy` prop must be a `@Key`/`@Unique` column; a prop in a
   *   composite `@Unique` group pulls in the WHOLE group — every group
   *   prop must be present in the payload.
   * - At least one condition is required (no identity → ERR09).
   *
   * All condition props are stripped from the returned payload (a match
   * column is never a SET column in the same call).
   */
  /**
   * Pure shape resolution shared by single-row and bulk writes: validates the
   * `matchBy` selector (each prop must be a persisted `@Unique`/`@Key` column)
   * and expands composite `@Unique` groups to the complete prop set.
   * Illegal selector → ERR09 (MatchSelectorError), thrown before any SQL.
   */
  private resolveSelectorProps(
    meta: EntityPersistenceMeta,
    matchBy: string | readonly string[] | undefined,
  ): Set<string> {
    const entityName = meta.entityClassName;
    const colByProp = new Map(Object.values(meta.columns).map((c) => [c.propertyKey, c]));
    const pk = findPkColumn(meta);

    const groups = this.uniqueConflictGroups(meta);
    const groupOf = new Map<string, { name: string; cols: typeof meta.columns[string][] }>();
    for (const g of groups) for (const c of g.cols) groupOf.set(c.propertyKey, g);

    const requested = matchBy == null ? [] : typeof matchBy === "string" ? [matchBy] : [...matchBy];
    const required = new Set<string>();
    for (const prop of requested) {
      const col = colByProp.get(prop);
      if (!col) {
        throw new MatchSelectorError(
          `matchBy: '${prop}' is not a column of ${entityName}`,
        );
      }
      const g = groupOf.get(prop);
      if (prop !== pk?.propertyKey && !g) {
        throw new MatchSelectorError(
          `matchBy: '${prop}' on ${entityName} is not a @Unique/@Key column — ` +
            `writes must uniquely identify the target row(s)`,
        );
      }
      if (g) for (const c of g.cols) required.add(c.propertyKey);
      else required.add(prop);
    }
    return required;
  }

  private resolveMatchConditions(
    meta: EntityPersistenceMeta,
    payload: Record<string, unknown>,
    matchBy: string | readonly string[] | undefined,
  ): { conditions: MatchCondition[]; remaining: Record<string, unknown> } {
    const entityName = meta.entityClassName;
    const colByProp = new Map(Object.values(meta.columns).map((c) => [c.propertyKey, c]));
    const pk = findPkColumn(meta);
    const uuidCol = Object.values(meta.columns).find((c) => c.sqlName === "uuid");

    const required = this.resolveSelectorProps(meta, matchBy);
    for (const prop of required) {
      if (payload[prop] === undefined) {
        throw new MatchSelectorError(
          `matchBy on ${entityName}: '${prop}' is required in the payload (composite @Unique group must be complete)`,
        );
      }
    }

    // Auto-identity: id/uuid present in the payload always AND into the match
    for (const prop of [pk?.propertyKey, uuidCol?.propertyKey]) {
      if (prop && payload[prop] !== undefined) required.add(prop);
    }

    const conditions: MatchCondition[] = [];
    const remaining = { ...payload };
    for (const prop of required) {
      const col = colByProp.get(prop)!;
      if (col.sqlName === "uuid") {
        assertUuidV7Value(entityName, prop, payload[prop]);
      }
      conditions.push({
        propertyKey: prop,
        sqlName: col.sqlName,
        value: payload[prop],
        hints: columnHintsFromMetaColumn(col),
      });
      delete remaining[prop];
    }
    if (conditions.length === 0) {
      throw new MatchSelectorError(
        `write on ${entityName}: payload carries no identity field — provide id, uuid, or a complete matchBy @Unique selector`,
      );
    }
    return { conditions, remaining };
  }

  /**
   * Bulk identity resolution — same contract as `resolveMatchConditions` but
   * applied to a homogeneous item array. Runs ONCE per operation: selector
   * legality and group expansion come from `resolveSelectorProps`, then every
   * required prop is verified present in EVERY item and auto-identity
   * (`id`/`uuid`) is added only when uniformly present — a temp table is
   * rectangular, so a heterogeneous identity shape is ERR09.
   */
  private resolveBulkMatchColumns(
    meta: EntityPersistenceMeta,
    items: Array<Record<string, unknown>>,
    matchBy: string | readonly string[] | undefined,
    op: string,
  ): { sqlName: string; propertyKey: string; hints: ColumnPgPersistenceHints }[] {
    const entityName = meta.entityClassName;
    const colByProp = new Map(Object.values(meta.columns).map((c) => [c.propertyKey, c]));
    const pk = findPkColumn(meta);
    const uuidCol = Object.values(meta.columns).find((c) => c.sqlName === "uuid");

    const required = this.resolveSelectorProps(meta, matchBy);
    for (const prop of required) {
      const ix = items.findIndex((m) => m[prop] === undefined);
      if (ix !== -1) {
        throw new MatchSelectorError(
          `${op} on ${entityName}: '${prop}' is required in every item (composite @Unique selector must be complete) — missing at index ${ix}`,
        );
      }
    }
    for (const prop of [pk?.propertyKey, uuidCol?.propertyKey]) {
      if (!prop || required.has(prop)) continue;
      const present = items.map((m) => m[prop] !== undefined);
      if (!present.some(Boolean)) continue;
      if (!present.every(Boolean)) {
        const ix = present.findIndex((p) => !p);
        throw new MatchSelectorError(
          `${op} on ${entityName}: '${prop}' is present in some items but missing at index ${ix} — bulk identity must be uniform across the batch`,
        );
      }
      required.add(prop);
    }
    if (required.size === 0) {
      throw new MatchSelectorError(
        `${op} on ${entityName}: items carry no identity field — provide id, uuid, or a complete matchBy @Unique selector`,
      );
    }
    for (const prop of required) {
      const col = colByProp.get(prop)!;
      if (col.sqlName === "uuid") {
        for (const item of items) assertUuidV7Value(entityName, prop, item[prop]);
      }
    }
    return [...required].map((prop) => {
      const c = colByProp.get(prop)!;
      return { sqlName: c.sqlName, propertyKey: prop, hints: columnHintsFromMetaColumn(c) };
    });
  }

  /** `l.a = r.a AND l.b = r.b` join predicate between two aliased relations over the identity columns. */
  private bulkJoinPredicate(left: string, right: string, matchCols: { sqlName: string }[]): string {
    return matchCols
      .map((c) => `${left}.${quoteIdent(c.sqlName)} = ${right}.${quoteIdent(c.sqlName)}`)
      .join(" AND ");
  }

  /**
   * Ambiguity guard for bulk writes: any single tmp item matching more than
   * one target row means the identity is not unique in practice → one
   * pg_raise ERR10 with the offending `row_ix` list, aborting the whole
   * transaction before any write. Set-based — single aggregate join.
   */
  private bulkAmbiguousSql(
    meta: EntityPersistenceMeta,
    table: string,
    matchCols: { sqlName: string }[],
    tmpName: string,
    op: string,
  ): string {
    const join = this.bulkJoinPredicate("t", "tmp", matchCols);
    return `WITH dup AS (
  SELECT tmp.row_ix, count(*) AS hits
  FROM ${quoteIdent(tmpName)} tmp
  JOIN ${table} t ON ${join}
  GROUP BY tmp.row_ix
  HAVING count(*) > 1
),
det AS (
  SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) AS rows
  FROM (SELECT row_ix, hits FROM dup ORDER BY row_ix LIMIT 10) x
)
SELECT public.pg_raise(
  'ERR10',
  ${escapeLiteral(`${op}: ambiguous identity — item(s) matched multiple rows on ${meta.entityClassName}`)},
  jsonb_build_object(
    'entity', ${escapeLiteral(meta.entityClassName)},
    'table', ${escapeLiteral(`${meta.tableSchema}.${meta.tableName}`)},
    'rows', det.rows
  )::text
)
FROM det
WHERE EXISTS (SELECT 1 FROM dup)`;
  }

  /**
   * Zero-row probe for identity incoherence: if the full AND match found no
   * row but a row exists under ANY SINGLE identity field, the caller supplied
   * an incoherent identity (e.g. correct id + wrong uuid) → ERR10.
   * Called only on the error path — the extra probes are acceptable.
   */
  /**
   * Multi-row safety net shared by all single-row writes: `matched` counts
   * every row the identity WHERE would touch; `guard` raises ERR10 if >1 —
   * the raise aborts the whole statement, so nothing is written (atomic).
   */
  private buildGuardCte(
    table: string,
    matchConds: MatchCondition[],
    condParamStart: number,
    matchWhere: string,
    op: string,
  ): string {
    const matchObj = matchConds
      .map((c, i) => `${escapeLiteral(c.sqlName)}, $${condParamStart + i}`)
      .join(", ");
    return `matched AS (
  SELECT * FROM ${table} WHERE ${matchWhere}
),
guard AS (
  SELECT public.pg_raise(
    'ERR10',
    ${escapeLiteral(`${op}: identity match resolved to multiple rows`)},
    jsonb_build_object(
      'table', ${escapeLiteral(table)},
      'match', jsonb_build_object(${matchObj})
    )::text
  ) AS _raised
  WHERE (SELECT count(*) FROM matched) > 1
)`;
  }

  private async assertNoPartialIdentity(
    table: string,
    conditions: MatchCondition[],
    entityClassName: string,
  ): Promise<void> {
    if (conditions.length < 2) return;
    for (const c of conditions) {
      const r = await this.db.query(
        `SELECT 1 FROM ${table} WHERE ${quoteIdent(c.sqlName)} = $1 LIMIT 1`,
        [jsValueToPgParam(c.value, c.hints)],
      );
      if ((r.rowCount ?? 0) > 0) {
        throw new IdentityConflictError(
          `Entity ${entityClassName}: identity mismatch — a row exists for ${c.sqlName}=${String(c.value)} but the supplied identity fields do not converge on it.`,
        );
      }
    }
  }

  /**
   * `defaultSql` values that are safe to embed as literal SQL in a predicate:
   * quoted string literals, numeric literals, booleans, NULL. Anything else
   * (function calls like `gen_random_uuid()`, `now()`) is volatile or
   * DB-generated — the attempted value is unknowable → the group is skipped.
   */
  private constantDefaultSql(defaultSql: string | undefined): string | undefined {
    if (!defaultSql) return undefined;
    const s = defaultSql.trim();
    return /^'(?:[^']|'')*'$|^-?\d+(\.\d+)?$|^(true|false|null)$/i.test(s) ? s : undefined;
  }

  /**
   * Builds the `conflict` CTE predicates for `add()` raise-mode: one term per
   * unique group whose attempted values are all known (payload param or
   * constant defaultSql). `IS NOT DISTINCT FROM` makes the match null-safe
   * (a NULL unique column still conflicts against a stored NULL row's group
   * only when the index treats NULLs as equal — callers ensure the group is
   * meaningful). Groups containing DB-generated columns are skipped: their
   * attempted value is generated inside PG and cannot be bound.
   */
  /**
   * pg_raise code selection for the conflict-reporting CTEs: a
   * reversed-direction match on the `@Relation` pair index is a circular
   * reference (ERR11); otherwise a live-row collision is ERR04 and an
   * all-soft-deleted collision is ERR05.
   */
  private conflictErrCode(
    entity: EntityClass,
    meta: EntityPersistenceMeta,
    deletedRef: string,
    constraintRef: string,
  ): string {
    const rev = getRelationFacet(entity) !== undefined
      ? ` WHEN ${constraintRef} = ${escapeLiteral(`${meta.tableName}_pair_uq_reversed`)} THEN 'ERR11'`
      : "";
    return `CASE${rev} WHEN ${deletedRef} IS NULL THEN 'ERR04' ELSE 'ERR05' END`;
  }

  private uniqueConflictPredicates(
    entity: EntityClass,
    meta: EntityPersistenceMeta,
    attemptedParam: Map<string, string>,
    conflictKeys: string[] | undefined,
  ): { name: string; sql: string; keyRefs: { sqlName: string; ref: string }[] }[] {
    let groups = this.uniqueConflictGroups(meta);

    if (conflictKeys !== undefined) {
      const wanted = new Set<string>();
      for (const pk of conflictKeys) {
        const sqlName = getColumnName(entity, pk);
        if (!meta.columns[sqlName]) {
          throw new UnknownColumnError(`add: conflictKeys — unknown column/property ${pk}`);
        }
        wanted.add(sqlName);
      }
      groups = groups.filter(
        (g) => g.cols.length === wanted.size && g.cols.every((c) => wanted.has(c.sqlName)),
      );
      if (groups.length === 0) {
        throw new ValidationError(
          `add: conflictKeys [${conflictKeys.join(", ")}] match no unique constraint on ${meta.entityClassName}`,
        );
      }
    }

    const predicates: { name: string; sql: string; keyRefs: { sqlName: string; ref: string }[] }[] = [];
    for (const g of groups) {
      const refs: string[] = [];
      const keyRefs: { sqlName: string; ref: string }[] = [];
      let bindable = true;
      for (const c of g.cols) {
        // Attempted value: payload param → constant defaultSql literal → NULL
        // (column omitted, no default → PG stores NULL). A volatile/DB-side
        // default (gen_random_uuid(), now(), identity) makes the value
        // unknowable → the whole group is unidentifiable and skipped.
        const ref =
          attemptedParam.get(c.propertyKey) ??
          this.constantDefaultSql(c.defaultSql) ??
          (c.defaultSql ? undefined : "NULL");
        if (!ref) {
          bindable = false;
          break;
        }
        // Standard unique indexes are NULLS DISTINCT — a NULL attempted value
        // can never conflict. Guard at runtime (param/t0 refs) AND skip the
        // whole group when the attempted value is statically NULL.
        if (ref === "NULL") {
          bindable = false;
          break;
        }
        refs.push(`t.${quoteIdent(c.sqlName)} IS NOT DISTINCT FROM ${ref} AND ${ref} IS NOT NULL`);
        keyRefs.push({ sqlName: c.sqlName, ref });
      }
      if (bindable) predicates.push({ name: g.name, sql: refs.join(" AND "), keyRefs });
    }

    // ── @Relation pair predicates ─────────────────────────────────────
    // The derived `<table>_pair_uq` index keys on LEAST/GREATEST — the
    // conflict CTE must match the same unordered semantics and split the
    // verdict by direction: same-direction = duplicate claim (ERR04/ERR05),
    // reversed = circular reference (ERR11, selected in the raised CASE).
    // The `keys` detail reports the STORED row's ends (`t.*` refs) — for a
    // reversed collision that is the information a consumer needs.
    const rel = getRelationFacet(entity);
    if (rel !== undefined) {
      const relRef = (propKey: string): { sqlName: string; ref: string } | undefined => {
        const col = Object.values(meta.columns).find((c) => c.propertyKey === propKey);
        if (!col) return undefined;
        const ref =
          attemptedParam.get(col.propertyKey) ??
          this.constantDefaultSql(col.defaultSql) ??
          (col.defaultSql ? undefined : "NULL");
        if (!ref || ref === "NULL") return undefined;
        return { sqlName: col.sqlName, ref };
      };
      const p = relRef(rel.parent_field);
      const c = relRef(rel.child_field);
      const t = rel.type_field !== undefined ? relRef(rel.type_field) : undefined;
      // Either end unbindable (NULL/volatile default) → no pair conflict
      // possible (NULLS DISTINCT keeps NULL ends from colliding anyway).
      if (p && c && (rel.type_field === undefined || t !== undefined)) {
        const pairName = `${meta.tableName}_pair_uq`;
        const typeClause = t ? ` AND t.${quoteIdent(t.sqlName)} IS NOT DISTINCT FROM ${t.ref}` : "";
        const storedEnds = [
          { sqlName: p.sqlName, ref: `t.${quoteIdent(p.sqlName)}` },
          { sqlName: c.sqlName, ref: `t.${quoteIdent(c.sqlName)}` },
          ...(t ? [{ sqlName: t.sqlName, ref: `t.${quoteIdent(t.sqlName)}` }] : []),
        ];
        predicates.push({
          name: pairName,
          sql: `t.${quoteIdent(p.sqlName)} IS NOT DISTINCT FROM ${p.ref} AND t.${quoteIdent(c.sqlName)} IS NOT DISTINCT FROM ${c.ref}${typeClause}`,
          keyRefs: storedEnds,
        });
        predicates.push({
          name: `${pairName}_reversed`,
          sql: `t.${quoteIdent(p.sqlName)} IS NOT DISTINCT FROM ${c.ref} AND t.${quoteIdent(c.sqlName)} IS NOT DISTINCT FROM ${p.ref}${typeClause}`,
          keyRefs: storedEnds,
        });
      }
    }
    return predicates;
  }

  /**
   * Conflict predicates for `addMany`: same unique-group derivation as
   * `uniqueConflictPredicates`, but the attempted value lives in the temp
   * table — `tmp.<col>` when the column is in the payload, a constant
   * `defaultSql` literal, or NULL when the column was omitted with no
   * default. Groups containing volatile/DB-generated columns are skipped.
   */
  private bulkConflictPredicates(
    entity: EntityClass,
    meta: EntityPersistenceMeta,
    payloadProps: string[],
    tmpName: string,
    conflictKeys: string[] | undefined,
  ): { name: string; sql: string; keys: string[] }[] {
    let groups = this.uniqueConflictGroups(meta);

    if (conflictKeys !== undefined) {
      const wanted = new Set<string>();
      for (const pk of conflictKeys) {
        const sqlName = getColumnName(entity, pk);
        if (!meta.columns[sqlName]) {
          throw new UnknownColumnError(`addMany: conflictKeys — unknown column/property ${pk}`);
        }
        wanted.add(sqlName);
      }
      groups = groups.filter(
        (g) => g.cols.length === wanted.size && g.cols.every((c) => wanted.has(c.sqlName)),
      );
      if (groups.length === 0) {
        throw new ValidationError(
          `addMany: conflictKeys [${conflictKeys.join(", ")}] match no unique constraint on ${meta.entityClassName}`,
        );
      }
    }

    const inPayload = new Set(payloadProps);
    const predicates: { name: string; sql: string; keys: string[] }[] = [];
    for (const g of groups) {
      const refs: string[] = [];
      let bindable = true;
      for (const c of g.cols) {
        const ref = inPayload.has(c.propertyKey)
          ? `tmp.${quoteIdent(c.sqlName)}`
          : (this.constantDefaultSql(c.defaultSql) ?? (c.defaultSql ? undefined : "NULL"));
        if (!ref || ref === "NULL") {
          // NULLS DISTINCT semantics — a NULL attempted value never conflicts
          bindable = false;
          break;
        }
        refs.push(`t.${quoteIdent(c.sqlName)} IS NOT DISTINCT FROM ${ref} AND ${ref} IS NOT NULL`);
      }
      if (bindable) predicates.push({ name: g.name, sql: refs.join(" AND "), keys: g.cols.map((c) => c.sqlName) });
    }

    // ── @Relation pair predicates (bulk) ──────────────────────────────
    // Same unordered-pair semantics as uniqueConflictPredicates, with the
    // attempted ends read from the temp table. Reversed-direction matches
    // surface as `<pair>_reversed` → ERR11 (per-row code + top raise).
    const rel = getRelationFacet(entity);
    if (rel !== undefined) {
      const relRef = (propKey: string): string | undefined => {
        const col = Object.values(meta.columns).find((c) => c.propertyKey === propKey);
        if (!col) return undefined;
        const ref = inPayload.has(col.propertyKey)
          ? `tmp.${quoteIdent(col.sqlName)}`
          : (this.constantDefaultSql(col.defaultSql) ?? (col.defaultSql ? undefined : "NULL"));
        return ref && ref !== "NULL" ? ref : undefined;
      };
      const pCol = Object.values(meta.columns).find((c) => c.propertyKey === rel.parent_field);
      const cCol = Object.values(meta.columns).find((c) => c.propertyKey === rel.child_field);
      const tCol = rel.type_field !== undefined
        ? Object.values(meta.columns).find((c) => c.propertyKey === rel.type_field)
        : undefined;
      const pRef = relRef(rel.parent_field);
      const cRef = relRef(rel.child_field);
      const tRef = rel.type_field !== undefined ? relRef(rel.type_field) : undefined;
      if (pCol && cCol && pRef && cRef && (rel.type_field === undefined || (tCol && tRef))) {
        const pairName = `${meta.tableName}_pair_uq`;
        const typeClause = tCol && tRef ? ` AND t.${quoteIdent(tCol.sqlName)} IS NOT DISTINCT FROM ${tRef}` : "";
        const pairKeys = [pCol.sqlName, cCol.sqlName, ...(tCol ? [tCol.sqlName] : [])];
        predicates.push({
          name: pairName,
          sql: `t.${quoteIdent(pCol.sqlName)} IS NOT DISTINCT FROM ${pRef} AND t.${quoteIdent(cCol.sqlName)} IS NOT DISTINCT FROM ${cRef}${typeClause}`,
          keys: pairKeys,
        });
        predicates.push({
          name: `${pairName}_reversed`,
          sql: `t.${quoteIdent(pCol.sqlName)} IS NOT DISTINCT FROM ${cRef} AND t.${quoteIdent(cCol.sqlName)} IS NOT DISTINCT FROM ${pRef}${typeClause}`,
          keys: pairKeys,
        });
      }
    }
    return predicates;
  }

  /**
   * Strict per-row version extraction for bulk ops on auditable entities.
   * Every payload row must carry the caller-observed `version` — same contract
   * as the single-row writes. Any row missing it aborts the whole operation
   * with ONE MissingVersionError (ERR02) whose `detail` carries
   * `{entity, table, missing, rows:[≤10]}` for the FE error dialog.
   * Non-auditable entities (no VERSION column) skip the guard entirely.
   */
  private extractExpectedVersions(
    meta: EntityPersistenceMeta,
    rows: Array<Record<string, unknown>>,
    matchProp: string,
    op: string,
  ): { guard: boolean; versionColSqlName: string; versions: number[] } {
    const versionCol = findVersionColumn(meta);
    if (!versionCol) return { guard: false, versionColSqlName: "", versions: [] };
    const versions: number[] = new Array(rows.length);
    const missing: { index: number; input: unknown }[] = [];
    rows.forEach((rec, i) => {
      const v = rec[versionCol.propertyKey];
      if (v === undefined || v === null) {
        missing.push({ index: i, input: rec[matchProp] });
      } else {
        versions[i] = Number(v);
      }
    });
    if (missing.length > 0) {
      throw new MissingVersionError(
        `${op}: ${missing.length} of ${rows.length} rows are missing 'version' — bulk ${op} on auditable ${meta.entityClassName} is all-or-nothing and requires the caller-observed version per row.`,
        {
          entity: meta.entityClassName,
          table: `${meta.tableSchema}.${meta.tableName}`,
          missing: missing.length,
          rows: missing.slice(0, 10).map((m) => ({
            index: m.index,
            [`input_${matchProp}`]: m.input,
            code: DalErrorCodes.ERR02,
          })),
        },
      );
    }
    return { guard: true, versionColSqlName: versionCol.sqlName, versions };
  }

  /**
   * Diagnose-and-raise SQL for the bulk version guard. Runs BEFORE the write
   * (pre-check in the same transaction): left-joins tmp against the target
   * and `pg_raise`s once when any row is stale or vanished — ERR03 when every
   * offender vanished, ERR01 otherwise; DETAIL lists up to 10 offending rows
   * with per-row code, expected/actual version and uuid.
   */
  private bulkStaleDiagnoseSql(
    meta: EntityPersistenceMeta,
    table: string,
    matchCols: { sqlName: string }[],
    tmpName: string,
    versionColSqlName: string,
    op: string,
  ): string {
    const pk = findPkColumn(meta);
    const joinPred = this.bulkJoinPredicate("t", "tmp", matchCols);
    const v = quoteIdent(versionColSqlName);
    const pkSql = pk ? quoteIdent(pk.sqlName) : quoteIdent(matchCols[0].sqlName);
    // Partial-identity probes (ERR10 classification): only evaluated for tmp
    // rows that already failed the full-identity JOIN — i.e. a row exists for
    // one identity field but not the AND conjunction → incoherent identity.
    const probeCols = matchCols.length > 1 ? matchCols : [];
    const probeSelects = probeCols
      .map(
        (c, i) =>
          `EXISTS(SELECT 1 FROM ${table} p${i} WHERE p${i}.${quoteIdent(c.sqlName)} = tmp.${quoteIdent(c.sqlName)}) AS s_seen_${i}`,
      )
      .join(",\n         ");
    const anySeen = probeCols.map((_, i) => `s_seen_${i}`).join(" OR ");
    const inputCols = matchCols
      .map((c) => `'${c.sqlName}', tmp.${quoteIdent(c.sqlName)}`)
      .join(", ");
    const perRowCode = probeCols.length
      ? `CASE WHEN s_vanished AND (${anySeen}) THEN 'ERR10' WHEN s_vanished THEN 'ERR03' ELSE 'ERR01' END`
      : `CASE WHEN s_vanished THEN 'ERR03' ELSE 'ERR01' END`;
    const batchCode = probeCols.length
      ? `CASE WHEN bool_or(s_vanished AND (${anySeen})) THEN 'ERR10' WHEN bool_and(s_vanished) THEN 'ERR03' ELSE 'ERR01' END`
      : `CASE WHEN bool_and(s_vanished) THEN 'ERR03' ELSE 'ERR01' END`;
    return `WITH st AS (
  SELECT tmp.row_ix AS s_ix, jsonb_build_object(${inputCols}) AS s_match,
         t.${pkSql} AS s_pk,
         t.${v} AS s_actual, tmp.expected_version AS s_expected,
         (t.${pkSql} IS NULL) AS s_vanished${probeSelects ? ",\n         " + probeSelects : ""}
  FROM ${quoteIdent(tmpName)} tmp
  LEFT JOIN ${table} t ON ${joinPred}
  WHERE t.${pkSql} IS NULL OR t.${v} IS DISTINCT FROM tmp.expected_version
),
agg AS (SELECT count(*) AS n, ${batchCode} AS code FROM st),
det AS (
  SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) AS rows
  FROM (
    SELECT s_ix AS row_ix, s_pk AS pk, s_match AS match,
           s_expected AS expected_version, s_actual AS actual_version,
           s_vanished AS vanished,
           ${perRowCode} AS code
    FROM st ORDER BY s_ix LIMIT 10
  ) x
)
SELECT public.pg_raise(
  agg.code,
  ${escapeLiteral(`${op}: stale or missing rows on ${meta.entityClassName}`)},
  jsonb_build_object(
    'entity', ${escapeLiteral(meta.entityClassName)},
    'table', ${escapeLiteral(`${meta.tableSchema}.${meta.tableName}`)},
    'stale', agg.n,
    'rows', det.rows
  )::text
)
FROM agg, det
WHERE agg.n > 0`;
  }

  // ─── upsert (single-record) REMOVED ─────────────────────────────────────────
  // Intentionally disabled. upsert() had become a workaround that eluded the
  // optimistic-concurrency model: callers either passed a just-fetched version
  // (self-comparison, guard vacuous) or nothing (silent merge of unknown state).
  // The honest contract is: add() when the row is expected absent (unique
  // violation on conflict is a correct, visible failure), or update() with the
  // observed version when it exists. Bulk upsertMany (temp-table) is unaffected.
  // See ai-plans/bugfix-auditable-update-version-propagation.md
  // ────────────────────────────────────────────────────────────────────────────
  //   /** Upsert — auditable entity (actor required). */
  //   async upsert<TEntity extends object & IAuditableEntity>(
  //     entity: EntityClass & { new (): TEntity },
  //     row: Partial<Record<keyof TEntity & string, unknown>>,
  //     options: AuditableWriteOptions & UpsertOptions,
  //   ): Promise<TEntity>;
  //   /** Upsert — non-auditable entity (actor rejected). */
  //   async upsert<TEntity extends object>(
  //     entity: EntityClass & { new (): TEntity },
  //     row: Partial<Record<keyof TEntity & string, unknown>>,
  //     options: WriteOptions & UpsertOptions,
  //   ): Promise<TEntity>;
  //   async upsert<TEntity extends object>(
  //     entity: EntityClass,
  //     row: Partial<Record<keyof TEntity & string, unknown>>,
  //     options: (WriteOptions | AuditableWriteOptions) & UpsertOptions,
  //   ): Promise<TEntity> {
  //     const meta = getEntityPersistenceMeta(entity);
  //     const table = getQualifiedTableName(entity);
  //     const pk = findPkColumn(meta);
  //     const auditable = isAuditableEntity(meta);
  //     const actor = (options as AuditableWriteOptions).actor;
  //     // Default conflict target: @Key() column's SQL name (was "uuid")
  //     const conflictTarget = options.conflictTarget ?? pk?.sqlName ?? "uuid";
  // 
  //     const rec = row as Record<string, unknown>;
  //     let keys = Object.keys(rec).filter((k) => rec[k] !== undefined);
  // 
  //     if (pk && meta.columns[pk.sqlName]?.usePostgresIdentity) {
  //       keys = keys.filter((k) => k !== pk!.propertyKey);
  //     }
  // 
  //     // Optimistic concurrency: strip version from INSERT keys for auditable entities.
  //     // Version is used for the guard (ON CONFLICT path only, per OD4), not for INSERT/SET.
  //     const versionCol = findVersionColumn(meta);
  //     let expectedVersion: number | null = null;
  //     if (versionCol) {
  //       const versionValue = rec[versionCol.propertyKey];
  //       if (versionValue !== undefined && versionValue !== null) {
  //         expectedVersion = Number(versionValue);
  //       }
  //       keys = keys.filter((k) => k !== versionCol.propertyKey);
  //     }
  // 
  //     if (keys.length === 0) {
  //       throw new ValidationError("upsert: no columns to insert (all undefined?)");
  //     }
  // 
  //     for (const k of keys) {
  //       const sqlName = getColumnName(entity, k);
  //       if (!meta.columns[sqlName]) {
  //         throw new UnknownColumnError(`upsert: unknown column/property ${k}`);
  //       }
  //     }
  // 
  //     const now = new Date();
  //     const values: unknown[] = [];
  //     const colsSql: string[] = [];
  //     const params: string[] = [];
  // 
  //     for (const k of keys) {
  //       const sqlName = getColumnName(entity, k);
  //       const colMeta = meta.columns[sqlName];
  //       colsSql.push(quoteIdent(sqlName));
  //       const rawVal = rec[k] ?? null;
  //       const pgVal = colMeta ? jsValueToPgParam(rawVal, columnHintsFromMetaColumn(colMeta)) : rawVal;
  //       values.push(pgVal);
  //       params.push(`$${values.length}`);
  //     }
  // 
  //     // Add audit stamping for INSERT path
  //     if (auditable && actor !== undefined) {
  //       const createdAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.CREATED_AT);
  //       const createdByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.CREATED_BY);
  //       const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
  //       const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
  // 
  //       if (createdAtCol && !keys.includes(createdAtCol.propertyKey)) {
  //         colsSql.push(quoteIdent(createdAtCol.sqlName));
  //         values.push(now);
  //         params.push(`$${values.length}`);
  //       }
  //       if (createdByCol && !keys.includes(createdByCol.propertyKey)) {
  //         colsSql.push(quoteIdent(createdByCol.sqlName));
  //         values.push(actor);
  //         params.push(`$${values.length}`);
  //       }
  //       if (updatedAtCol && !keys.includes(updatedAtCol.propertyKey)) {
  //         colsSql.push(quoteIdent(updatedAtCol.sqlName));
  //         values.push(now);
  //         params.push(`$${values.length}`);
  //       }
  //       if (updatedByCol && !keys.includes(updatedByCol.propertyKey)) {
  //         colsSql.push(quoteIdent(updatedByCol.sqlName));
  //         values.push(actor);
  //         params.push(`$${values.length}`);
  //       }
  //     }
  // 
  //     // Build ON CONFLICT DO UPDATE SET — audit-aware
  //     const updateCols: string[] = [];
  //     const actorParamIdx = values.length + 1;
  //     values.push(actor);
  //     const nowParamIdx = values.length + 1;
  //     values.push(now);
  // 
  //     for (const k of keys) {
  //       const sqlName = getColumnName(entity, k);
  //       // Don't update the conflict target itself, created_at, or created_by on conflict
  //       const col = meta.columns[sqlName];
  //       if (sqlName === conflictTarget) continue;
  //       if (col?.auditableType === AuditableFieldType.CREATED_AT) continue;
  //       if (col?.auditableType === AuditableFieldType.CREATED_BY) continue;
  //       updateCols.push(`${quoteIdent(sqlName)} = EXCLUDED.${quoteIdent(sqlName)}`);
  //     }
  // 
  //     // Add audit stamping for UPDATE path
  //     if (auditable && actor !== undefined) {
  //       const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
  //       const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
  //       const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);
  // 
  //       if (updatedAtCol) updateCols.push(`${quoteIdent(updatedAtCol.sqlName)} = $${nowParamIdx}`);
  //       if (updatedByCol) updateCols.push(`${quoteIdent(updatedByCol.sqlName)} = $${actorParamIdx}`);
  //       if (versionCol) updateCols.push(`${quoteIdent(versionCol.sqlName)} = ${table}.${quoteIdent(versionCol.sqlName)} + 1`);
  //     }
  // 
  //     const conflictCol = quoteIdent(conflictTarget);
  //     const sql = `INSERT INTO ${table} (${colsSql.join(", ")}) VALUES (${params.join(", ")}) ON CONFLICT (${conflictCol}) DO UPDATE SET ${updateCols.join(", ")} RETURNING *`;
  // 
  //     // Fetch old record for audit delta AND optimistic concurrency pre-check.
  //     // Runs for all auditable entities (not just when audit is enabled) because the
  //     // version guard needs to know if the row exists (ON CONFLICT path) or not (INSERT path).
  //     let oldRecord: Record<string, unknown> | null = null;
  //     if (auditable) {
  //       const conflictPropKey = Object.entries(meta.columns).find(([_, c]) => c.sqlName === conflictTarget)?.[1]?.propertyKey;
  //       const conflictValue = conflictPropKey ? rec[conflictPropKey] : null;
  //       if (conflictValue !== null && conflictValue !== undefined) {
  //         const oldSql = `SELECT * FROM ${table} WHERE ${conflictCol} = $1`;
  //         const oldResult = await this.db.query(oldSql, [conflictValue]);
  //         oldRecord = (oldResult.rows[0] as Record<string, unknown>) ?? null;
  //       }
  //     }
  // 
  //     // Optimistic concurrency guard — ON CONFLICT path only (row exists), per OD4.
  //     // INSERT path (row doesn't exist) skips the guard entirely.
  //     if (oldRecord && versionCol) {
  //       if (expectedVersion === null) {
  //         throw new MissingVersionError(
  //           `Auditable entity upsert with existing row requires a 'version' field; entity ${meta.entityClassName} is auditable but no version was provided.`,
  //         );
  //       }
  //       const dbVersion = Number(oldRecord[versionCol.sqlName]);
  //       if (dbVersion !== expectedVersion) {
  //         // PG raises ERR01 — same mechanism as update/delete/restore/hardDelete
  //         const raiseSql = `DO $$ BEGIN RAISE EXCEPTION 'Optimistic Concurrency Violation' USING ERRCODE = 'ERR01', DETAIL = 'The record exists but the provided version (${expectedVersion}) does not match the current version of ${meta.entityClassName}.'; END $$;`;
  //         await this.db.query(raiseSql);
  //       }
  //     }
  // 
  //     const result = await this.db.query(sql, values);
  //     const upserted = result.rows?.[0] as TEntity;
  // 
  //     // Write audit log (fire-and-forget) — INSERT if new, UPDATE if conflict
  //     if (auditable && options.audit && actor !== undefined) {
  //       const entityId = auditEntityId(upserted as Record<string, unknown>);
  //       const entityUuid = (upserted as any)["uuid"] as string | undefined ?? "";
  //       const newVersion = versionCol ? (upserted as any)[versionCol.propertyKey] as number : 1;
  //       const action = oldRecord ? AuditAction.UPDATE : AuditAction.INSERT;
  //       const delta = oldRecord
  //         ? calculateDeltaWithForcedFields(oldRecord, upserted as Record<string, unknown>, [])
  //         : calculateDelta({}, upserted as Record<string, unknown>);
  //       options.audit.writeAudit({
  //         entityClassName: meta.entityClassName,
  //         tableName: meta.tableName,
  //         entityId,
  //         entityUuid,
  //         action,
  //         changedAt: now,
  //         version: newVersion,
  //         changedBy: actor,
  //         delta,
  //       }).catch((err) => (options.logger ?? noopLogger).error("[DAL Audit Error]", err));
  //     }
  // 
  //     return upserted;
  //   }

  /** Update — auditable entity (actor required). */
  async update<TEntity extends object & IAuditableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  /** Update — non-auditable entity (actor rejected). */
  async update<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  async update<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TResult> {
    const meta = getEntityPersistenceMeta(entity);
    const table = getQualifiedTableName(entity);
    const { conditions: matchConds, remaining: remainingUpdates } = this.resolveMatchConditions(
      meta,
      updates as Record<string, unknown>,
      options.matchBy as string | readonly string[] | undefined,
    );
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    assertWriteActor(meta, actor);

    // Seq-bound writes need atomic claim+update — pool-bound runs through
    // the lazy mini-tx; a tx-bound repo resolves inline below.
    const seqCols = this.seqBoundColumns(meta);
    const seqWrite =
      seqCols.length > 0 &&
      seqCols.some((c) => (remainingUpdates as Record<string, unknown>)[c.propertyKey] !== undefined);
    if (seqWrite) {
      if (actor === undefined) {
        throw new ValidationError(
          `update: seq-bound write on ${meta.entityClassName} requires options.actor — the counter claim is audited`,
        );
      }
      if (this.poolBound()) {
        return this.withSeqTx(options, (r) => r.update(entity as never, updates as never, options as never) as Promise<TResult>);
      }
    }

    // Optimistic concurrency: extract version from payload for auditable entities
    const versionCol = findVersionColumn(meta);
    const versionExtract = extractVersion(remainingUpdates, versionCol, meta.entityClassName);
    const expectedVersion = versionExtract?.expectedVersion ?? null;
    const finalUpdates = versionExtract?.remainingPayload ?? remainingUpdates;
    if (seqWrite) {
      await this.resolveSeqColumns(this.db, meta, finalUpdates as Record<string, unknown>, "update", actor!);
    }

    const setClauses: string[] = [];
    const values: unknown[] = [];
    const now = new Date();

    // Add audit stamping
    if (auditable && actor !== undefined) {
      const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
      const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);

      if (updatedAtCol) {
        setClauses.push(`${quoteIdent(updatedAtCol.sqlName)} = $${values.length + 1}`);
        values.push(now);
      }
      if (updatedByCol) {
        setClauses.push(`${quoteIdent(updatedByCol.sqlName)} = $${values.length + 1}`);
        values.push(actor);
      }
      if (versionCol) {
        setClauses.push(`${quoteIdent(versionCol.sqlName)} = ${quoteIdent(versionCol.sqlName)} + 1`);
      }
    }

    // Add user-provided updates (version already stripped by extractVersion)
    let userFieldCount = 0;
    const paramRefByProp = new Map<string, string>();
    for (const [key, value] of Object.entries(finalUpdates)) {
      if (value === undefined) continue;
      const sqlName = getColumnName(entity, key);
      const colMeta = meta.columns[sqlName];
      if (!colMeta) {
        throw new UnknownColumnError(`update: unknown column/property ${key}`);
      }
      const ref = `$${values.length + 1}`;
      setClauses.push(`${quoteIdent(sqlName)} = ${ref}`);
      values.push(jsValueToPgParam(value, columnHintsFromMetaColumn(colMeta)));
      paramRefByProp.set(key, ref);
      userFieldCount++;
    }

    if (userFieldCount === 0) {
      throw new ValidationError("update: no fields to update");
    }

    // Identity conditions — pushed as one contiguous param block AFTER the
    // SET params. The same param indexes are shared by matched/t0/guard/
    // conflict/upd (single statement).
    const condParamStart = values.length + 1;
    for (const c of matchConds) {
      values.push(jsValueToPgParam(c.value, c.hints));
    }
    const matchWhere = identityWhere(matchConds, condParamStart);

    // Fetch old record for audit delta (only if audit port is provided)
    let oldRecord: Record<string, unknown> | null = null;
    if (auditable && options.audit && actor !== undefined) {
      const oldSql = `SELECT * FROM ${table} WHERE ${identityWhere(matchConds, 1)}`;
      const oldResult = await this.db.query(
        oldSql,
        matchConds.map((c) => jsValueToPgParam(c.value, c.hints)),
      );
      oldRecord = (oldResult.rows[0] as Record<string, unknown>) ?? null;
    }

    // Build WHERE clause with optional version guard for optimistic concurrency
    let whereClause = `WHERE ${matchWhere}`;
    if (expectedVersion !== null && versionCol) {
      const versionParamIndex = values.length + 1;
      values.push(expectedVersion);
      whereClause += ` AND ${quoteIdent(versionCol.sqlName)} = $${versionParamIndex}`;
    }

    // Unique-conflict reporting (ERR04/ERR05) — same CTE pattern as add().
    // Emitted ONLY when the payload writes at least one @Unique column:
    // predicates reference the attempted value ($n for payload columns,
    // t0.<col> — the target row's current value — for untouched columns of a
    // partially-covered composite group). The target row is self-excluded
    // (IS DISTINCT FROM $match). `NOT EXISTS (SELECT 1 FROM raised)` sits in
    // the UPDATE WHERE, so the raise fires while filtering the candidate row
    // — before any write; a stale version short-circuits to ERR01/ERR03 via
    // the existing zero-row disambiguation below.
    const uniquePredicates = this.uniqueConflictGroups(meta)
      .filter((g) => g.cols.some((c) => paramRefByProp.has(c.propertyKey)))
      .map((g) => {
        const keyRefs = g.cols.map((c) => {
          const ref = paramRefByProp.get(c.propertyKey) ?? `t0.${quoteIdent(c.sqlName)}`;
          return { sqlName: c.sqlName, ref };
        });
        return {
          name: g.name,
          // NULLS DISTINCT — a NULL attempted value never conflicts
          sql: keyRefs
            .map((k) => `t.${quoteIdent(k.sqlName)} IS NOT DISTINCT FROM ${k.ref} AND ${k.ref} IS NOT NULL`)
            .join(" AND "),
          keyRefs,
        };
      });

    const ret = buildReturningClause(entity, options.returning);
    let sql: string;

    // Multi-row safety net: `matched` counts every row the identity WHERE
    // would touch. If a selector somehow resolves to >1 row (metamodel bug,
    // race, enforcement bypassed upstream) `guard` raises ERR10 — the raise
    // aborts the whole statement so nothing is written (atomic).
    const guardCte = this.buildGuardCte(table, matchConds, condParamStart, matchWhere, "update");

    if (uniquePredicates.length === 0) {
      sql = `WITH ${guardCte},
upd AS (
  UPDATE ${table} SET ${setClauses.join(", ")} ${whereClause}
    AND NOT EXISTS (SELECT 1 FROM guard)
  ${ret.clause}
)
SELECT * FROM upd`;
    } else {
      const uuidSel = meta.columns["uuid"] ? `t.${quoteIdent("uuid")}` : "NULL";
      const deletedAtCol = Object.values(meta.columns).find(
        (c) => c.deletableType === DeletableFieldType.DELETED_AT,
      );
      const deletedSel = deletedAtCol ? `t.${quoteIdent(deletedAtCol.sqlName)}` : "NULL";
      const whereOr = uniquePredicates.map((p) => `(${p.sql})`).join("\n        OR ");
      const constraintCase = uniquePredicates
        .map((p) => `WHEN (${p.sql}) THEN ${escapeLiteral(p.name)}`)
        .join(" ");
      const keysCase = uniquePredicates
        .map(
          (p) =>
            `WHEN (${p.sql}) THEN jsonb_build_object(${p.keyRefs
              .map((k) => `${escapeLiteral(k.sqlName)}, ${k.ref}`)
              .join(", ")})`,
        )
        .join(" ");
      // `t0` is the target row ONLY when it passes the version guard —
      // `conflict` derives FROM t0, so a stale/vanished target yields an
      // empty conflict set: no raise fires, rowCount=0 falls into the
      // existing ERR01/ERR03/ERR10 disambiguation (ERR01 wins over ERR04/ERR05).
      const t0Guard =
        expectedVersion !== null && versionCol
          ? ` AND ${quoteIdent(versionCol.sqlName)} = $${values.length}`
          : "";
      sql = `WITH ${guardCte},
t0 AS (
  SELECT * FROM matched WHERE 1=1${t0Guard}
),
conflict AS (
  SELECT ${uuidSel} AS c_uuid, ${deletedSel} AS c_deleted_at,
         CASE ${constraintCase} END AS c_constraint,
         CASE ${keysCase} END AS c_keys
  FROM t0, ${table} t
  WHERE ${identitySelfExclusion(matchConds, condParamStart, "t")}
    AND (${whereOr})
  LIMIT 1
),
raised AS (
  SELECT public.pg_raise(
    ${this.conflictErrCode(entity, meta, "c.c_deleted_at", "c.c_constraint")},
    ${escapeLiteral(`update: unique constraint violation on ${meta.entityClassName}`)},
    jsonb_build_object(
      'entity', ${escapeLiteral(meta.entityClassName)},
      'table', ${escapeLiteral(`${meta.tableSchema}.${meta.tableName}`)},
      'uuid', c.c_uuid::text,
      'constraint', c.c_constraint,
      'keys', c.c_keys
    )::text
  ) AS _raised
  FROM conflict c
),
upd AS (
  UPDATE ${table} SET ${setClauses.join(", ")} ${whereClause}
    AND NOT EXISTS (SELECT 1 FROM raised)
  ${ret.clause}
)
SELECT * FROM upd`;
    }
    const result = await this.db.query(sql, values);

    if (result.rowCount === 0) {
      if (expectedVersion !== null && versionCol) {
        // Auditable entity with version guard — disambiguate ERR01 (version mismatch) vs ERR03 (row vanished) vs ERR10 (identity incoherence)
        await disambiguateZeroRows(this.db, table, matchConds, meta.entityClassName, expectedVersion, versionCol.sqlName);
      }
      // Non-auditable: still probe partial identity before declaring 404
      await this.assertNoPartialIdentity(table, matchConds, meta.entityClassName);
      throw new NotFoundError(
        `No ${table} found with ${matchConds.map((c) => `${c.sqlName} = ${String(c.value)}`).join(" AND ")}`,
      );
    }

    const updatedRaw = result.rows[0] as Record<string, unknown>;
    const updated = remapReturningRow(updatedRaw, ret.rowKeyToSqlName);

    // Write audit log (fire-and-forget)
    if (auditable && options.audit && actor !== undefined && oldRecord) {
      const entityId = auditEntityId(updated, oldRecord);
      const entityUuid = (updated["uuid"] as string | undefined) ?? "";
      const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);
      const newVersion = versionCol ? (updated[versionCol.sqlName] as number) : 1;
      const forcedFields: string[] = [];
      const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
      const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
      if (updatedAtCol) forcedFields.push(updatedAtCol.sqlName);
      if (updatedByCol) forcedFields.push(updatedByCol.sqlName);
      const delta = calculateDeltaWithForcedFields(
        oldRecord,
        { ...oldRecord, ...updated },
        forcedFields,
      );
      options.audit.writeAudit({
        entityClassName: meta.entityClassName,
        tableName: meta.tableName,
        entityId,
        entityUuid,
        action: AuditAction.UPDATE,
        changedAt: now,
        version: newVersion,
        changedBy: actor,
        delta,
      }).catch((err) => (options.logger ?? noopLogger).error("[DAL Audit Error]", err));
    }

    {
      const before = oldRecord ? eventSafeRecord(oldRecord) : null;
      const merged = eventSafeRecord({ ...oldRecord, ...updated });
      const evtForced = Object.values(meta.columns)
        .filter((c) => c.auditableType === AuditableFieldType.UPDATED_AT || c.auditableType === AuditableFieldType.UPDATED_BY)
        .map((c) => c.sqlName);
      this.emitEntityEvent(entity, meta, options, {
        action: "update",
        uuid: (updated["uuid"] as string | undefined) ?? "",
        version: versionCol ? (updated[versionCol.sqlName] as number) : undefined,
        before: oldRecord ?? null,
        after: merged,
        delta: before ? calculateDeltaWithForcedFields(before, merged, evtForced) : calculateDelta({}, merged),
      });
    }

    return pickReturningRow<TResult>(updatedRaw, ret.visibleKeys);
  }

  async delete<TEntity extends object & IAuditableEntity & IDeletableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  /** Soft-delete — deletable but non-auditable entity (actor rejected). */
  async delete<TEntity extends object & IDeletableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  async delete<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TResult> {
    const meta = getEntityPersistenceMeta(entity);
    const table = getQualifiedTableName(entity);
    const { conditions: matchConds } = this.resolveMatchConditions(
      meta,
      match as Record<string, unknown>,
      options.matchBy as string | readonly string[] | undefined,
    );
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    assertWriteActor(meta, actor);
    const isDeletable = Object.values(meta.columns).some((c) => c.isDeletable);
    if (!isDeletable) throw new Error(`Entity ${meta.entityClassName} has no @DeletableField — cannot soft delete`);

    // Optimistic concurrency: extract version from match payload for auditable entities
    const versionCol = findVersionColumn(meta);
    const versionExtract = extractVersion(match as Record<string, unknown>, versionCol, meta.entityClassName);
    const expectedVersion = versionExtract?.expectedVersion ?? null;

    const now = new Date();
    const setClauses: string[] = [];
    const values: unknown[] = [];

    const deletedAtCol = Object.values(meta.columns).find((c) => c.deletableType === DeletableFieldType.DELETED_AT);
    const deletedByCol = Object.values(meta.columns).find((c) => c.deletableType === DeletableFieldType.DELETED_BY);
    const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
    const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);

    if (deletedAtCol) {
      setClauses.push(`${quoteIdent(deletedAtCol.sqlName)} = $${values.length + 1}`);
      values.push(now);
    }
    if (deletedByCol && auditable && actor !== undefined) {
      setClauses.push(`${quoteIdent(deletedByCol.sqlName)} = $${values.length + 1}`);
      values.push(actor);
    }
    if (updatedAtCol && auditable && actor !== undefined) {
      setClauses.push(`${quoteIdent(updatedAtCol.sqlName)} = $${values.length + 1}`);
      values.push(now);
    }
    if (updatedByCol && auditable && actor !== undefined) {
      setClauses.push(`${quoteIdent(updatedByCol.sqlName)} = $${values.length + 1}`);
      values.push(actor);
    }
    if (versionCol && auditable) {
      setClauses.push(`${quoteIdent(versionCol.sqlName)} = ${quoteIdent(versionCol.sqlName)} + 1`);
    }

    const condParamStart = values.length + 1;
    for (const c of matchConds) {
      values.push(jsValueToPgParam(c.value, c.hints));
    }
    const matchWhere = identityWhere(matchConds, condParamStart);

    // Fetch old record for audit delta
    let oldRecord: Record<string, unknown> | null = null;
    if (auditable && options.audit && actor !== undefined) {
      const oldSql = `SELECT * FROM ${table} WHERE ${identityWhere(matchConds, 1)}`;
      const oldResult = await this.db.query(
        oldSql,
        matchConds.map((c) => jsValueToPgParam(c.value, c.hints)),
      );
      oldRecord = (oldResult.rows[0] as Record<string, unknown>) ?? null;
    }

    // Build WHERE clause with optional version guard for optimistic concurrency
    let whereClause = `WHERE ${matchWhere}`;
    if (expectedVersion !== null && versionCol) {
      const versionParamIndex = values.length + 1;
      values.push(expectedVersion);
      whereClause += ` AND ${quoteIdent(versionCol.sqlName)} = $${versionParamIndex}`;
    }

    const ret = buildReturningClause(entity, options.returning);
    const sql = `WITH ${this.buildGuardCte(table, matchConds, condParamStart, matchWhere, "delete")},
w AS (
  UPDATE ${table} SET ${setClauses.join(", ")} ${whereClause}
    AND NOT EXISTS (SELECT 1 FROM guard)
  ${ret.clause}
)
SELECT * FROM w`;
    const result = await this.db.query(sql, values);

    if (result.rowCount === 0) {
      if (expectedVersion !== null && versionCol) {
        await disambiguateZeroRows(this.db, table, matchConds, meta.entityClassName, expectedVersion, versionCol.sqlName);
      }
      await this.assertNoPartialIdentity(table, matchConds, meta.entityClassName);
      throw new NotFoundError(
        `No ${table} found with ${matchConds.map((c) => `${c.sqlName} = ${String(c.value)}`).join(" AND ")}`,
      );
    }

    const deletedRaw = result.rows[0] as Record<string, unknown>;
    const deleted = remapReturningRow(deletedRaw, ret.rowKeyToSqlName);

    // Write audit log (fire-and-forget)
    if (auditable && options.audit && actor !== undefined && oldRecord) {
      const entityId = auditEntityId(deleted, oldRecord);
      const entityUuid = (deleted["uuid"] as string | undefined) ?? "";
      const newVersion = versionCol ? (deleted[versionCol.sqlName] as number) : 1;
      const forcedFields: string[] = [];
      if (deletedAtCol) forcedFields.push(deletedAtCol.sqlName);
      if (deletedByCol) forcedFields.push(deletedByCol.sqlName);
      if (updatedAtCol) forcedFields.push(updatedAtCol.sqlName);
      if (updatedByCol) forcedFields.push(updatedByCol.sqlName);
      const delta = calculateDeltaWithForcedFields(
        oldRecord,
        { ...oldRecord, ...deleted },
        forcedFields,
      );
      options.audit.writeAudit({
        entityClassName: meta.entityClassName,
        tableName: meta.tableName,
        entityId,
        entityUuid,
        action: AuditAction.SOFT_DELETE,
        changedAt: now,
        version: newVersion,
        changedBy: actor,
        delta,
      }).catch((err) => (options.logger ?? noopLogger).error("[DAL Audit Error]", err));
    }

    {
      const before = oldRecord ? eventSafeRecord(oldRecord) : null;
      const merged = eventSafeRecord({ ...oldRecord, ...deleted });
      const evtForced = [deletedAtCol, deletedByCol, updatedAtCol, updatedByCol]
        .filter((c) => c !== undefined)
        .map((c) => c.sqlName);
      this.emitEntityEvent(entity, meta, options, {
        action: "delete",
        uuid: (deleted["uuid"] as string | undefined) ?? "",
        version: versionCol ? (deleted[versionCol.sqlName] as number) : undefined,
        before: oldRecord ?? null,
        after: merged,
        delta: before ? calculateDeltaWithForcedFields(before, merged, evtForced) : calculateDelta({}, merged),
      });
    }

    return pickReturningRow<TResult>(deletedRaw, ret.visibleKeys);
  }

  /** Restore — auditable+deletable entity (actor required). */
  async restore<TEntity extends object & IAuditableEntity & IDeletableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  /** Restore — deletable but non-auditable entity (actor rejected). */
  async restore<TEntity extends object & IDeletableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  async restore<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TResult> {
    const meta = getEntityPersistenceMeta(entity);
    const table = getQualifiedTableName(entity);
    const { conditions: matchConds } = this.resolveMatchConditions(
      meta,
      match as Record<string, unknown>,
      options.matchBy as string | readonly string[] | undefined,
    );
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    assertWriteActor(meta, actor);
    const isDeletable = Object.values(meta.columns).some((c) => c.isDeletable);
    if (!isDeletable) throw new Error(`Entity ${meta.entityClassName} has no @DeletableField — cannot restore`);

    // Optimistic concurrency: extract version from match payload for auditable entities
    const versionCol = findVersionColumn(meta);
    const versionExtract = extractVersion(match as Record<string, unknown>, versionCol, meta.entityClassName);
    const expectedVersion = versionExtract?.expectedVersion ?? null;

    const now = new Date();
    const setClauses: string[] = [];
    const values: unknown[] = [];

    const deletedAtCol = Object.values(meta.columns).find((c) => c.deletableType === DeletableFieldType.DELETED_AT);
    const deletedByCol = Object.values(meta.columns).find((c) => c.deletableType === DeletableFieldType.DELETED_BY);
    const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
    const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);

    if (deletedAtCol) {
      setClauses.push(`${quoteIdent(deletedAtCol.sqlName)} = NULL`);
    }
    if (deletedByCol) {
      setClauses.push(`${quoteIdent(deletedByCol.sqlName)} = NULL`);
    }
    if (updatedAtCol && auditable && actor !== undefined) {
      setClauses.push(`${quoteIdent(updatedAtCol.sqlName)} = $${values.length + 1}`);
      values.push(now);
    }
    if (updatedByCol && auditable && actor !== undefined) {
      setClauses.push(`${quoteIdent(updatedByCol.sqlName)} = $${values.length + 1}`);
      values.push(actor);
    }
    if (versionCol && auditable) {
      setClauses.push(`${quoteIdent(versionCol.sqlName)} = ${quoteIdent(versionCol.sqlName)} + 1`);
    }

    const condParamStart = values.length + 1;
    for (const c of matchConds) {
      values.push(jsValueToPgParam(c.value, c.hints));
    }
    const matchWhere = identityWhere(matchConds, condParamStart);

    // Fetch old record for audit delta
    let oldRecord: Record<string, unknown> | null = null;
    if (auditable && options.audit && actor !== undefined) {
      const oldSql = `SELECT * FROM ${table} WHERE ${identityWhere(matchConds, 1)}`;
      const oldResult = await this.db.query(
        oldSql,
        matchConds.map((c) => jsValueToPgParam(c.value, c.hints)),
      );
      oldRecord = (oldResult.rows[0] as Record<string, unknown>) ?? null;
    }

    // Build WHERE clause with optional version guard for optimistic concurrency
    let whereClause = `WHERE ${matchWhere}`;
    if (expectedVersion !== null && versionCol) {
      const versionParamIndex = values.length + 1;
      values.push(expectedVersion);
      whereClause += ` AND ${quoteIdent(versionCol.sqlName)} = $${versionParamIndex}`;
    }

    const ret = buildReturningClause(entity, options.returning);
    const sql = `WITH ${this.buildGuardCte(table, matchConds, condParamStart, matchWhere, "restore")},
w AS (
  UPDATE ${table} SET ${setClauses.join(", ")} ${whereClause}
    AND NOT EXISTS (SELECT 1 FROM guard)
  ${ret.clause}
)
SELECT * FROM w`;
    const result = await this.db.query(sql, values);

    if (result.rowCount === 0) {
      if (expectedVersion !== null && versionCol) {
        await disambiguateZeroRows(this.db, table, matchConds, meta.entityClassName, expectedVersion, versionCol.sqlName);
      }
      await this.assertNoPartialIdentity(table, matchConds, meta.entityClassName);
      throw new NotFoundError(
        `No ${table} found with ${matchConds.map((c) => `${c.sqlName} = ${String(c.value)}`).join(" AND ")}`,
      );
    }

    const restoredRaw = result.rows[0] as Record<string, unknown>;
    const restored = remapReturningRow(restoredRaw, ret.rowKeyToSqlName);

    // Write audit log (fire-and-forget)
    if (auditable && options.audit && actor !== undefined && oldRecord) {
      const entityId = auditEntityId(restored, oldRecord);
      const entityUuid = (restored["uuid"] as string | undefined) ?? "";
      const newVersion = versionCol ? (restored[versionCol.sqlName] as number) : 1;
      const forcedFields: string[] = [];
      if (deletedAtCol) forcedFields.push(deletedAtCol.sqlName);
      if (deletedByCol) forcedFields.push(deletedByCol.sqlName);
      if (updatedAtCol) forcedFields.push(updatedAtCol.sqlName);
      if (updatedByCol) forcedFields.push(updatedByCol.sqlName);
      const delta = calculateDeltaWithForcedFields(
        oldRecord,
        { ...oldRecord, ...restored },
        forcedFields,
      );
      options.audit.writeAudit({
        entityClassName: meta.entityClassName,
        tableName: meta.tableName,
        entityId,
        entityUuid,
        action: AuditAction.RESTORE,
        changedAt: now,
        version: newVersion,
        changedBy: actor,
        delta,
      }).catch((err) => (options.logger ?? noopLogger).error("[DAL Audit Error]", err));
    }

    {
      const before = oldRecord ? eventSafeRecord(oldRecord) : null;
      const merged = eventSafeRecord({ ...oldRecord, ...restored });
      const evtForced = [deletedAtCol, deletedByCol, updatedAtCol, updatedByCol]
        .filter((c) => c !== undefined)
        .map((c) => c.sqlName);
      this.emitEntityEvent(entity, meta, options, {
        action: "restore",
        uuid: (restored["uuid"] as string | undefined) ?? "",
        version: versionCol ? (restored[versionCol.sqlName] as number) : undefined,
        before: oldRecord ?? null,
        after: merged,
        delta: before ? calculateDeltaWithForcedFields(before, merged, evtForced) : calculateDelta({}, merged),
      });
    }

    return pickReturningRow<TResult>(restoredRaw, ret.visibleKeys);
  }

  /** Hard-delete — auditable entity (actor required for audit log). */
  async hardDelete<TEntity extends object & IAuditableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  /** Hard-delete — non-auditable entity (actor rejected). */
  async hardDelete<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TResult>;
  async hardDelete<TEntity extends object, TResult = TEntity>(
    entity: EntityClass,
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TResult> {
    const meta = getEntityPersistenceMeta(entity);
    const table = getQualifiedTableName(entity);
    const { conditions: matchConds } = this.resolveMatchConditions(
      meta,
      match as Record<string, unknown>,
      options.matchBy as string | readonly string[] | undefined,
    );
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    assertWriteActor(meta, actor);

    // Optimistic concurrency: extract version from match payload for auditable entities
    const versionCol = findVersionColumn(meta);
    const versionExtract = extractVersion(match as Record<string, unknown>, versionCol, meta.entityClassName);
    const expectedVersion = versionExtract?.expectedVersion ?? null;

    const values: unknown[] = matchConds.map((c) =>
      jsValueToPgParam(c.value, c.hints),
    );
    const matchWhere = identityWhere(matchConds, 1);

    // Fetch old record for audit delta before deleting
    let oldRecord: Record<string, unknown> | null = null;
    if (auditable && options.audit && actor !== undefined) {
      const oldSql = `SELECT * FROM ${table} WHERE ${matchWhere}`;
      const oldResult = await this.db.query(oldSql, values);
      oldRecord = (oldResult.rows[0] as Record<string, unknown>) ?? null;
    }

    // Build WHERE clause with optional version guard for optimistic concurrency
    let whereClause = `WHERE ${matchWhere}`;
    if (expectedVersion !== null && versionCol) {
      values.push(expectedVersion);
      whereClause += ` AND ${quoteIdent(versionCol.sqlName)} = $${values.length}`;
    }

    const ret = buildReturningClause(entity, options.returning);
    const sql = `WITH ${this.buildGuardCte(table, matchConds, 1, matchWhere, "hardDelete")},
w AS (
  DELETE FROM ${table} ${whereClause}
    AND NOT EXISTS (SELECT 1 FROM guard)
  ${ret.clause}
)
SELECT * FROM w`;
    const result = await this.db.query(sql, values);

    if (result.rowCount === 0) {
      if (expectedVersion !== null && versionCol) {
        await disambiguateZeroRows(this.db, table, matchConds, meta.entityClassName, expectedVersion, versionCol.sqlName);
      }
      await this.assertNoPartialIdentity(table, matchConds, meta.entityClassName);
      throw new NotFoundError(
        `No ${table} found with ${matchConds.map((c) => `${c.sqlName} = ${String(c.value)}`).join(" AND ")}`,
      );
    }

    // Write audit log (fire-and-forget) — delta is old=full record, new=empty
    if (auditable && options.audit && actor !== undefined && oldRecord) {
      const entityId = auditEntityId(oldRecord);
      const entityUuid = (oldRecord["uuid"] as string | undefined) ?? "";
      const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);
      const oldVersion = versionCol ? (oldRecord[versionCol.sqlName] as number) : 1;
      const delta: Record<string, { old: unknown; new: unknown }> = {};
      for (const key of Object.keys(oldRecord)) {
        const val = oldRecord[key];
        // Convert bigint to number for JSON serialization
        const oldVal = typeof val === "bigint" ? Number(val) : val;
        delta[key] = { old: oldVal, new: null };
      }
      options.audit.writeAudit({
        entityClassName: meta.entityClassName,
        tableName: meta.tableName,
        entityId,
        entityUuid,
        action: AuditAction.HARD_DELETE,
        changedAt: new Date(),
        version: oldVersion,
        changedBy: actor,
        delta,
      }).catch((err) => (options.logger ?? noopLogger).error("[DAL Audit Error]", err));
    }

    {
      const purgedRow = remapReturningRow(result.rows[0] as Record<string, unknown>, ret.rowKeyToSqlName);
      const before = oldRecord ? eventSafeRecord(oldRecord) : null;
      const evtDelta: Record<string, { old: unknown; new: unknown }> | null = before
        ? Object.fromEntries(Object.keys(before).map((k) => [k, { old: before[k], new: null }]))
        : null;
      this.emitEntityEvent(entity, meta, options, {
        action: "purge",
        uuid: (purgedRow["uuid"] as string | undefined) ?? (oldRecord?.["uuid"] as string | undefined) ?? "",
        version: versionCol ? (purgedRow[versionCol.sqlName] as number | undefined) ?? (oldRecord?.[versionCol.sqlName] as number | undefined) : undefined,
        before: oldRecord ?? null,
        after: purgedRow,
        delta: evtDelta,
      });
    }

    // RETURNING yields the row as it was before the physical delete.
    return pickReturningRow<TResult>(result.rows[0] as Record<string, unknown>, ret.visibleKeys);
  }

  // ─── Clone ─────────────────────────────────────────────────────────────────

  /**
   * Clone an entity record by UUID.
   *
   * Fetches the source record (including soft-deleted), builds a new row with:
   * - PK column excluded (DB auto-generates)
   * - Unique columns excluded (including uuid — a new uuid is generated)
   * - @CloneField column set to sourceUuid
   * - Audit fields reset (created_at=now, created_by=actor, updated_at=now, updated_by=actor, version=1)
   * - Deletable fields reset (deleted_at=null, deleted_by=null)
   * - All other fields copied from source
   *
   * Writes an audit row with action `CLONE` (not INSERT) — version history
   * MUST distinguish "created via clone" from "created via form". The delta
   * is the full new record (same shape as INSERT), and `cloned_from` carries
   * the source uuid.
   */
  async clone<TEntity extends object & IAuditableEntity & IClonableEntity>(
    entity: EntityClass & { new (): TEntity },
    sourceUuid: string,
    options: AuditableWriteOptions,
  ): Promise<TEntity> {
    const meta = getEntityPersistenceMeta(entity);
    const table = getQualifiedTableName(entity);
    const actor = options.actor;

    // Seq-bound columns are @Unique — skipped by the copy loop below — so
    // the clone ALLOCATES a fresh value per bound column (a clone never
    // shares the source's unique code). Claim + INSERT share one tx.
    const seqCols = this.seqBoundColumns(meta);
    if (seqCols.length > 0) {
      if (actor === undefined) {
        throw new ValidationError(
          `clone: seq-bound write on ${meta.entityClassName} requires options.actor — the counter claim is audited`,
        );
      }
      if (this.poolBound()) {
        return this.withSeqTx(options, (r) => r.clone(entity, sourceUuid, options) as Promise<TEntity>);
      }
    }

    // Find the uuid column (marked with @Unique or named 'uuid')
    const uuidColEntry = Object.entries(meta.columns).find(
      ([name, col]) => name === "uuid" || col.isUnique,
    );
    if (!uuidColEntry) throw new Error(`Entity ${meta.entityClassName} has no uuid column`);
    const uuidColMeta = uuidColEntry[1];

    // Fetch source record (including soft-deleted — clone can target deleted records)
    const sourceSql = `SELECT * FROM ${table} WHERE ${quoteIdent(uuidColMeta.sqlName)} = $1`;
    const sourceResult = await this.db.query(sourceSql, [sourceUuid]);
    if (sourceResult.rowCount === 0) {
      throw new NotFoundError(`Source record not found with uuid ${sourceUuid}`);
    }
    const sourceRecord = sourceResult.rows[0] as Record<string, unknown>;

    // Build the cloned record
    const clonedRecord: Record<string, unknown> = {};
    const newUuid = newUuidV7();
    const now = new Date();

    for (const [, colMeta] of Object.entries(meta.columns)) {
      const sqlName = colMeta.sqlName;

      // Skip excluded fields: PK, unique, clone-tracking
      if (colMeta.isKey || colMeta.isUnique || colMeta.isClone) continue;

      // Reset audit fields
      if (colMeta.isAuditable) {
        switch (colMeta.auditableType) {
          case AuditableFieldType.CREATED_AT:
          case AuditableFieldType.UPDATED_AT:
            clonedRecord[sqlName] = now;
            continue;
          case AuditableFieldType.CREATED_BY:
          case AuditableFieldType.UPDATED_BY:
            clonedRecord[sqlName] = actor;
            continue;
          case AuditableFieldType.VERSION:
            clonedRecord[sqlName] = 1;
            continue;
        }
      }

      // Reset deletable fields
      if (colMeta.isDeletable) {
        clonedRecord[sqlName] = null;
        continue;
      }

      // Copy all other fields from source
      if (sourceRecord[sqlName] !== undefined) {
        clonedRecord[sqlName] = sourceRecord[sqlName];
      }
    }

    // Set the new UUID
    clonedRecord[uuidColMeta.sqlName] = newUuid;

    // Set the clone-tracking field to source UUID, and stamp the
    // immutable clone-audit pair (cloned_at / cloned_by) when declared —
    // mirror of the CLONE audit-trail row the entity may emit below.
    const cloneField = Object.values(meta.columns).find((c) => c.isClone);
    if (cloneField) {
      clonedRecord[cloneField.sqlName] = sourceUuid;
    }
    const clonedAtField = Object.values(meta.columns).find((c) => c.cloneType === CloneFieldType.CLONED_AT);
    if (clonedAtField) {
      clonedRecord[clonedAtField.sqlName] = now;
    }
    const clonedByField = Object.values(meta.columns).find((c) => c.cloneType === CloneFieldType.CLONED_BY);
    if (clonedByField && actor !== undefined) {
      clonedRecord[clonedByField.sqlName] = actor;
    }

    // Allocate fresh sequence values for bound columns (skipped by the
    // unique-copy loop above) — inside the same tx as the INSERT.
    for (const col of seqCols) {
      const spec = await this.sequenceSpecFor(this.db, col.seqBound!, null, actor!);
      [clonedRecord[col.sqlName]] = await this.allocateAndRender(this.db, spec, col.length, 1, actor!);
    }

    // Build and execute INSERT
    const columns = Object.keys(clonedRecord);
    const values = Object.values(clonedRecord);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
    const columnNames = columns.map((c) => quoteIdent(c)).join(", ");

    const ret = buildReturningClause(entity, options.returning);
    const insertSql = `INSERT INTO ${table} (${columnNames}) VALUES (${placeholders}) ${ret.clause}`;
    const insertResult = await this.db.query(insertSql, values);

    if (insertResult.rowCount === 0) {
      throw new Error(`Failed to clone record for ${meta.tableName}`);
    }

    // Audit the clone as `CLONE` (fire-and-forget) — full-row delta like
    // INSERT, plus `cloned_from` already carries the source uuid.
    const insertedRow = insertResult.rows[0] as Record<string, unknown>;
    if (options.audit && actor !== undefined) {
      const delta = calculateDelta({}, insertedRow);
      options.audit.writeAudit({
        entityClassName: meta.entityClassName,
        tableName: meta.tableName,
        entityId: auditEntityId(insertedRow),
        entityUuid: newUuid,
        action: AuditAction.CLONE,
        changedAt: now,
        version: 1,
        changedBy: actor,
        delta,
      }).catch((err) => (options.logger ?? noopLogger).error("[DAL Audit Error]", err));
    }

    this.emitEntityEvent(entity, meta, options, {
      action: "duplicate",
      uuid: newUuid,
      version: 1,
      before: null,
      after: remapReturningRow(insertedRow, ret.rowKeyToSqlName),
      delta: calculateDelta({}, remapReturningRow(insertedRow, ret.rowKeyToSqlName)),
    });

    return pickReturningRow<TEntity>(insertedRow, ret.visibleKeys);
  }

  // ─── Bulk ops ──────────────────────────────────────────────────────────────

  /**
   * Bulk add — auditable entity (actor required).
   *
   * @remarks No optimistic concurrency control — INSERT does not need version
   * guards since there is no existing record to compare against.
   * TODO: if a conflict-target upsert variant is added, version guards must be
   * implemented the same way as the single `upsert` method.
   */
  async addMany<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & BulkOptions,
  ): Promise<BulkResult>;
  /** Bulk add — non-auditable entity (actor rejected). */
  async addMany<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & BulkOptions,
  ): Promise<BulkResult>;
  async addMany<TEntity extends object>(
    entity: EntityClass,
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & BulkOptions,
  ): Promise<BulkResult> {
    if (rows.length === 0) return { received: 0, affected: 0 };
    const meta = getEntityPersistenceMeta(entity);
    const table = options.tableName
      ? `${quoteIdent(meta.tableSchema)}.${quoteIdent(options.tableName)}`
      : getQualifiedTableName(entity);
    const pk = findPkColumn(meta);
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    assertWriteActor(meta, actor);

    // Seq-bound columns — bulk contract: every row carries the SAME
    // directive or none (omission = field-default allocation on create).
    // Resolution allocates one contiguous range and runs on the bulk
    // client inside the op's transaction.
    const seqCols = this.seqBoundColumns(meta);
    if (seqCols.length > 0 && actor === undefined) {
      throw new ValidationError(
        `addMany: seq-bound write on ${meta.entityClassName} requires options.actor — the counter claim is audited`,
      );
    }

    const first = rows[0] as Record<string, unknown>;
    let keys = Object.keys(first).filter((k) => first[k] !== undefined);
    // A seq-bound column always resolves to a literal on create — force
    // it into the key set even when every row omitted it.
    for (const c of seqCols) {
      if (!keys.includes(c.propertyKey)) keys.push(c.propertyKey);
    }

    if (pk && meta.columns[pk.sqlName]?.usePostgresIdentity) {
      keys = keys.filter((k) => k !== pk!.propertyKey);
    }

    if (keys.length === 0) {
      throw new ValidationError("addMany: no columns to insert (all undefined?)");
    }

    for (const k of keys) {
      const sqlName = getColumnName(entity, k);
      if (!meta.columns[sqlName]) {
        throw new UnknownColumnError(`addMany: unknown column/property ${k}`);
      }
    }

    // App-injected uids must be v7 — uniform column set, so every row is checked
    const uidCol = Object.values(meta.columns).find((c) => c.sqlName === "uuid");
    const uidProp = uidCol?.propertyKey as keyof TEntity & string;
    if (uidCol && keys.includes(uidProp)) {
      for (const row of rows) {
        if (row[uidProp] !== undefined) {
          assertUuidV7Value(meta.entityClassName, uidCol!.propertyKey, row[uidProp]);
        }
      }
    }

    // Add audit columns
    const auditCols: string[] = [];
    if (auditable && actor !== undefined) {
      for (const c of Object.values(meta.columns)) {
        if (c.isAuditable && !keys.includes(c.propertyKey)) {
          auditCols.push(c.propertyKey);
        }
      }
    }
    const allKeys = [...keys, ...auditCols];
    const colsSql = allKeys.map((k) => quoteIdent(getColumnName(entity, k))).join(", ");

    const now = new Date();
    const batchSz = options.batchSize ?? autoBatchSize(allKeys.length);

    // TEMP TABLE strategy: stream payload into a temp table, detect unique
    // conflicts in one set-based query (single raised ERR04/ERR05 with up to
    // 10 offending rows), then one INSERT ... SELECT. Always transactional —
    // the whole operation is atomic and bounded by the bulk time budget.
    const { client, deadline, owned } = await this.bulkBegin(options);
    try {
      // Seq-bound columns resolve INSIDE this transaction: every row gets a
      // rendered literal before the temp-table payload is staged.
      if (seqCols.length > 0) {
        await this.resolveSeqRows(client, meta, rows as Array<Record<string, unknown>>, actor!, "create");
      }
      // 1. Temp table mirroring the insert columns. Column types are derived
      //    FROM THE REAL TABLE (`AS SELECT … WHERE false`) — the runtime meta
      //    does not resolve annotation types, and re-deriving pg types here
      //    would silently degrade to `text` (uuid = text join errors).
      const tmpName = `tmp_add_${meta.tableName}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const tmpColsSql = allKeys.map((k) => quoteIdent(getColumnName(entity, k))).join(", ");
      await client.query(
        `CREATE TEMP TABLE ${quoteIdent(tmpName)} ON COMMIT DROP AS ` +
          `SELECT ${tmpColsSql} FROM ${table} WHERE false`,
      );

      // 2. Batch INSERT payload into the temp table
      for (let i = 0; i < rows.length; i += batchSz) {
        const batch = rows.slice(i, i + batchSz);
        const values: unknown[] = [];
        const tuples: string[] = [];

        for (const row of batch) {
          const rec = row as Record<string, unknown>;
          const params: string[] = [];
          for (const k of keys) {
            const sqlName = getColumnName(entity, k);
            const colMeta = meta.columns[sqlName];
            const rawVal = rec[k] ?? null;
            const pgVal = colMeta ? jsValueToPgParam(rawVal, columnHintsFromMetaColumn(colMeta)) : rawVal;
            values.push(pgVal);
            params.push(`$${values.length}`);
          }
          // Add audit stamping
          for (const ak of auditCols) {
            const col = Object.values(meta.columns).find((c) => c.propertyKey === ak);
            if (!col) continue;
            if (col.auditableType === AuditableFieldType.CREATED_AT || col.auditableType === AuditableFieldType.UPDATED_AT) {
              values.push(now);
            } else if (col.auditableType === AuditableFieldType.CREATED_BY || col.auditableType === AuditableFieldType.UPDATED_BY) {
              values.push(actor);
            } else if (col.auditableType === AuditableFieldType.VERSION) {
              values.push(1);
            } else {
              values.push(null);
            }
            params.push(`$${values.length}`);
          }
          tuples.push(`(${params.join(", ")})`);
        }

        await client.query(`INSERT INTO ${quoteIdent(tmpName)} (${tmpColsSql}) VALUES ${tuples.join(", ")}`, values);
        this.assertBulkAlive(deadline, "addMany");
      }

      // 3. Conflict detection — one join over bindable unique groups; if any
      //    row conflicts, a single pg_raise aborts the transaction carrying
      //    the total count plus up to 10 offending rows in DETAIL.
      //    ERR04 = at least one conflict is on a live row; ERR05 only when
      //    every conflict hits a soft-deleted row.
      const predicates = this.bulkConflictPredicates(entity, meta, allKeys, tmpName, options.conflictKeys);
      if (predicates.length > 0) {
        const uuidSel = meta.columns["uuid"] ? `t.${quoteIdent("uuid")}` : "NULL";
        const tmpUuidSel = allKeys.includes("uuid") ? `tmp.${quoteIdent("uuid")}` : "NULL";
        const deletedAtCol = Object.values(meta.columns).find(
          (c) => c.deletableType === DeletableFieldType.DELETED_AT,
        );
        const deletedSel = deletedAtCol ? `t.${quoteIdent(deletedAtCol.sqlName)}` : "NULL";
        const joinOr = predicates.map((p) => `(${p.sql})`).join("\n        OR ");
        const constraintCase = predicates
          .map((p) => `WHEN (${p.sql}) THEN ${escapeLiteral(p.name)}`)
          .join(" ");
        const keysCase = predicates
          .map(
            (p) =>
              `WHEN (${p.sql}) THEN jsonb_build_object(${p.keys
                .map((k) => `${escapeLiteral(k)}, tmp.${quoteIdent(k)}`)
                .join(", ")})`,
          )
          .join(" ");
        const conflictSql = `WITH conf AS (
  SELECT ${uuidSel} AS c_uuid, ${tmpUuidSel} AS c_input_uuid,
         ${deletedSel} AS c_deleted_at,
         CASE ${constraintCase} END AS c_constraint,
         CASE ${keysCase} END AS c_keys
  FROM ${quoteIdent(tmpName)} tmp
  JOIN ${table} t ON ${joinOr}
),
agg AS (SELECT count(*) AS n, bool_and(c_deleted_at IS NOT NULL) AS all_del${getRelationFacet(entity) !== undefined ? `, bool_or(c_constraint = ${escapeLiteral(`${meta.tableName}_pair_uq_reversed`)}) AS any_rev` : ""} FROM conf),
det AS (
  SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) AS rows
  FROM (
    SELECT c_uuid AS uuid, c_input_uuid AS input_uuid,
           ${this.conflictErrCode(entity, meta, "c_deleted_at", "c_constraint")} AS code,
           (c_deleted_at IS NOT NULL) AS deleted, c_constraint AS "constraint",
           c_keys AS keys
    FROM conf LIMIT 10
  ) x
)
SELECT public.pg_raise(
  ${getRelationFacet(entity) !== undefined ? `CASE WHEN agg.any_rev THEN 'ERR11' WHEN agg.all_del THEN 'ERR05' ELSE 'ERR04' END` : `CASE WHEN agg.all_del THEN 'ERR05' ELSE 'ERR04' END`},
  ${escapeLiteral(`addMany: unique constraint violation on ${meta.entityClassName}`)},
  jsonb_build_object(
    'entity', ${escapeLiteral(meta.entityClassName)},
    'table', ${escapeLiteral(`${meta.tableSchema}.${meta.tableName}`)},
    'conflicts', agg.n,
    'rows', det.rows
  )::text
)
FROM agg, det
WHERE agg.n > 0`;
        await client.query(conflictSql);
        this.assertBulkAlive(deadline, "addMany");
      }

      // 4. Final write — single INSERT from the temp table
      const insertRes = await client.query(
        `INSERT INTO ${table} (${colsSql}) SELECT ${tmpColsSql} FROM ${quoteIdent(tmpName)}`,
      );
      const affected = insertRes.rowCount ?? 0;

      if (owned) await client.query("COMMIT");
      this.emitBulkEntityEvents(entity, meta, options, "bulk_create", rows as Array<Record<string, unknown>>, affected);
      return { received: rows.length, affected };
    } catch (err) {
      if (owned) await this.bulkAbort(client);
      throw err;
    } finally {
      if (owned) (client as any).release?.();
    }
  }

  // ─── upsertMany — COMMENTED OUT pending guarded/unguarded decision ────
  // upsertMany conflict path overwrites unconditionally (no version guard).
  // Parked until we decide guarded vs sync-import semantics.
//
//    * Bulk upsert — auditable entity (actor required).
//    *
//    * @remarks No optimistic concurrency control — unlike the single `upsert`
//    * method, `upsertMany` does NOT extract or verify `version` against the
//    * existing record. The ON CONFLICT DO UPDATE path increments version
//    * unconditionally without checking the expected version. This means
//    * concurrent upserts can silently overwrite stale data.
//    * TODO: add per-row version guard in the ON CONFLICT WHERE clause so that
//    * a row is only updated when `${table}.version = EXCLUDED.expected_version`.
//    */
//   async upsertMany<TEntity extends object & IAuditableEntity>(
//     entity: EntityClass & { new (): TEntity },
//     rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
//     options: AuditableWriteOptions & BulkOptions & UpsertOptions,
//   ): Promise<BulkResult>;
//   /** Bulk upsert — non-auditable entity (actor rejected). */
//   async upsertMany<TEntity extends object>(
//     entity: EntityClass & { new (): TEntity },
//     rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
//     options: WriteOptions & BulkOptions & UpsertOptions,
//   ): Promise<BulkResult>;
//   async upsertMany<TEntity extends object>(
//     entity: EntityClass,
//     rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
//     options: (WriteOptions | AuditableWriteOptions) & BulkOptions & UpsertOptions
//   ): Promise<BulkResult> {
//     if (rows.length === 0) return { received: 0, affected: 0 };
//     const meta = getEntityPersistenceMeta(entity);
//     const table = getQualifiedTableName(entity);
//     const pk = findPkColumn(meta);
//     const auditable = isAuditableEntity(meta);
//     const actor = (options as AuditableWriteOptions).actor;
//     const conflictTarget = options.conflictTarget ?? pk?.sqlName ?? "uuid";

//     // Find the conflict target's property key and check if it's a uuid column
//     const conflictColMeta = Object.values(meta.columns).find((c) => c.sqlName === conflictTarget);
//     const conflictPropKey = conflictColMeta?.propertyKey ?? conflictTarget;
//     const conflictIsUuid = conflictColMeta
//       ? effectivePgStorageType(columnHintsFromMetaColumn(conflictColMeta)) === "uuid"
//       : conflictTarget === "uuid";

//     const first = rows[0] as Record<string, unknown>;
//     let keys = Object.keys(first).filter((k) => first[k] !== undefined);

//     if (pk && meta.columns[pk.sqlName]?.usePostgresIdentity) {
//       keys = keys.filter((k) => k !== pk!.propertyKey);
//     }

//     if (keys.length === 0) {
//       throw new ValidationError("upsertMany: no columns to insert (all undefined?)");
//     }

//     for (const k of keys) {
//       const sqlName = getColumnName(entity, k);
//       if (!meta.columns[sqlName]) {
//         throw new UnknownColumnError(`upsertMany: unknown column/property ${k}`);
//       }
//     }

//     // Add audit columns for INSERT path
//     const auditCols: string[] = [];
//     if (auditable && actor !== undefined) {
//       for (const c of Object.values(meta.columns)) {
//         if (c.isAuditable && !keys.includes(c.propertyKey)) {
//           auditCols.push(c.propertyKey);
//         }
//       }
//     }
//     const allKeys = [...keys, ...auditCols];
//     const colsSql = allKeys.map((k) => quoteIdent(getColumnName(entity, k))).join(", ");

//     // Build ON CONFLICT DO UPDATE SET — audit-aware
//     const updateCols: string[] = [];
//     for (const k of keys) {
//       const sqlName = getColumnName(entity, k);
//       const col = meta.columns[sqlName];
//       if (sqlName === conflictTarget) continue;
//       if (col?.auditableType === AuditableFieldType.CREATED_AT) continue;
//       if (col?.auditableType === AuditableFieldType.CREATED_BY) continue;
//       updateCols.push(`${quoteIdent(sqlName)} = EXCLUDED.${quoteIdent(sqlName)}`);
//     }

//     // Add audit stamping for UPDATE path
//     if (auditable && actor !== undefined) {
//       const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
//       const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
//       const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);

//       if (updatedAtCol) updateCols.push(`${quoteIdent(updatedAtCol.sqlName)} = EXCLUDED.${quoteIdent(updatedAtCol.sqlName)}`);
//       if (updatedByCol) updateCols.push(`${quoteIdent(updatedByCol.sqlName)} = EXCLUDED.${quoteIdent(updatedByCol.sqlName)}`);
//       if (versionCol) updateCols.push(`${quoteIdent(versionCol.sqlName)} = ${table}.${quoteIdent(versionCol.sqlName)} + 1`);
//     }

//     const now = new Date();
//     const batchSz = options.batchSize ?? autoBatchSize(allKeys.length);
    

//     // TEMP TABLE strategy: stream payload into a temp table, then a single
//     // INSERT ... SELECT ... ON CONFLICT DO UPDATE. Always transactional —
//     // atomic and bounded by the bulk time budget.
//     const { client, deadline } = await this.bulkBegin(options);
//     try {
//       // 1. Temp table mirroring the insert columns
//       const tmpName = `tmp_upsert_${meta.tableName}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
//       const tmpColDefs = allKeys
//         .map((k) => {
//           const colMeta = Object.values(meta.columns).find((c) => c.propertyKey === k);
//           const pgType = colMeta ? effectivePgStorageType(columnHintsFromMetaColumn(colMeta)) : "text";
//           return `${quoteIdent(getColumnName(entity, k))} ${pgType}`;
//         })
//         .join(", ");
//       await client.query(`CREATE TEMP TABLE ${quoteIdent(tmpName)} (${tmpColDefs}) ON COMMIT DROP`);

//       // 2. Batch INSERT payload into the temp table
//       const tmpColsSql = allKeys.map((k) => quoteIdent(getColumnName(entity, k))).join(", ");
//       for (let i = 0; i < rows.length; i += batchSz) {
//         const batch = rows.slice(i, i + batchSz);
//         const values: unknown[] = [];
//         const tuples: string[] = [];

//         for (const row of batch) {
//           const rec = row as Record<string, unknown>;
//           const params: string[] = [];
//           for (const k of keys) {
//             const sqlName = getColumnName(entity, k);
//             const colMeta = meta.columns[sqlName];
//             const rawVal = rec[k] ?? null;
//             const pgVal = colMeta ? jsValueToPgParam(rawVal, columnHintsFromMetaColumn(colMeta)) : rawVal;
//             values.push(pgVal);
//             params.push(`$${values.length}`);
//           }
//           for (const ak of auditCols) {
//             const col = Object.values(meta.columns).find((c) => c.propertyKey === ak);
//             if (!col) continue;
//             if (col.auditableType === AuditableFieldType.CREATED_AT || col.auditableType === AuditableFieldType.UPDATED_AT) {
//               values.push(now);
//             } else if (col.auditableType === AuditableFieldType.CREATED_BY || col.auditableType === AuditableFieldType.UPDATED_BY) {
//               values.push(actor);
//             } else if (col.auditableType === AuditableFieldType.VERSION) {
//               values.push(1);
//             } else {
//               values.push(null);
//             }
//             params.push(`$${values.length}`);
//           }
//           tuples.push(`(${params.join(", ")})`);
//         }

//         await client.query(`INSERT INTO ${quoteIdent(tmpName)} (${tmpColsSql}) VALUES ${tuples.join(", ")}`, values);
//         this.assertBulkAlive(deadline, "upsertMany");
//       }

//       // 3. Single INSERT ... SELECT ... ON CONFLICT DO UPDATE from the temp
//       //    table. For a uuid conflict target, missing uuids are generated
//       //    at SELECT time (COALESCE → gen_random_uuid()).
//       const selectCols = allKeys
//         .map((k) => {
//           const sqlName = getColumnName(entity, k);
//           return k === conflictPropKey && conflictIsUuid
//             ? `COALESCE(tmp.${quoteIdent(sqlName)}, gen_random_uuid())`
//             : `tmp.${quoteIdent(sqlName)}`;
//         })
//         .join(", ");
//       const upsertSql =
//         `INSERT INTO ${table} (${colsSql}) SELECT ${selectCols} FROM ${quoteIdent(tmpName)} tmp ` +
//         `ON CONFLICT (${quoteIdent(conflictTarget)}) DO UPDATE SET ${updateCols.join(", ")}`;
//       const upsertRes = await client.query(upsertSql);
//       const affected = upsertRes.rowCount ?? 0;

//       await client.query("COMMIT");
//       return { received: rows.length, affected };
//     } catch (err) {
//       await this.bulkAbort(client);
//       throw err;
//     } finally {
//       (client as any).release?.();
//     }
//   }

  /** Bulk soft-delete — auditable+deletable entity (actor required). */
  async deleteMany<TEntity extends object & IAuditableEntity & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<BulkResult>;
  /** Bulk soft-delete — deletable but non-auditable entity (actor rejected). */
  async deleteMany<TEntity extends object & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<BulkResult>;
  async deleteMany<TEntity extends object>(
    entity: EntityClass,
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<BulkResult> {
    if (matches.length === 0) return { received: 0, affected: 0 };
    const meta = getEntityPersistenceMeta(entity);
    const table = getQualifiedTableName(entity);
    const matchCols = this.resolveBulkMatchColumns(
      meta,
      matches as Array<Record<string, unknown>>,
      options.matchBy,
      "deleteMany",
    );
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    assertWriteActor(meta, actor);
    const isDeletable = Object.values(meta.columns).some((c) => c.isDeletable);
    if (!isDeletable) throw new Error(`Entity ${meta.entityClassName} has no @DeletableField — cannot soft delete`);

    const now = new Date();

    const deletedAtCol = Object.values(meta.columns).find((c) => c.deletableType === DeletableFieldType.DELETED_AT);
    const deletedByCol = Object.values(meta.columns).find((c) => c.deletableType === DeletableFieldType.DELETED_BY);
    const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
    const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
    const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);

    // Per-row optimistic concurrency: every match object must carry the
    // caller-observed `version` on auditable entities (strict — same contract
    // as delete()).
    const versionGuard = this.extractExpectedVersions(
      meta,
      matches as Array<Record<string, unknown>>,
      matchCols[0].propertyKey,
      "deleteMany",
    );

    // TEMP TABLE strategy (same as updateMany): stream match keys into a temp
    // table, then a single UPDATE ... FROM — a JOIN beats ANY($n::[]) and has
    // no parameter-count ceiling (~65535 limit of ANY/IN does not apply).
    const { client, deadline, owned } = await this.bulkBegin(options as BulkOptions);
    try {
      // 1. Temp table: row_ix + all identity columns (+ expected_version)
      const tmpName = `tmp_delete_${meta.tableName}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      // Temp table types derive FROM THE REAL TABLE — runtime meta has no
      // annotation types (AS SELECT … WHERE false inherits them verbatim).
      const tmpSelCols = [
        "NULL::bigint AS row_ix",
        ...matchCols.map((c) => quoteIdent(c.sqlName)),
        ...(versionGuard.guard ? ["NULL::integer AS expected_version"] : []),
      ];
      await client.query(
        `CREATE TEMP TABLE ${quoteIdent(tmpName)} ON COMMIT DROP AS ` +
          `SELECT ${tmpSelCols.join(", ")} FROM ${table} WHERE false`,
      );

      // 2. Batch INSERT match keys (+ expected_version) into temp table
      const batchSz = autoBatchSize(matchCols.length + 1 + (versionGuard.guard ? 1 : 0));
      const tmpColsSql = matchCols.map((c) => quoteIdent(c.sqlName)).join(", ");
      for (let i = 0; i < matches.length; i += batchSz) {
        const batch = matches.slice(i, i + batchSz);
        const values: unknown[] = [];
        const tuples: string[] = [];
        for (const [bi, m] of batch.entries()) {
          const rec = m as Record<string, unknown>;
          values.push(i + bi);
          const ph = [`$${values.length}`];
          for (const c of matchCols) {
            values.push(jsValueToPgParam(rec[c.propertyKey], c.hints));
            ph.push(`$${values.length}`);
          }
          if (versionGuard.guard) {
            values.push(versionGuard.versions[i + bi]);
            ph.push(`$${values.length}`);
          }
          tuples.push(`(${ph.join(", ")})`);
        }
        await client.query(
          `INSERT INTO ${quoteIdent(tmpName)} (row_ix, ${tmpColsSql}` +
          `${versionGuard.guard ? ", expected_version" : ""}) VALUES ${tuples.join(", ")}`,
          values,
        );
        this.assertBulkAlive(deadline, "deleteMany");
      }

      // 3. SET clause — fixed columns, values inline as params
      const setClauses: string[] = [];
      const setValues: unknown[] = [];
      if (deletedAtCol) {
        setValues.push(now);
        setClauses.push(`${quoteIdent(deletedAtCol.sqlName)} = $${setValues.length}`);
      }
      if (deletedByCol && auditable && actor !== undefined) {
        setValues.push(actor);
        setClauses.push(`${quoteIdent(deletedByCol.sqlName)} = $${setValues.length}`);
      }
      if (updatedAtCol && auditable && actor !== undefined) {
        setValues.push(now);
        setClauses.push(`${quoteIdent(updatedAtCol.sqlName)} = $${setValues.length}`);
      }
      if (updatedByCol && auditable && actor !== undefined) {
        setValues.push(actor);
        setClauses.push(`${quoteIdent(updatedByCol.sqlName)} = $${setValues.length}`);
      }
      if (versionCol && auditable) {
        setClauses.push(`${quoteIdent(versionCol.sqlName)} = ${table}.${quoteIdent(versionCol.sqlName)} + 1`);
      }

      // Audit snapshot of rows about to be deleted (same transaction)
      let tmpOldName: string | null = null;
      const auditEnabled = !!(auditable && actor !== undefined && (options as AuditableWriteOptions).audit);
      if (auditEnabled) {
        tmpOldName = `tmp_old_${meta.tableName}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        await client.query(
          `CREATE TEMP TABLE ${quoteIdent(tmpOldName)} ON COMMIT DROP AS ` +
          `SELECT t.* FROM ${table} t ` +
          `INNER JOIN ${quoteIdent(tmpName)} tmp ` +
          `ON ${this.bulkJoinPredicate("t", "tmp", matchCols)}`,
        );
      }

      // Ambiguity guard — one set-based aggregate; any tmp item matching >1
      // row raises ERR10 and aborts the whole transaction before any write.
      await client.query(this.bulkAmbiguousSql(meta, table, matchCols, tmpName, "deleteMany"));

      // No RETURNING — bulk ops return nothing (204 contract); rowCount comes
      // from the command tag.
      // Version guard pre-check: stale/vanished/incoherent rows → one pg_raise
      // (ERR01, ERR03 when all vanished, ERR10 on incoherent identity),
      // aborting the whole transaction before any write.
      if (versionGuard.guard) {
        await client.query(
          this.bulkStaleDiagnoseSql(meta, table, matchCols, tmpName, versionGuard.versionColSqlName, "deleteMany"),
        );
        this.assertBulkAlive(deadline, "deleteMany");
      }

      const sql =
        `UPDATE ${table} SET ${setClauses.join(", ")} FROM ${quoteIdent(tmpName)} tmp ` +
        `WHERE ${this.bulkJoinPredicate(table, "tmp", matchCols)}` +
        (versionGuard.guard && versionCol
          ? ` AND ${table}.${quoteIdent(versionCol.sqlName)} = tmp.expected_version`
          : "");
      const result = await client.query(sql, setValues);

      // Race guard: the pre-check was clean but a concurrent commit slipped in
      // between it and this UPDATE → guarded rows were skipped. All-or-nothing:
      // roll back with ERR01 rather than persist a partial write.
      if (versionGuard.guard && (result.rowCount ?? 0) < matches.length) {
        throw new OptimisticLockError(
          `deleteMany: ${matches.length - (result.rowCount ?? 0)} row(s) changed concurrently during the bulk operation on ${meta.entityClassName} — rolled back.`,
        );
      }

      // 4. Audit records atomically — delta = all columns old→null semantics
      //    is approximated by old→new on the stamped fields (matching the
      //    single-record SOFT_DELETE delta behavior).
      if (auditEnabled && tmpOldName && result.rowCount && result.rowCount > 0) {
        const auditTable = `${quoteIdent(meta.tableSchema)}.${quoteIdent(`${meta.tableName}_audit`)}`;
        const hasId = hasSurrogateId(meta);
        const deltaColumns = Object.values(meta.columns).filter((c) =>
          c.auditableType !== AuditableFieldType.CREATED_AT &&
          c.auditableType !== AuditableFieldType.CREATED_BY,
        );
        const deltaExpr = deltaColumns
          .map((c) => {
            const col = quoteIdent(c.sqlName);
            return `'${c.sqlName}', CASE WHEN o.${col} IS DISTINCT FROM u.${col} THEN jsonb_build_object('old', o.${col}, 'new', u.${col}) END`;
          })
          .join(",\n          ");
        const auditSql =
          `INSERT INTO ${auditTable} (${hasId ? "entity_id, " : ""}entity_uuid, action, changed_at, changed_by, version, delta)\n` +
          `          SELECT ${hasId ? `u.${quoteIdent("id")}, ` : ""}u.uuid, 'SOFT_DELETE', $1, $2, u.${quoteIdent(versionCol!.sqlName)},\n` +
          `            jsonb_strip_nulls(jsonb_build_object(\n` +
          `              ${deltaExpr}\n` +
          `            ))\n` +
          `          FROM ${table} u\n` +
          `          INNER JOIN ${quoteIdent(tmpOldName)} o ON ${this.bulkJoinPredicate("u", "o", matchCols)}`;
        await client.query(auditSql, [now, actor]);
      }

      if (owned) await client.query("COMMIT");
      this.emitBulkEntityEvents(entity, meta, options, "bulk_delete", matches as Array<Record<string, unknown>>, result.rowCount ?? 0);
      return { received: matches.length, affected: result.rowCount ?? 0 };
    } catch (err) {
      if (owned) await this.bulkAbort(client);
      throw err;
    } finally {
      if (owned) (client as any).release?.();
    }
  }

  /** Bulk hard-delete — auditable entity (actor required for audit). */
  async hardDeleteMany<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult>;
  /** Bulk hard-delete — non-auditable entity (actor rejected). */
  async hardDeleteMany<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult>;
  /**
   * Bulk PHYSICAL delete — same TEMP TABLE strategy as `deleteMany` but
   * emits `DELETE FROM … USING tmp` instead of the soft-delete UPDATE.
   * Works on deletable AND non-deletable entities (derived-index tables,
   * append-only logs). All-or-nothing: ambiguity/version races roll back.
   */
  async hardDeleteMany<TEntity extends object>(
    entity: EntityClass,
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult> {
    if (matches.length === 0) return { received: 0, affected: 0 };
    const meta = getEntityPersistenceMeta(entity);
    const table = getQualifiedTableName(entity);
    const matchCols = this.resolveBulkMatchColumns(
      meta,
      matches as Array<Record<string, unknown>>,
      options.matchBy,
      "hardDeleteMany",
    );
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    assertWriteActor(meta, actor);
    const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);

    const versionGuard = auditable
      ? this.extractExpectedVersions(
          meta,
          matches as Array<Record<string, unknown>>,
          matchCols[0].propertyKey,
          "hardDeleteMany",
        )
      : { guard: false, versions: [] as number[], versionColSqlName: "" };

    const { client, deadline, owned } = await this.bulkBegin(options as BulkOptions);
    try {
      const tmpName = `tmp_hdel_${meta.tableName}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      // Temp table types derive FROM THE REAL TABLE — runtime meta has no
      // annotation types (AS SELECT … WHERE false inherits them verbatim).
      const tmpSelCols = [
        "NULL::bigint AS row_ix",
        ...matchCols.map((c) => quoteIdent(c.sqlName)),
        ...(versionGuard.guard ? ["NULL::integer AS expected_version"] : []),
      ];
      await client.query(
        `CREATE TEMP TABLE ${quoteIdent(tmpName)} ON COMMIT DROP AS ` +
          `SELECT ${tmpSelCols.join(", ")} FROM ${table} WHERE false`,
      );

      const batchSz = autoBatchSize(matchCols.length + 1 + (versionGuard.guard ? 1 : 0));
      const tmpColsSql = matchCols.map((c) => quoteIdent(c.sqlName)).join(", ");
      for (let i = 0; i < matches.length; i += batchSz) {
        const batch = matches.slice(i, i + batchSz);
        const values: unknown[] = [];
        const tuples: string[] = [];
        for (const [bi, m] of batch.entries()) {
          const rec = m as Record<string, unknown>;
          values.push(i + bi);
          const ph = [`$${values.length}`];
          for (const c of matchCols) {
            values.push(jsValueToPgParam(rec[c.propertyKey], c.hints));
            ph.push(`$${values.length}`);
          }
          if (versionGuard.guard) {
            values.push(versionGuard.versions[i + bi]);
            ph.push(`$${values.length}`);
          }
          tuples.push(`(${ph.join(", ")})`);
        }
        await client.query(
          `INSERT INTO ${quoteIdent(tmpName)} (row_ix, ${tmpColsSql}` +
          `${versionGuard.guard ? ", expected_version" : ""}) VALUES ${tuples.join(", ")}`,
          values,
        );
        this.assertBulkAlive(deadline, "hardDeleteMany");
      }

      // Audit snapshot of rows about to be physically deleted (same tx).
      let tmpOldName: string | null = null;
      const auditEnabled = !!(auditable && actor !== undefined && (options as AuditableWriteOptions).audit);
      if (auditEnabled) {
        tmpOldName = `tmp_old_${meta.tableName}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        await client.query(
          `CREATE TEMP TABLE ${quoteIdent(tmpOldName)} ON COMMIT DROP AS ` +
          `SELECT t.* FROM ${table} t ` +
          `INNER JOIN ${quoteIdent(tmpName)} tmp ` +
          `ON ${this.bulkJoinPredicate("t", "tmp", matchCols)}`,
        );
      }

      await client.query(this.bulkAmbiguousSql(meta, table, matchCols, tmpName, "hardDeleteMany"));

      if (versionGuard.guard) {
        await client.query(
          this.bulkStaleDiagnoseSql(meta, table, matchCols, tmpName, versionGuard.versionColSqlName, "hardDeleteMany"),
        );
        this.assertBulkAlive(deadline, "hardDeleteMany");
      }

      const result = await client.query(
        `DELETE FROM ${table} USING ${quoteIdent(tmpName)} tmp ` +
        `WHERE ${this.bulkJoinPredicate(table, "tmp", matchCols)}` +
        (versionGuard.guard && versionCol
          ? ` AND ${table}.${quoteIdent(versionCol.sqlName)} = tmp.expected_version`
          : ""),
      );

      if (versionGuard.guard && (result.rowCount ?? 0) < matches.length) {
        throw new OptimisticLockError(
          `hardDeleteMany: ${matches.length - (result.rowCount ?? 0)} row(s) changed concurrently during the bulk operation on ${meta.entityClassName} — rolled back.`,
        );
      }

      // Audit rows: delta = every column old→null (single-record HARD_DELETE
      // semantics), sourced from the pre-delete snapshot.
      if (auditEnabled && tmpOldName && result.rowCount && result.rowCount > 0) {
        const auditTable = `${quoteIdent(meta.tableSchema)}.${quoteIdent(`${meta.tableName}_audit`)}`;
        const hasId = hasSurrogateId(meta);
        const deltaExpr = Object.values(meta.columns)
          .map((c) => `'${c.sqlName}', jsonb_build_object('old', o.${quoteIdent(c.sqlName)}, 'new', null)`)
          .join(",\n          ");
        await client.query(
          `INSERT INTO ${auditTable} (${hasId ? "entity_id, " : ""}entity_uuid, action, changed_at, changed_by, version, delta)\n` +
          `          SELECT ${hasId ? `o.${quoteIdent("id")}, ` : ""}o.uuid, 'HARD_DELETE', $1, $2, o.${quoteIdent(versionCol!.sqlName)},\n` +
          `            jsonb_build_object(\n              ${deltaExpr}\n            )\n` +
          `          FROM ${quoteIdent(tmpOldName)} o`,
          [new Date(), actor],
        );
      }

      if (owned) await client.query("COMMIT");
      this.emitBulkEntityEvents(entity, meta, options, "bulk_purge", matches as Array<Record<string, unknown>>, result.rowCount ?? 0);
      return { received: matches.length, affected: result.rowCount ?? 0 };
    } catch (err) {
      if (owned) await this.bulkAbort(client);
      throw err;
    } finally {
      if (owned) (client as any).release?.();
    }
  }

  /** Bulk restore — auditable+deletable entity (actor required). */
  async restoreMany<TEntity extends object & IAuditableEntity & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult>;
  /** Bulk restore — deletable but non-auditable entity (actor rejected). */
  async restoreMany<TEntity extends object & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult>;
  async restoreMany<TEntity extends object>(
    entity: EntityClass,
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult> {
    if (matches.length === 0) return { received: 0, affected: 0 };
    const meta = getEntityPersistenceMeta(entity);
    const table = getQualifiedTableName(entity);
    const matchCols = this.resolveBulkMatchColumns(
      meta,
      matches as Array<Record<string, unknown>>,
      options.matchBy,
      "restoreMany",
    );
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    assertWriteActor(meta, actor);
    const isDeletable = Object.values(meta.columns).some((c) => c.isDeletable);
    if (!isDeletable) throw new Error(`Entity ${meta.entityClassName} has no @DeletableField — cannot restore`);

    const versionGuard = this.extractExpectedVersions(
      meta,
      matches as Array<Record<string, unknown>>,
      matchCols[0].propertyKey,
      "restoreMany",
    );

    const now = new Date();
    const deletedAtCol = Object.values(meta.columns).find((c) => c.deletableType === DeletableFieldType.DELETED_AT);
    const deletedByCol = Object.values(meta.columns).find((c) => c.deletableType === DeletableFieldType.DELETED_BY);
    const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
    const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
    const versionCol = findVersionColumn(meta);

    const { client, deadline, owned } = await this.bulkBegin(options);
    try {
      const tmpName = `tmp_restore_${meta.tableName}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      // Temp table types derive FROM THE REAL TABLE — runtime meta has no
      // annotation types (AS SELECT … WHERE false inherits them verbatim).
      const tmpSelCols = [
        "NULL::bigint AS row_ix",
        ...matchCols.map((c) => quoteIdent(c.sqlName)),
        ...(versionGuard.guard ? ["NULL::integer AS expected_version"] : []),
      ];
      await client.query(
        `CREATE TEMP TABLE ${quoteIdent(tmpName)} ON COMMIT DROP AS ` +
          `SELECT ${tmpSelCols.join(", ")} FROM ${table} WHERE false`,
      );

      const batchSz = autoBatchSize(matchCols.length + 1 + (versionGuard.guard ? 1 : 0));
      const tmpColsSql = matchCols.map((c) => quoteIdent(c.sqlName)).join(", ");
      for (let i = 0; i < matches.length; i += batchSz) {
        const batch = matches.slice(i, i + batchSz);
        const values: unknown[] = [];
        const tuples: string[] = [];
        for (const [bi, m] of batch.entries()) {
          const rec = m as Record<string, unknown>;
          values.push(i + bi);
          const ph = [`$${values.length}`];
          for (const c of matchCols) {
            values.push(jsValueToPgParam(rec[c.propertyKey], c.hints));
            ph.push(`$${values.length}`);
          }
          if (versionGuard.guard) {
            values.push(versionGuard.versions[i + bi]);
            ph.push(`$${values.length}`);
          }
          tuples.push(`(${ph.join(", ")})`);
        }
        await client.query(
          `INSERT INTO ${quoteIdent(tmpName)} (row_ix, ${tmpColsSql}` +
          `${versionGuard.guard ? ", expected_version" : ""}) VALUES ${tuples.join(", ")}`,
          values,
        );
        this.assertBulkAlive(deadline, "restoreMany");
      }

      // SET — same semantics as single restore(): clear tombstones, stamp
      // updated_*, bump version.
      const setClauses: string[] = [];
      const setValues: unknown[] = [];
      if (deletedAtCol) setClauses.push(`${quoteIdent(deletedAtCol.sqlName)} = NULL`);
      if (deletedByCol) setClauses.push(`${quoteIdent(deletedByCol.sqlName)} = NULL`);
      if (updatedAtCol && auditable && actor !== undefined) {
        setValues.push(now);
        setClauses.push(`${quoteIdent(updatedAtCol.sqlName)} = $${setValues.length}`);
      }
      if (updatedByCol && auditable && actor !== undefined) {
        setValues.push(actor);
        setClauses.push(`${quoteIdent(updatedByCol.sqlName)} = $${setValues.length}`);
      }
      if (versionCol && auditable) {
        setClauses.push(`${quoteIdent(versionCol.sqlName)} = ${table}.${quoteIdent(versionCol.sqlName)} + 1`);
      }

      let tmpOldName: string | null = null;
      const auditEnabled = !!(auditable && actor !== undefined && (options as AuditableWriteOptions).audit);
      if (auditEnabled) {
        tmpOldName = `tmp_old_${meta.tableName}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        await client.query(
          `CREATE TEMP TABLE ${quoteIdent(tmpOldName)} ON COMMIT DROP AS ` +
          `SELECT t.* FROM ${table} t ` +
          `INNER JOIN ${quoteIdent(tmpName)} tmp ` +
          `ON ${this.bulkJoinPredicate("t", "tmp", matchCols)}`,
        );
      }

      // Ambiguity guard — any tmp item matching >1 row raises ERR10, aborting
      // the whole transaction before any write.
      await client.query(this.bulkAmbiguousSql(meta, table, matchCols, tmpName, "restoreMany"));

      // Version guard pre-check (same-tx) — stale/vanished/incoherent → one pg_raise.
      if (versionGuard.guard) {
        await client.query(
          this.bulkStaleDiagnoseSql(meta, table, matchCols, tmpName, versionGuard.versionColSqlName, "restoreMany"),
        );
        this.assertBulkAlive(deadline, "restoreMany");
      }

      const sql =
        `UPDATE ${table} SET ${setClauses.join(", ")} FROM ${quoteIdent(tmpName)} tmp ` +
        `WHERE ${this.bulkJoinPredicate(table, "tmp", matchCols)}` +
        (versionGuard.guard && versionCol
          ? ` AND ${table}.${quoteIdent(versionCol.sqlName)} = tmp.expected_version`
          : "");
      const result = await client.query(sql, setValues);

      // Race guard — concurrent commit between pre-check and UPDATE.
      if (versionGuard.guard && (result.rowCount ?? 0) < matches.length) {
        throw new OptimisticLockError(
          `restoreMany: ${matches.length - (result.rowCount ?? 0)} row(s) changed concurrently during the bulk operation on ${meta.entityClassName} — rolled back.`,
        );
      }

      if (auditEnabled && tmpOldName && result.rowCount && result.rowCount > 0) {
        const auditTable = `${quoteIdent(meta.tableSchema)}.${quoteIdent(`${meta.tableName}_audit`)}`;
        const hasId = hasSurrogateId(meta);
        const deltaColumns = Object.values(meta.columns).filter((c) =>
          c.auditableType !== AuditableFieldType.CREATED_AT &&
          c.auditableType !== AuditableFieldType.CREATED_BY,
        );
        const deltaExpr = deltaColumns
          .map((c) => {
            const col = quoteIdent(c.sqlName);
            return `'${c.sqlName}', CASE WHEN o.${col} IS DISTINCT FROM u.${col} THEN jsonb_build_object('old', o.${col}, 'new', u.${col}) END`;
          })
          .join(",\n          ");
        const auditSql =
          `INSERT INTO ${auditTable} (${hasId ? "entity_id, " : ""}entity_uuid, action, changed_at, changed_by, version, delta)\n` +
          `          SELECT ${hasId ? `u.${quoteIdent("id")}, ` : ""}u.uuid, 'RESTORE', $1, $2, u.${quoteIdent(versionCol!.sqlName)},\n` +
          `            jsonb_strip_nulls(jsonb_build_object(\n` +
          `              ${deltaExpr}\n` +
          `            ))\n` +
          `          FROM ${table} u\n` +
          `          INNER JOIN ${quoteIdent(tmpOldName)} o ON ${this.bulkJoinPredicate("u", "o", matchCols)}`;
        await client.query(auditSql, [now, actor]);
      }

      if (owned) await client.query("COMMIT");
      this.emitBulkEntityEvents(entity, meta, options, "bulk_restore", matches as Array<Record<string, unknown>>, result.rowCount ?? 0);
      return { received: matches.length, affected: result.rowCount ?? 0 };
    } catch (err) {
      if (owned) await this.bulkAbort(client);
      throw err;
    } finally {
      if (owned) (client as any).release?.();
    }
  }

  /**
   * Bulk update — auditable entity (actor required).
   *
   * @remarks Per-row optimistic concurrency: on auditable entities every row
   * must carry the caller-observed `version`; missing → ERR02 (all-or-nothing),
   * stale/vanished rows → single pg_raise ERR01/ERR03 with ≤10 offenders in
   * DETAIL, rolling back the whole operation.
   */
  async updateMany<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    updates: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult>;
  /** Bulk update — non-auditable entity (actor rejected). */
  async updateMany<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    updates: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult>;
  async updateMany<TEntity extends object>(
    entity: EntityClass,
    updates: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<BulkResult> {
    if (updates.length === 0) return { received: 0, affected: 0 };
    const meta = getEntityPersistenceMeta(entity);
    const table = getQualifiedTableName(entity);
    const matchCols = this.resolveBulkMatchColumns(
      meta,
      updates as Array<Record<string, unknown>>,
      options.matchBy,
      "updateMany",
    );
    const matchProps = new Set(matchCols.map((c) => c.propertyKey));
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    assertWriteActor(meta, actor);

    // Seq-bound columns — same bulk contract as addMany: identical
    // directive on every row or absent on all (absent = column untouched).
    const seqCols = this.seqBoundColumns(meta);
    const seqWrite = seqCols.some((c) =>
      updates.some((u) => (u as Record<string, unknown>)[c.propertyKey] !== undefined),
    );
    if (seqWrite && actor === undefined) {
      throw new ValidationError(
        `updateMany: seq-bound write on ${meta.entityClassName} requires options.actor — the counter claim is audited`,
      );
    }

    // Per-row optimistic concurrency: every row must carry the caller-observed
    // `version` on auditable entities (strict — same contract as update()).
    const versionGuard = this.extractExpectedVersions(
      meta,
      updates as Array<Record<string, unknown>>,
      matchCols[0].propertyKey,
      "updateMany",
    );

    // Determine the update columns from the first row (excluding all identity
    // props and `version`, which is the concurrency guard — never a SET column).
    const first = updates[0] as Record<string, unknown>;
    const versionProp = versionGuard.guard ? findVersionColumn(meta)!.propertyKey : "\0";
    const updateKeys = Object.keys(first).filter(
      (k) => !matchProps.has(k) && k !== versionProp && first[k] !== undefined,
    );

    if (updateKeys.length === 0) {
      throw new ValidationError(`updateMany: no columns to update (only identity props provided?)`);
    }

    for (const k of updateKeys) {
      const sqlName = getColumnName(entity, k);
      if (!meta.columns[sqlName]) {
        throw new UnknownColumnError(`updateMany: unknown column/property ${k}`);
      }
    }

    // Add audit columns for the SET clause
    const auditSetCols: string[] = [];
    if (auditable && actor !== undefined) {
      const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
      const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
      const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);
      if (updatedAtCol) auditSetCols.push(`${quoteIdent(updatedAtCol.sqlName)} = tmp.${quoteIdent(updatedAtCol.sqlName)}`);
      if (updatedByCol) auditSetCols.push(`${quoteIdent(updatedByCol.sqlName)} = tmp.${quoteIdent(updatedByCol.sqlName)}`);
      if (versionCol) auditSetCols.push(`${quoteIdent(versionCol.sqlName)} = ${table}.${quoteIdent(versionCol.sqlName)} + 1`);
    }

    // TEMP TABLE strategy: CREATE TEMP TABLE → batch INSERT → UPDATE FROM → COMMIT
    const { client, deadline, owned } = await this.bulkBegin(options);
    try {
      // Seq-bound update columns resolve inside this transaction — one
      // contiguous claim, literals staged into the temp-table payload.
      if (seqWrite) {
        await this.resolveSeqRows(client, meta, updates as Array<Record<string, unknown>>, actor!, "update");
      }

      // 1. Create temp table — row_ix + all identity columns + update cols.
      //    Column types derive FROM THE REAL TABLE via `AS SELECT … WHERE
      //    false` — runtime meta has no annotation types and a meta-derived
      //    list would silently degrade to `text`.
      const tmpSelCols: string[] = [
        "NULL::bigint AS row_ix",
        ...matchCols.map((c) => quoteIdent(c.sqlName)),
        ...updateKeys.map((k) => quoteIdent(getColumnName(entity, k))),
      ];

      if (auditable && actor !== undefined) {
        const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
        const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
        if (updatedAtCol) tmpSelCols.push(quoteIdent(updatedAtCol.sqlName));
        if (updatedByCol) tmpSelCols.push(quoteIdent(updatedByCol.sqlName));
      }
      if (versionGuard.guard) tmpSelCols.push("NULL::integer AS expected_version");

      const tmpName = `tmp_update_${meta.tableName}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await client.query(
        `CREATE TEMP TABLE ${quoteIdent(tmpName)} ON COMMIT DROP AS ` +
          `SELECT ${tmpSelCols.join(", ")} FROM ${table} WHERE false`,
      );

      // 2. Batch INSERT into temp table
      const now = new Date();
      const allTmpKeys = [...matchCols.map((c) => c.propertyKey), ...updateKeys];
      if (auditable && actor !== undefined) {
        const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
        const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
        if (updatedAtCol) allTmpKeys.push(updatedAtCol.propertyKey);
        if (updatedByCol) allTmpKeys.push(updatedByCol.propertyKey);
      }

      const batchSz = options.batchSize ?? autoBatchSize(allTmpKeys.length + 1 + (versionGuard.guard ? 1 : 0));
      for (let i = 0; i < updates.length; i += batchSz) {
        const batch = updates.slice(i, i + batchSz);
        const values: unknown[] = [];
        const tuples: string[] = [];

        for (const [bi, row] of batch.entries()) {
          const rec = row as Record<string, unknown>;
          const params: string[] = [];
          values.push(i + bi);
          params.push(`$${values.length}`);
          for (const k of allTmpKeys) {
            const sqlName = getColumnName(entity, k);
            const colMeta = meta.columns[sqlName];
            if (matchProps.has(k)) {
              values.push(jsValueToPgParam(rec[k], matchCols.find((c) => c.propertyKey === k)!.hints));
            } else if (auditable && actor !== undefined) {
              const col = Object.values(meta.columns).find((c) => c.propertyKey === k);
              if (col?.auditableType === AuditableFieldType.UPDATED_AT) {
                values.push(now);
              } else if (col?.auditableType === AuditableFieldType.UPDATED_BY) {
                values.push(actor);
              } else {
                const rawVal = rec[k] ?? null;
                const pgVal = colMeta ? jsValueToPgParam(rawVal, columnHintsFromMetaColumn(colMeta)) : rawVal;
                values.push(pgVal);
              }
            } else {
              const rawVal = rec[k] ?? null;
              const pgVal = colMeta ? jsValueToPgParam(rawVal, columnHintsFromMetaColumn(colMeta)) : rawVal;
              values.push(pgVal);
            }
            params.push(`$${values.length}`);
          }
          if (versionGuard.guard) {
            values.push(versionGuard.versions[i + bi]);
            params.push(`$${values.length}`);
          }
          tuples.push(`(${params.join(", ")})`);
        }

        const tmpColsSql = "row_ix, " + allTmpKeys.map((k) => quoteIdent(getColumnName(entity, k))).join(", ")
          + (versionGuard.guard ? `, ${quoteIdent("expected_version")}` : "");
        await client.query(`INSERT INTO ${quoteIdent(tmpName)} (${tmpColsSql}) VALUES ${tuples.join(", ")}`, values);
        this.assertBulkAlive(deadline, "updateMany");
      }

      // 3. Single UPDATE FROM temp table
      const setCols = updateKeys.map((k) => {
        const sqlName = getColumnName(entity, k);
        return `${quoteIdent(sqlName)} = tmp.${quoteIdent(sqlName)}`;
      });
      setCols.push(...auditSetCols);

      // If audit is enabled, capture old records BEFORE the update (same transaction)
      // so we can compute deltas and insert audit records atomically.
      let tmpOldName: string | null = null;
      const auditEnabled = !!(auditable && actor !== undefined && (options as AuditableWriteOptions).audit);

      if (auditEnabled) {
        // Create a temp table snapshot of the rows that will be updated.
        // INNER JOIN with the update temp table for efficient matching.
        tmpOldName = `tmp_old_${meta.tableName}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        await client.query(
          `CREATE TEMP TABLE ${quoteIdent(tmpOldName)} ON COMMIT DROP AS ` +
          `SELECT t.* FROM ${table} t ` +
          `INNER JOIN ${quoteIdent(tmpName)} tmp ` +
          `ON ${this.bulkJoinPredicate("t", "tmp", matchCols)}`,
        );
      }

      // Ambiguity guard — any tmp item matching >1 row raises ERR10, aborting
      // the whole transaction before any write.
      await client.query(this.bulkAmbiguousSql(meta, table, matchCols, tmpName, "updateMany"));

      // No RETURNING — bulk ops return nothing (204 contract); rowCount comes
      // from the command tag.
      // Version guard pre-check (same-tx): stale/vanished/incoherent rows →
      // one pg_raise (ERR01, ERR03 all-vanished, ERR10 incoherent) before any
      // write happens.
      if (versionGuard.guard) {
        await client.query(
          this.bulkStaleDiagnoseSql(meta, table, matchCols, tmpName, versionGuard.versionColSqlName, "updateMany"),
        );
        this.assertBulkAlive(deadline, "updateMany");
      }

      const updateSql =
        `UPDATE ${table} SET ${setCols.join(", ")} FROM ${quoteIdent(tmpName)} tmp ` +
        `WHERE ${this.bulkJoinPredicate(table, "tmp", matchCols)}` +
        (versionGuard.guard ? ` AND ${table}.${quoteIdent(versionGuard.versionColSqlName)} = tmp.expected_version` : "");
      const result = await client.query(updateSql);

      // Race guard — concurrent commit between pre-check and UPDATE.
      if (versionGuard.guard && (result.rowCount ?? 0) < updates.length) {
        throw new OptimisticLockError(
          `updateMany: ${updates.length - (result.rowCount ?? 0)} row(s) changed concurrently during the bulk operation on ${meta.entityClassName} — rolled back.`,
        );
      }

      // 4. Insert audit records atomically (same transaction as the UPDATE).
      // Delta is computed entirely in SQL using jsonb_build_object + jsonb_strip_nulls.
      // No records are fetched into Node.js memory — fully scalable.
      if (auditEnabled && tmpOldName && result.rowCount && result.rowCount > 0) {
        const auditTable = `${quoteIdent(meta.tableSchema)}.${quoteIdent(`${meta.tableName}_audit`)}`;
        const hasId = hasSurrogateId(meta);
        const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);

        // Build the jsonb_build_object(...) argument list dynamically from meta.columns.
        // Exclude audit-only fields that don't change during UPDATE:
        // CREATED_AT, CREATED_BY (AuditableFieldType)
        // DELETED_AT, DELETED_BY (DeletableFieldType)
        // Identified by metadata enums, not by hardcoded column names.
        const deltaColumns = Object.values(meta.columns).filter((c) =>
          c.auditableType !== AuditableFieldType.CREATED_AT &&
          c.auditableType !== AuditableFieldType.CREATED_BY &&
          c.deletableType !== DeletableFieldType.DELETED_AT &&
          c.deletableType !== DeletableFieldType.DELETED_BY,
        );

        const deltaExpr = deltaColumns
          .map((c) => {
            const col = quoteIdent(c.sqlName);
            return `'${c.sqlName}', CASE WHEN o.${col} IS DISTINCT FROM u.${col} THEN jsonb_build_object('old', o.${col}, 'new', u.${col}) END`;
          })
          .join(",\n          ");

        const auditSql =
          `INSERT INTO ${auditTable} (${hasId ? "entity_id, " : ""}entity_uuid, action, changed_at, changed_by, version, delta)\n` +
          `          SELECT ${hasId ? `u.${quoteIdent("id")}, ` : ""}u.uuid, 'UPDATE', $1, $2, u.${quoteIdent(versionCol!.sqlName)},\n` +
          `            jsonb_strip_nulls(jsonb_build_object(\n` +
          `              ${deltaExpr}\n` +
          `            ))\n` +
          `          FROM ${table} u\n` +
          `          INNER JOIN ${quoteIdent(tmpOldName)} o ON ${this.bulkJoinPredicate("u", "o", matchCols)}`;

        await client.query(auditSql, [now, actor]);
      }

      if (owned) await client.query("COMMIT");
      this.emitBulkEntityEvents(entity, meta, options, "bulk_update", updates as Array<Record<string, unknown>>, result.rowCount ?? 0);
      return { received: updates.length, affected: result.rowCount ?? 0 };
    } catch (err) {
      if (owned) await this.bulkAbort(client);
      throw err;
    } finally {
      if (owned) (client as any).release?.();
    }
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  /** Get a PoolClient for transactional operations. */
  private async getClient(): Promise<PoolClient> {
    if (this.poolBound()) {
      return (this.db as Pool).connect();
    }
    // Already a PoolClient — return a no-op release wrapper
    const client = this.db as PoolClient;
    return Object.assign(client, { release: () => {} });
  }
}
