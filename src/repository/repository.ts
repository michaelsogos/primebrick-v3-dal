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
  DeletableFieldType,
} from "../meta/entity-decorators.js";
import {
  columnHintsFromMetaColumn,
  effectivePgStorageType,
  jsValueToPgParam,
} from "../meta/column-pg-io.js";

import type { FieldProjector, FilterExpr, JoinExpr, SortingExpr } from "../query/dsl.js";
import { field, Filter } from "../query/dsl.js";
import { buildSelectQuery, quoteIdent } from "../query/query-builder.js";
import { createStream } from "../query/streaming.js";
import type {
  FindByIdOptions,
  FindOptions,
  FindByUUIDOptions,
  PaginatedEntity,
  WriteOptions,
  AuditableWriteOptions,
  MatchByOptions,
  BulkOptions,
  UpsertOptions,
  AuditPort,
  LoggerPort,
  BulkResult,
} from "../types/types.js";
import { AuditAction } from "../types/types.js";
import { NotFoundError, MultipleRowsError, UnknownColumnError, ValidationError, MissingVersionError, RecordVanishedError, DuplicateRecordError, BulkTimeoutError, OptimisticLockError } from "../errors/errors.js";
import { DalErrorCodes } from "../errors/error-codes.js";
import type { IAuditableEntity, IDeletableEntity, IClonableEntity } from "../types/entities.js";
import { calculateDelta, calculateDeltaWithForcedFields } from "../audit/delta-calculator.js";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

/** Escape a JS string as a single-quoted SQL literal. */
function escapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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

/**
 * Resolve which column to use as the WHERE left operand for write ops.
 * Priority: options.matchBy (property key) → @Key() column → throw.
 */
function resolveMatchColumn(
  entity: EntityClass,
  meta: ReturnType<typeof getEntityPersistenceMeta>,
  matchBy: string | undefined,
): { sqlName: string; propertyKey: string } {
  if (matchBy) {
    const col = Object.values(meta.columns).find((c) => c.propertyKey === matchBy);
    if (!col) {
      throw new UnknownColumnError(
        `matchBy: property '${matchBy}' is not a column of ${meta.entityClassName}`,
      );
    }
    return { sqlName: col.sqlName, propertyKey: col.propertyKey };
  }
  const pk = findPkColumn(meta);
  if (!pk) {
    throw new Error(
      `Entity ${meta.entityClassName} has no @Key() column — specify matchBy to choose the WHERE column`,
    );
  }
  return pk;
}

/**
 * Extract the WHERE value from the updates object and remove it from the SET clause.
 * Used by `update` — the matchBy property serves double duty (WHERE key + not a SET column).
 */
function extractMatchValue(
  updates: Record<string, unknown>,
  matchPropertyKey: string,
): { matchValue: unknown; remainingUpdates: Record<string, unknown> } {
  const matchValue = updates[matchPropertyKey];
  if (matchValue === undefined) {
    throw new ValidationError(
      `write: missing match value — property '${matchPropertyKey}' must be present in the updates/match object`,
    );
  }
  const remainingUpdates = { ...updates };
  delete remainingUpdates[matchPropertyKey];
  return { matchValue, remainingUpdates };
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
  matchColSqlName: string,
  matchParam: unknown,
  entityClassName: string,
  expectedVersion: number,
  versionColSqlName: string,
): Promise<never> {
  const checkSql = `SELECT 1 FROM ${table} WHERE ${quoteIdent(matchColSqlName)} = $1 LIMIT 1`;
  const checkResult = await db.query(checkSql, [matchParam]);
  if (checkResult.rowCount === 0) {
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
function isAuditableEntity(meta: ReturnType<typeof getEntityPersistenceMeta>): boolean {
  return meta.isAuditable === true || Object.values(meta.columns).some((c) => c.isAuditable);
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
function buildReturningClause(
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
    for (const c of Object.values(meta.columns)) {
      const isPk = pk !== null && c.sqlName === pk.sqlName;
      emit(c.sqlName, c.propertyKey, !isPk);
    }
  }
  return { clause: `RETURNING ${projections.join(", ")}`, visibleKeys, rowKeyToSqlName };
}

/** Strip internal bookkeeping keys — the result carries exactly the projected keys. */
function pickReturningRow<TResult>(raw: Record<string, unknown>, visibleKeys: string[]): TResult {
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
    private readonly bulkTimeoutMs: number = 1800000,
  ) {}

  /**
   * Opens a dedicated-client transaction for a bulk operation and applies the
   * operation time budget. Budget is enforced twice: `SET LOCAL
   * statement_timeout` bounds each statement (PG-side kill → 57014), and the
   * returned deadline is checked between statements so the whole op cannot
   * outlive the budget even across many fast statements.
   */
  private async bulkBegin(options: { timeoutMs?: number } | undefined): Promise<{ client: PoolClient; deadline: number | null }> {
    const client = await this.getClient();
    await client.query("BEGIN");
    const budget = options?.timeoutMs ?? this.bulkTimeoutMs;
    let deadline: number | null = null;
    if (budget !== undefined && budget !== null && budget > 0) {
      await client.query(`SET LOCAL statement_timeout TO ${budget}`);
      deadline = Date.now() + budget;
    }
    return { client, deadline };
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
    });
    const r = await this.db.query(q.text, q.values);
    return (r.rows ?? []) as TResult[];
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
        sql = `WITH ins AS (
  ${insertSql}
  ON CONFLICT DO NOTHING
  ${ret.clause}
),
conflict AS (
  SELECT ${uuidSel} AS c_uuid, ${deletedSel} AS c_deleted_at,
         CASE ${constraintCase} END AS c_constraint
  FROM ${table} t
  WHERE ${whereOr}
  LIMIT 1
),
raised AS (
  SELECT public.pg_raise(
    CASE WHEN c.c_deleted_at IS NULL THEN 'ERR04' ELSE 'ERR05' END,
    ${escapeLiteral(`add: unique constraint violation on ${meta.entityClassName}`)},
    jsonb_build_object(
      'entity', ${escapeLiteral(meta.entityClassName)},
      'table', ${escapeLiteral(`${meta.tableSchema}.${meta.tableName}`)},
      'uuid', c.c_uuid::text,
      'constraint', c.c_constraint
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

    // Write audit if port is injected (skipped when the row was a no-op conflict)
    if (inserted && auditable && options.audit && pk && actor !== undefined) {
      const insertedRecord = remapReturningRow(inserted, ret.rowKeyToSqlName);
      const entityId = (insertedRecord[pk.sqlName] ?? inserted[pk.propertyKey]) as bigint;
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
  private uniqueConflictPredicates(
    entity: EntityClass,
    meta: EntityPersistenceMeta,
    attemptedParam: Map<string, string>,
    conflictKeys: string[] | undefined,
  ): { name: string; sql: string }[] {
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

    const predicates: { name: string; sql: string }[] = [];
    for (const g of groups) {
      const refs: string[] = [];
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
        refs.push(`t.${quoteIdent(c.sqlName)} IS NOT DISTINCT FROM ${ref}`);
      }
      if (bindable) predicates.push({ name: g.name, sql: refs.join(" AND ") });
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
        if (!ref) {
          bindable = false;
          break;
        }
        refs.push(`t.${quoteIdent(c.sqlName)} IS NOT DISTINCT FROM ${ref}`);
      }
      if (bindable) predicates.push({ name: g.name, sql: refs.join(" AND "), keys: g.cols.map((c) => c.sqlName) });
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
    matchCol: { sqlName: string },
    tmpName: string,
    versionColSqlName: string,
    op: string,
  ): string {
    const m = quoteIdent(matchCol.sqlName);
    const v = quoteIdent(versionColSqlName);
    return `WITH st AS (
  SELECT tmp.${m} AS s_match, t.${quoteIdent("uuid")} AS s_uuid,
         t.${v} AS s_actual, tmp.expected_version AS s_expected,
         (t.${m} IS NULL) AS s_vanished
  FROM ${quoteIdent(tmpName)} tmp
  LEFT JOIN ${table} t ON t.${m} = tmp.${m}
  WHERE t.${m} IS NULL OR t.${v} IS DISTINCT FROM tmp.expected_version
),
agg AS (SELECT count(*) AS n, bool_and(s_vanished) AS all_vanished FROM st),
det AS (
  SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) AS rows
  FROM (
    SELECT s_uuid AS uuid, s_match AS ${quoteIdent(`input_${matchCol.sqlName}`)},
           s_expected AS expected_version, s_actual AS actual_version,
           s_vanished AS vanished,
           CASE WHEN s_vanished THEN 'ERR03' ELSE 'ERR01' END AS code
    FROM st LIMIT 10
  ) x
)
SELECT public.pg_raise(
  CASE WHEN agg.all_vanished THEN 'ERR03' ELSE 'ERR01' END,
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
  //       const pkCol = findPkColumn(meta);
  //       const entityId = pkCol ? (upserted as any)[pkCol.propertyKey] as bigint : 0n;
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
    const matchCol = resolveMatchColumn(entity, meta, options.matchBy as string | undefined);
    const { matchValue, remainingUpdates } = extractMatchValue(
      updates as Record<string, unknown>,
      matchCol.propertyKey,
    );
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;

    // Optimistic concurrency: extract version from payload for auditable entities
    const versionCol = findVersionColumn(meta);
    const versionExtract = extractVersion(remainingUpdates, versionCol, meta.entityClassName);
    const expectedVersion = versionExtract?.expectedVersion ?? null;
    const finalUpdates = versionExtract?.remainingPayload ?? remainingUpdates;

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
    for (const [key, value] of Object.entries(finalUpdates)) {
      if (value === undefined) continue;
      const sqlName = getColumnName(entity, key);
      const colMeta = meta.columns[sqlName];
      if (!colMeta) {
        throw new UnknownColumnError(`update: unknown column/property ${key}`);
      }
      setClauses.push(`${quoteIdent(sqlName)} = $${values.length + 1}`);
      values.push(jsValueToPgParam(value, columnHintsFromMetaColumn(colMeta)));
      userFieldCount++;
    }

    if (userFieldCount === 0) {
      throw new ValidationError("update: no fields to update");
    }

    const matchColMeta = meta.columns[matchCol.sqlName];
    const matchParamIndex = values.length + 1;
    const matchParam = jsValueToPgParam(matchValue, columnHintsFromMetaColumn(matchColMeta));

    // Fetch old record for audit delta (only if audit port is provided)
    let oldRecord: Record<string, unknown> | null = null;
    if (auditable && options.audit && actor !== undefined) {
      const oldSql = `SELECT * FROM ${table} WHERE ${quoteIdent(matchCol.sqlName)} = $1`;
      const oldResult = await this.db.query(oldSql, [matchParam]);
      oldRecord = (oldResult.rows[0] as Record<string, unknown>) ?? null;
    }

    // Build WHERE clause with optional version guard for optimistic concurrency
    let whereClause = `WHERE ${quoteIdent(matchCol.sqlName)} = $${matchParamIndex}`;
    values.push(matchParam);
    if (expectedVersion !== null && versionCol) {
      const versionParamIndex = values.length + 1;
      values.push(expectedVersion);
      whereClause += ` AND ${quoteIdent(versionCol.sqlName)} = $${versionParamIndex}`;
    }

    const ret = buildReturningClause(entity, options.returning);
    const sql = `UPDATE ${table} SET ${setClauses.join(", ")} ${whereClause} ${ret.clause}`;
    const result = await this.db.query(sql, values);

    if (result.rowCount === 0) {
      if (expectedVersion !== null && versionCol) {
        // Auditable entity with version guard — disambiguate ERR01 (version mismatch) vs ERR03 (row vanished)
        await disambiguateZeroRows(this.db, table, matchCol.sqlName, matchParam, meta.entityClassName, expectedVersion, versionCol.sqlName);
      }
      throw new NotFoundError(`No ${table} found with ${matchCol.sqlName} = ${String(matchValue)}`);
    }

    const updatedRaw = result.rows[0] as Record<string, unknown>;
    const updated = remapReturningRow(updatedRaw, ret.rowKeyToSqlName);

    // Write audit log (fire-and-forget)
    if (auditable && options.audit && actor !== undefined && oldRecord) {
      const pk = findPkColumn(meta);
      const entityId = pk ? (updated[pk.sqlName] ?? oldRecord[pk.sqlName]) as bigint : 0n;
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
    const matchCol = resolveMatchColumn(entity, meta, options.matchBy as string | undefined);
    const { matchValue, remainingUpdates: remainingMatch } = extractMatchValue(match as Record<string, unknown>, matchCol.propertyKey);
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    const isDeletable = Object.values(meta.columns).some((c) => c.isDeletable);
    if (!isDeletable) throw new Error(`Entity ${meta.entityClassName} has no @DeletableField — cannot soft delete`);

    // Optimistic concurrency: extract version from match payload for auditable entities
    const versionCol = findVersionColumn(meta);
    const versionExtract = extractVersion(remainingMatch, versionCol, meta.entityClassName);
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

    const matchColMeta = meta.columns[matchCol.sqlName];
    const matchParamIndex = values.length + 1;
    const matchParam = jsValueToPgParam(matchValue, columnHintsFromMetaColumn(matchColMeta));

    // Fetch old record for audit delta
    let oldRecord: Record<string, unknown> | null = null;
    if (auditable && options.audit && actor !== undefined) {
      const oldSql = `SELECT * FROM ${table} WHERE ${quoteIdent(matchCol.sqlName)} = $1`;
      const oldResult = await this.db.query(oldSql, [matchParam]);
      oldRecord = (oldResult.rows[0] as Record<string, unknown>) ?? null;
    }

    // Build WHERE clause with optional version guard for optimistic concurrency
    let whereClause = `WHERE ${quoteIdent(matchCol.sqlName)} = $${matchParamIndex}`;
    values.push(matchParam);
    if (expectedVersion !== null && versionCol) {
      const versionParamIndex = values.length + 1;
      values.push(expectedVersion);
      whereClause += ` AND ${quoteIdent(versionCol.sqlName)} = $${versionParamIndex}`;
    }

    const ret = buildReturningClause(entity, options.returning);
    const sql = `UPDATE ${table} SET ${setClauses.join(", ")} ${whereClause} ${ret.clause}`;
    const result = await this.db.query(sql, values);

    if (result.rowCount === 0) {
      if (expectedVersion !== null && versionCol) {
        await disambiguateZeroRows(this.db, table, matchCol.sqlName, matchParam, meta.entityClassName, expectedVersion, versionCol.sqlName);
      }
      throw new NotFoundError(`No ${table} found with ${matchCol.sqlName} = ${String(matchValue)}`);
    }

    const deletedRaw = result.rows[0] as Record<string, unknown>;
    const deleted = remapReturningRow(deletedRaw, ret.rowKeyToSqlName);

    // Write audit log (fire-and-forget)
    if (auditable && options.audit && actor !== undefined && oldRecord) {
      const pk = findPkColumn(meta);
      const entityId = pk ? (deleted[pk.sqlName] ?? oldRecord[pk.sqlName]) as bigint : 0n;
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
    const matchCol = resolveMatchColumn(entity, meta, options.matchBy as string | undefined);
    const { matchValue, remainingUpdates: remainingMatch } = extractMatchValue(match as Record<string, unknown>, matchCol.propertyKey);
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    const isDeletable = Object.values(meta.columns).some((c) => c.isDeletable);
    if (!isDeletable) throw new Error(`Entity ${meta.entityClassName} has no @DeletableField — cannot restore`);

    // Optimistic concurrency: extract version from match payload for auditable entities
    const versionCol = findVersionColumn(meta);
    const versionExtract = extractVersion(remainingMatch, versionCol, meta.entityClassName);
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

    const matchColMeta = meta.columns[matchCol.sqlName];
    const matchParamIndex = values.length + 1;
    const matchParam = jsValueToPgParam(matchValue, columnHintsFromMetaColumn(matchColMeta));

    // Fetch old record for audit delta
    let oldRecord: Record<string, unknown> | null = null;
    if (auditable && options.audit && actor !== undefined) {
      const oldSql = `SELECT * FROM ${table} WHERE ${quoteIdent(matchCol.sqlName)} = $1`;
      const oldResult = await this.db.query(oldSql, [matchParam]);
      oldRecord = (oldResult.rows[0] as Record<string, unknown>) ?? null;
    }

    // Build WHERE clause with optional version guard for optimistic concurrency
    let whereClause = `WHERE ${quoteIdent(matchCol.sqlName)} = $${matchParamIndex}`;
    values.push(matchParam);
    if (expectedVersion !== null && versionCol) {
      const versionParamIndex = values.length + 1;
      values.push(expectedVersion);
      whereClause += ` AND ${quoteIdent(versionCol.sqlName)} = $${versionParamIndex}`;
    }

    const ret = buildReturningClause(entity, options.returning);
    const sql = `UPDATE ${table} SET ${setClauses.join(", ")} ${whereClause} ${ret.clause}`;
    const result = await this.db.query(sql, values);

    if (result.rowCount === 0) {
      if (expectedVersion !== null && versionCol) {
        await disambiguateZeroRows(this.db, table, matchCol.sqlName, matchParam, meta.entityClassName, expectedVersion, versionCol.sqlName);
      }
      throw new NotFoundError(`No ${table} found with ${matchCol.sqlName} = ${String(matchValue)}`);
    }

    const restoredRaw = result.rows[0] as Record<string, unknown>;
    const restored = remapReturningRow(restoredRaw, ret.rowKeyToSqlName);

    // Write audit log (fire-and-forget)
    if (auditable && options.audit && actor !== undefined && oldRecord) {
      const pk = findPkColumn(meta);
      const entityId = pk ? (restored[pk.sqlName] ?? oldRecord[pk.sqlName]) as bigint : 0n;
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
    const matchCol = resolveMatchColumn(entity, meta, options.matchBy as string | undefined);
    const { matchValue, remainingUpdates: remainingMatch } = extractMatchValue(match as Record<string, unknown>, matchCol.propertyKey);
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;

    // Optimistic concurrency: extract version from match payload for auditable entities
    const versionCol = findVersionColumn(meta);
    const versionExtract = extractVersion(remainingMatch, versionCol, meta.entityClassName);
    const expectedVersion = versionExtract?.expectedVersion ?? null;

    const matchColMeta = meta.columns[matchCol.sqlName];
    const matchParam = jsValueToPgParam(matchValue, columnHintsFromMetaColumn(matchColMeta));

    // Fetch old record for audit delta before deleting
    let oldRecord: Record<string, unknown> | null = null;
    if (auditable && options.audit && actor !== undefined) {
      const oldSql = `SELECT * FROM ${table} WHERE ${quoteIdent(matchCol.sqlName)} = $1`;
      const oldResult = await this.db.query(oldSql, [matchParam]);
      oldRecord = (oldResult.rows[0] as Record<string, unknown>) ?? null;
    }

    // Build WHERE clause with optional version guard for optimistic concurrency
    const values: unknown[] = [matchParam];
    let whereClause = `WHERE ${quoteIdent(matchCol.sqlName)} = $1`;
    if (expectedVersion !== null && versionCol) {
      values.push(expectedVersion);
      whereClause += ` AND ${quoteIdent(versionCol.sqlName)} = $${values.length}`;
    }

    const ret = buildReturningClause(entity, options.returning);
    const sql = `DELETE FROM ${table} ${whereClause} ${ret.clause}`;
    const result = await this.db.query(sql, values);

    if (result.rowCount === 0) {
      if (expectedVersion !== null && versionCol) {
        await disambiguateZeroRows(this.db, table, matchCol.sqlName, matchParam, meta.entityClassName, expectedVersion, versionCol.sqlName);
      }
      throw new NotFoundError(`No ${table} found with ${matchCol.sqlName} = ${String(matchValue)}`);
    }

    // Write audit log (fire-and-forget) — delta is old=full record, new=empty
    if (auditable && options.audit && actor !== undefined && oldRecord) {
      const pk = findPkColumn(meta);
      const entityId = pk ? oldRecord[pk.sqlName] as bigint : 0n;
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
   * No audit is written (matches BE behavior — clone does not audit).
   */
  async clone<TEntity extends object & IAuditableEntity & IClonableEntity>(
    entity: EntityClass & { new (): TEntity },
    sourceUuid: string,
    options: AuditableWriteOptions,
  ): Promise<TEntity> {
    const meta = getEntityPersistenceMeta(entity);
    const table = getQualifiedTableName(entity);
    const actor = options.actor;

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
    const newUuid = randomUUID();
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

    // Set the clone-tracking field to source UUID
    const cloneField = Object.values(meta.columns).find((c) => c.isClone);
    if (cloneField) {
      clonedRecord[cloneField.sqlName] = sourceUuid;
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

    return pickReturningRow<TEntity>(insertResult.rows[0], ret.visibleKeys);
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

    const first = rows[0] as Record<string, unknown>;
    let keys = Object.keys(first).filter((k) => first[k] !== undefined);

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
    const { client, deadline } = await this.bulkBegin(options);
    try {
      // 1. Temp table mirroring the insert columns
      const tmpName = `tmp_add_${meta.tableName}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const tmpColDefs = allKeys
        .map((k) => {
          const colMeta = Object.values(meta.columns).find((c) => c.propertyKey === k);
          const pgType = colMeta ? effectivePgStorageType(columnHintsFromMetaColumn(colMeta)) : "text";
          return `${quoteIdent(getColumnName(entity, k))} ${pgType}`;
        })
        .join(", ");
      await client.query(`CREATE TEMP TABLE ${quoteIdent(tmpName)} (${tmpColDefs}) ON COMMIT DROP`);

      // 2. Batch INSERT payload into the temp table
      const tmpColsSql = allKeys.map((k) => quoteIdent(getColumnName(entity, k))).join(", ");
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
agg AS (SELECT count(*) AS n, bool_and(c_deleted_at IS NOT NULL) AS all_del FROM conf),
det AS (
  SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) AS rows
  FROM (
    SELECT c_uuid AS uuid, c_input_uuid AS input_uuid,
           CASE WHEN c_deleted_at IS NULL THEN 'ERR04' ELSE 'ERR05' END AS code,
           (c_deleted_at IS NOT NULL) AS deleted, c_constraint AS "constraint",
           c_keys AS keys
    FROM conf LIMIT 10
  ) x
)
SELECT public.pg_raise(
  CASE WHEN agg.all_del THEN 'ERR05' ELSE 'ERR04' END,
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

      await client.query("COMMIT");
      return { received: rows.length, affected };
    } catch (err) {
      await this.bulkAbort(client);
      throw err;
    } finally {
      (client as any).release?.();
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
    const matchCol = resolveMatchColumn(entity, meta, options.matchBy as string | undefined);
    const matchColMeta = meta.columns[matchCol.sqlName];
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    const isDeletable = Object.values(meta.columns).some((c) => c.isDeletable);
    if (!isDeletable) throw new Error(`Entity ${meta.entityClassName} has no @DeletableField — cannot soft delete`);

    // Extract match values from each match object
    const matchValues: unknown[] = matches.map((m) => {
      const v = (m as Record<string, unknown>)[matchCol.propertyKey];
      if (v === undefined) {
        throw new ValidationError(
          `deleteMany: missing match value — property '${matchCol.propertyKey}' must be present in every match object`,
        );
      }
      return jsValueToPgParam(v, columnHintsFromMetaColumn(matchColMeta));
    });

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
      matchCol.propertyKey,
      "deleteMany",
    );

    // TEMP TABLE strategy (same as updateMany): stream match keys into a temp
    // table, then a single UPDATE ... FROM — a JOIN beats ANY($n::[]) and has
    // no parameter-count ceiling (~65535 limit of ANY/IN does not apply).
    //
    // TODO: no optimistic concurrency control — like updateMany, deleteMany
    // does NOT verify `version`. To add it: include `expected_version` in the
    // temp table, add `AND ${table}.version = tmp.expected_version` to the
    // UPDATE WHERE, then diagnose stale rows with a same-transaction SELECT
    // against the temp table (`LEFT JOIN t ON match AND version` → rows with
    // no match are stale/vanished) and roll back all-or-nothing.
    const { client, deadline } = await this.bulkBegin(options as BulkOptions);
    try {
      // 1. Temp table: match column only
      const matchPgType = effectivePgStorageType(columnHintsFromMetaColumn(matchColMeta));
      const tmpName = `tmp_delete_${meta.tableName}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await client.query(
        `CREATE TEMP TABLE ${quoteIdent(tmpName)} (${quoteIdent(matchCol.sqlName)} ${matchPgType}` +
        `${versionGuard.guard ? ", expected_version integer" : ""}) ON COMMIT DROP`,
      );

      // 2. Batch INSERT match keys (+ expected_version) into temp table
      const batchSz = autoBatchSize(versionGuard.guard ? 2 : 1);
      for (let i = 0; i < matchValues.length; i += batchSz) {
        const batch = matchValues.slice(i, i + batchSz);
        const values: unknown[] = [];
        const tuples: string[] = [];
        for (const [bi, v] of batch.entries()) {
          values.push(v);
          const ph = [`$${values.length}`];
          if (versionGuard.guard) {
            values.push(versionGuard.versions[i + bi]);
            ph.push(`$${values.length}`);
          }
          tuples.push(`(${ph.join(", ")})`);
        }
        await client.query(
          `INSERT INTO ${quoteIdent(tmpName)} (${quoteIdent(matchCol.sqlName)}` +
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
          `ON t.${quoteIdent(matchCol.sqlName)} = tmp.${quoteIdent(matchCol.sqlName)}`,
        );
      }

      // No RETURNING — bulk ops return nothing (204 contract); rowCount comes
      // from the command tag.
      // Version guard pre-check: stale/vanished rows → one pg_raise
      // (ERR01, or ERR03 when all vanished), aborting the whole transaction
      // before any write.
      if (versionGuard.guard) {
        await client.query(
          this.bulkStaleDiagnoseSql(meta, table, matchCol, tmpName, versionGuard.versionColSqlName, "deleteMany"),
        );
        this.assertBulkAlive(deadline, "deleteMany");
      }

      const sql =
        `UPDATE ${table} SET ${setClauses.join(", ")} FROM ${quoteIdent(tmpName)} tmp ` +
        `WHERE ${table}.${quoteIdent(matchCol.sqlName)} = tmp.${quoteIdent(matchCol.sqlName)}` +
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
        const pkCol = findPkColumn(meta);
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
          `INSERT INTO ${auditTable} (entity_id, entity_uuid, action, changed_at, changed_by, version, delta)\n` +
          `          SELECT u.${quoteIdent(pkCol!.sqlName)}, u.uuid, 'SOFT_DELETE', $1, $2, u.${quoteIdent(versionCol!.sqlName)},\n` +
          `            jsonb_strip_nulls(jsonb_build_object(\n` +
          `              ${deltaExpr}\n` +
          `            ))\n` +
          `          FROM ${table} u\n` +
          `          INNER JOIN ${quoteIdent(tmpOldName)} o ON u.${quoteIdent(matchCol.sqlName)} = o.${quoteIdent(matchCol.sqlName)}`;
        await client.query(auditSql, [now, actor]);
      }

      await client.query("COMMIT");
      return { received: matches.length, affected: result.rowCount ?? 0 };
    } catch (err) {
      await this.bulkAbort(client);
      throw err;
    } finally {
      (client as any).release?.();
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
    const matchCol = resolveMatchColumn(entity, meta, options.matchBy as string | undefined);
    const matchColMeta = meta.columns[matchCol.sqlName];
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    const isDeletable = Object.values(meta.columns).some((c) => c.isDeletable);
    if (!isDeletable) throw new Error(`Entity ${meta.entityClassName} has no @DeletableField — cannot restore`);

    const matchValues: unknown[] = matches.map((m) => {
      const v = (m as Record<string, unknown>)[matchCol.propertyKey];
      if (v === undefined) {
        throw new ValidationError(
          `restoreMany: missing match value — property '${matchCol.propertyKey}' must be present in every match object`,
        );
      }
      return jsValueToPgParam(v, columnHintsFromMetaColumn(matchColMeta));
    });

    const versionGuard = this.extractExpectedVersions(
      meta,
      matches as Array<Record<string, unknown>>,
      matchCol.propertyKey,
      "restoreMany",
    );

    const now = new Date();
    const deletedAtCol = Object.values(meta.columns).find((c) => c.deletableType === DeletableFieldType.DELETED_AT);
    const deletedByCol = Object.values(meta.columns).find((c) => c.deletableType === DeletableFieldType.DELETED_BY);
    const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
    const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
    const versionCol = findVersionColumn(meta);

    const { client, deadline } = await this.bulkBegin(options);
    try {
      const matchPgType = effectivePgStorageType(columnHintsFromMetaColumn(matchColMeta));
      const tmpName = `tmp_restore_${meta.tableName}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await client.query(
        `CREATE TEMP TABLE ${quoteIdent(tmpName)} (${quoteIdent(matchCol.sqlName)} ${matchPgType}` +
        `${versionGuard.guard ? ", expected_version integer" : ""}) ON COMMIT DROP`,
      );

      const batchSz = autoBatchSize(versionGuard.guard ? 2 : 1);
      for (let i = 0; i < matchValues.length; i += batchSz) {
        const batch = matchValues.slice(i, i + batchSz);
        const values: unknown[] = [];
        const tuples: string[] = [];
        for (const [bi, v] of batch.entries()) {
          values.push(v);
          const ph = [`$${values.length}`];
          if (versionGuard.guard) {
            values.push(versionGuard.versions[i + bi]);
            ph.push(`$${values.length}`);
          }
          tuples.push(`(${ph.join(", ")})`);
        }
        await client.query(
          `INSERT INTO ${quoteIdent(tmpName)} (${quoteIdent(matchCol.sqlName)}` +
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
          `ON t.${quoteIdent(matchCol.sqlName)} = tmp.${quoteIdent(matchCol.sqlName)}`,
        );
      }

      // Version guard pre-check (same-tx) — stale/vanished → one pg_raise.
      if (versionGuard.guard) {
        await client.query(
          this.bulkStaleDiagnoseSql(meta, table, matchCol, tmpName, versionGuard.versionColSqlName, "restoreMany"),
        );
        this.assertBulkAlive(deadline, "restoreMany");
      }

      const sql =
        `UPDATE ${table} SET ${setClauses.join(", ")} FROM ${quoteIdent(tmpName)} tmp ` +
        `WHERE ${table}.${quoteIdent(matchCol.sqlName)} = tmp.${quoteIdent(matchCol.sqlName)}` +
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
        const pkCol = findPkColumn(meta);
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
          `INSERT INTO ${auditTable} (entity_id, entity_uuid, action, changed_at, changed_by, version, delta)\n` +
          `          SELECT u.${quoteIdent(pkCol!.sqlName)}, u.uuid, 'RESTORE', $1, $2, u.${quoteIdent(versionCol!.sqlName)},\n` +
          `            jsonb_strip_nulls(jsonb_build_object(\n` +
          `              ${deltaExpr}\n` +
          `            ))\n` +
          `          FROM ${table} u\n` +
          `          INNER JOIN ${quoteIdent(tmpOldName)} o ON u.${quoteIdent(matchCol.sqlName)} = o.${quoteIdent(matchCol.sqlName)}`;
        await client.query(auditSql, [now, actor]);
      }

      await client.query("COMMIT");
      return { received: matches.length, affected: result.rowCount ?? 0 };
    } catch (err) {
      await this.bulkAbort(client);
      throw err;
    } finally {
      (client as any).release?.();
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
    const matchCol = resolveMatchColumn(entity, meta, options.matchBy as string | undefined);
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;

    // Per-row optimistic concurrency: every row must carry the caller-observed
    // `version` on auditable entities (strict — same contract as update()).
    const versionGuard = this.extractExpectedVersions(
      meta,
      updates as Array<Record<string, unknown>>,
      matchCol.propertyKey,
      "updateMany",
    );

    // Determine the update columns from the first row (excluding the match key
    // and `version`, which is the concurrency guard — never a SET column).
    const first = updates[0] as Record<string, unknown>;
    const versionProp = versionGuard.guard ? findVersionColumn(meta)!.propertyKey : "\0";
    const updateKeys = Object.keys(first).filter(
      (k) => k !== matchCol.propertyKey && k !== versionProp && first[k] !== undefined,
    );

    if (updateKeys.length === 0) {
      throw new ValidationError(`updateMany: no columns to update (only match key '${matchCol.propertyKey}' provided?)`);
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
    const { client, deadline } = await this.bulkBegin(options);
    try {

      // 1. Create temp table — columns must include PG types
      const tmpColDefs: string[] = [];
      const matchColMeta = Object.values(meta.columns).find((c) => c.propertyKey === matchCol.propertyKey);
      const matchPgType = matchColMeta ? effectivePgStorageType(columnHintsFromMetaColumn(matchColMeta)) : "text";
      tmpColDefs.push(`${quoteIdent(matchCol.sqlName)} ${matchPgType}`);

      for (const k of updateKeys) {
        const colMeta = Object.values(meta.columns).find((c) => c.propertyKey === k);
        const pgType = colMeta ? effectivePgStorageType(columnHintsFromMetaColumn(colMeta)) : "text";
        tmpColDefs.push(`${quoteIdent(getColumnName(entity, k))} ${pgType}`);
      }

      if (auditable && actor !== undefined) {
        const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
        const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
        if (updatedAtCol) {
          const pgType = effectivePgStorageType(columnHintsFromMetaColumn(updatedAtCol));
          tmpColDefs.push(`${quoteIdent(updatedAtCol.sqlName)} ${pgType}`);
        }
        if (updatedByCol) {
          const pgType = effectivePgStorageType(columnHintsFromMetaColumn(updatedByCol));
          tmpColDefs.push(`${quoteIdent(updatedByCol.sqlName)} ${pgType}`);
        }
      }
      if (versionGuard.guard) tmpColDefs.push("expected_version integer");

      const tmpName = `tmp_update_${meta.tableName}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      await client.query(`CREATE TEMP TABLE ${quoteIdent(tmpName)} (${tmpColDefs.join(", ")}) ON COMMIT DROP`);

      // 2. Batch INSERT into temp table
      const now = new Date();
      const allTmpKeys = [matchCol.propertyKey, ...updateKeys];
      if (auditable && actor !== undefined) {
        const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
        const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
        if (updatedAtCol) allTmpKeys.push(updatedAtCol.propertyKey);
        if (updatedByCol) allTmpKeys.push(updatedByCol.propertyKey);
      }

      const batchSz = options.batchSize ?? autoBatchSize(allTmpKeys.length + (versionGuard.guard ? 1 : 0));
      for (let i = 0; i < updates.length; i += batchSz) {
        const batch = updates.slice(i, i + batchSz);
        const values: unknown[] = [];
        const tuples: string[] = [];

        for (const [bi, row] of batch.entries()) {
          const rec = row as Record<string, unknown>;
          const params: string[] = [];
          for (const k of allTmpKeys) {
            const sqlName = getColumnName(entity, k);
            const colMeta = meta.columns[sqlName];
            if (k === matchCol.propertyKey) {
              const v = rec[matchCol.propertyKey];
              if (v === undefined) {
                throw new ValidationError(
                  `updateMany: missing match value — property '${matchCol.propertyKey}' must be present in every row`,
                );
              }
              values.push(jsValueToPgParam(v, columnHintsFromMetaColumn(matchColMeta!)));
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

        const tmpColsSql = allTmpKeys.map((k) => quoteIdent(getColumnName(entity, k))).join(", ")
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
          `ON t.${quoteIdent(matchCol.sqlName)} = tmp.${quoteIdent(matchCol.sqlName)}`,
        );
      }

      // No RETURNING — bulk ops return nothing (204 contract); rowCount comes
      // from the command tag.
      // Version guard pre-check (same-tx): stale/vanished rows → one pg_raise
      // (ERR01, or ERR03 when all vanished) before any write happens.
      if (versionGuard.guard) {
        await client.query(
          this.bulkStaleDiagnoseSql(meta, table, matchCol, tmpName, versionGuard.versionColSqlName, "updateMany"),
        );
        this.assertBulkAlive(deadline, "updateMany");
      }

      const updateSql =
        `UPDATE ${table} SET ${setCols.join(", ")} FROM ${quoteIdent(tmpName)} tmp ` +
        `WHERE ${table}.${quoteIdent(matchCol.sqlName)} = tmp.${quoteIdent(matchCol.sqlName)}` +
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
        const pkCol = findPkColumn(meta);
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
          `INSERT INTO ${auditTable} (entity_id, entity_uuid, action, changed_at, changed_by, version, delta)\n` +
          `          SELECT u.${quoteIdent(pkCol!.sqlName)}, u.uuid, 'UPDATE', $1, $2, u.${quoteIdent(versionCol!.sqlName)},\n` +
          `            jsonb_strip_nulls(jsonb_build_object(\n` +
          `              ${deltaExpr}\n` +
          `            ))\n` +
          `          FROM ${table} u\n` +
          `          INNER JOIN ${quoteIdent(tmpOldName)} o ON u.${quoteIdent(matchCol.sqlName)} = o.${quoteIdent(matchCol.sqlName)}`;

        await client.query(auditSql, [now, actor]);
      }

      await client.query("COMMIT");
      return { received: updates.length, affected: result.rowCount ?? 0 };
    } catch (err) {
      await this.bulkAbort(client);
      throw err;
    } finally {
      (client as any).release?.();
    }
  }

  // ─── Raw SQL ───────────────────────────────────────────────────────────────

  async rawSql<TResult = unknown>(text: string, values?: unknown[]): Promise<TResult[]> {
    const r = await this.db.query(text, values ?? []);
    return (r.rows ?? []) as TResult[];
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  /** Get a PoolClient for transactional operations. */
  private async getClient(): Promise<PoolClient> {
    if ("connect" in this.db && typeof (this.db as any).connect === "function") {
      return (this.db as Pool).connect();
    }
    // Already a PoolClient — return a no-op release wrapper
    const client = this.db as PoolClient;
    return Object.assign(client, { release: () => {} });
  }
}
