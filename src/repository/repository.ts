import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";

import type { EntityClass } from "../meta/entity-meta.js";
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
} from "../types/types.js";
import { AuditAction } from "../types/types.js";
import { NotFoundError, MultipleRowsError, UnknownColumnError, ValidationError, MissingVersionError, RecordVanishedError } from "../errors/errors.js";
import type { IAuditableEntity, IDeletableEntity, IClonableEntity } from "../types/entities.js";
import { calculateDelta, calculateDeltaWithForcedFields } from "../audit/delta-calculator.js";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

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

/** Auto-calculate safe batch size to stay under PG's 65535 parameter limit. */
function autoBatchSize(columnCount: number): number {
  if (columnCount <= 0) return 1000;
  return Math.min(1000, Math.floor(65535 / columnCount));
}

export class Repository {
  constructor(private readonly db: Queryable) {}

  // ─── Finders ───────────────────────────────────────────────────────────────

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
  async add<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions,
  ): Promise<TEntity>;
  /** Add — non-auditable entity (actor rejected). */
  async add<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions,
  ): Promise<TEntity>;
  async add<TEntity extends object>(
    entity: EntityClass,
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions | AuditableWriteOptions,
  ): Promise<TEntity> {
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

    for (const k of keys) {
      const sqlName = getColumnName(entity, k);
      const colMeta = meta.columns[sqlName];
      colsSql.push(quoteIdent(sqlName));
      const rawVal = rec[k] ?? null;
      const pgVal = colMeta ? jsValueToPgParam(rawVal, columnHintsFromMetaColumn(colMeta)) : rawVal;
      values.push(pgVal);
      params.push(`$${values.length}`);
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
      }
      if (createdByCol && !keys.includes(createdByCol.propertyKey)) {
        colsSql.push(quoteIdent(createdByCol.sqlName));
        values.push(actor);
        params.push(`$${values.length}`);
      }
      if (updatedAtCol && !keys.includes(updatedAtCol.propertyKey)) {
        colsSql.push(quoteIdent(updatedAtCol.sqlName));
        values.push(now);
        params.push(`$${values.length}`);
      }
      if (updatedByCol && !keys.includes(updatedByCol.propertyKey)) {
        colsSql.push(quoteIdent(updatedByCol.sqlName));
        values.push(actor);
        params.push(`$${values.length}`);
      }
    }

    const sql = `INSERT INTO ${table} (${colsSql.join(", ")}) VALUES (${params.join(", ")}) RETURNING *`;
    const result = await this.db.query(sql, values);
    const inserted = result.rows?.[0] as TEntity;

    // Write audit if port is injected
    if (auditable && options.audit && pk && actor !== undefined) {
      const entityId = (inserted as any)[pk.propertyKey] as bigint;
      const entityUuid = (inserted as any)["uuid"] as string | undefined ?? "";
      const delta = calculateDelta({}, { ...rec, updated_at: now, updated_by: actor });
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

    return inserted;
  }

  /** Upsert — auditable entity (actor required). */
  async upsert<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & UpsertOptions,
  ): Promise<TEntity>;
  /** Upsert — non-auditable entity (actor rejected). */
  async upsert<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & UpsertOptions,
  ): Promise<TEntity>;
  async upsert<TEntity extends object>(
    entity: EntityClass,
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & UpsertOptions,
  ): Promise<TEntity> {
    const meta = getEntityPersistenceMeta(entity);
    const table = getQualifiedTableName(entity);
    const pk = findPkColumn(meta);
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    // Default conflict target: @Key() column's SQL name (was "uuid")
    const conflictTarget = options.conflictTarget ?? pk?.sqlName ?? "uuid";

    const rec = row as Record<string, unknown>;
    let keys = Object.keys(rec).filter((k) => rec[k] !== undefined);

    if (pk && meta.columns[pk.sqlName]?.usePostgresIdentity) {
      keys = keys.filter((k) => k !== pk!.propertyKey);
    }

    // Optimistic concurrency: strip version from INSERT keys for auditable entities.
    // Version is used for the guard (ON CONFLICT path only, per OD4), not for INSERT/SET.
    const versionCol = findVersionColumn(meta);
    let expectedVersion: number | null = null;
    if (versionCol) {
      const versionValue = rec[versionCol.propertyKey];
      if (versionValue !== undefined && versionValue !== null) {
        expectedVersion = Number(versionValue);
      }
      keys = keys.filter((k) => k !== versionCol.propertyKey);
    }

    if (keys.length === 0) {
      throw new ValidationError("upsert: no columns to insert (all undefined?)");
    }

    for (const k of keys) {
      const sqlName = getColumnName(entity, k);
      if (!meta.columns[sqlName]) {
        throw new UnknownColumnError(`upsert: unknown column/property ${k}`);
      }
    }

    const now = new Date();
    const values: unknown[] = [];
    const colsSql: string[] = [];
    const params: string[] = [];

    for (const k of keys) {
      const sqlName = getColumnName(entity, k);
      const colMeta = meta.columns[sqlName];
      colsSql.push(quoteIdent(sqlName));
      const rawVal = rec[k] ?? null;
      const pgVal = colMeta ? jsValueToPgParam(rawVal, columnHintsFromMetaColumn(colMeta)) : rawVal;
      values.push(pgVal);
      params.push(`$${values.length}`);
    }

    // Add audit stamping for INSERT path
    if (auditable && actor !== undefined) {
      const createdAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.CREATED_AT);
      const createdByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.CREATED_BY);
      const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
      const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);

      if (createdAtCol && !keys.includes(createdAtCol.propertyKey)) {
        colsSql.push(quoteIdent(createdAtCol.sqlName));
        values.push(now);
        params.push(`$${values.length}`);
      }
      if (createdByCol && !keys.includes(createdByCol.propertyKey)) {
        colsSql.push(quoteIdent(createdByCol.sqlName));
        values.push(actor);
        params.push(`$${values.length}`);
      }
      if (updatedAtCol && !keys.includes(updatedAtCol.propertyKey)) {
        colsSql.push(quoteIdent(updatedAtCol.sqlName));
        values.push(now);
        params.push(`$${values.length}`);
      }
      if (updatedByCol && !keys.includes(updatedByCol.propertyKey)) {
        colsSql.push(quoteIdent(updatedByCol.sqlName));
        values.push(actor);
        params.push(`$${values.length}`);
      }
    }

    // Build ON CONFLICT DO UPDATE SET — audit-aware
    const updateCols: string[] = [];
    const actorParamIdx = values.length + 1;
    values.push(actor);
    const nowParamIdx = values.length + 1;
    values.push(now);

    for (const k of keys) {
      const sqlName = getColumnName(entity, k);
      // Don't update the conflict target itself, created_at, or created_by on conflict
      const col = meta.columns[sqlName];
      if (sqlName === conflictTarget) continue;
      if (col?.auditableType === AuditableFieldType.CREATED_AT) continue;
      if (col?.auditableType === AuditableFieldType.CREATED_BY) continue;
      updateCols.push(`${quoteIdent(sqlName)} = EXCLUDED.${quoteIdent(sqlName)}`);
    }

    // Add audit stamping for UPDATE path
    if (auditable && actor !== undefined) {
      const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
      const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
      const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);

      if (updatedAtCol) updateCols.push(`${quoteIdent(updatedAtCol.sqlName)} = $${nowParamIdx}`);
      if (updatedByCol) updateCols.push(`${quoteIdent(updatedByCol.sqlName)} = $${actorParamIdx}`);
      if (versionCol) updateCols.push(`${quoteIdent(versionCol.sqlName)} = ${table}.${quoteIdent(versionCol.sqlName)} + 1`);
    }

    const conflictCol = quoteIdent(conflictTarget);
    const sql = `INSERT INTO ${table} (${colsSql.join(", ")}) VALUES (${params.join(", ")}) ON CONFLICT (${conflictCol}) DO UPDATE SET ${updateCols.join(", ")} RETURNING *`;

    // Fetch old record for audit delta AND optimistic concurrency pre-check.
    // Runs for all auditable entities (not just when audit is enabled) because the
    // version guard needs to know if the row exists (ON CONFLICT path) or not (INSERT path).
    let oldRecord: Record<string, unknown> | null = null;
    if (auditable) {
      const conflictPropKey = Object.entries(meta.columns).find(([_, c]) => c.sqlName === conflictTarget)?.[1]?.propertyKey;
      const conflictValue = conflictPropKey ? rec[conflictPropKey] : null;
      if (conflictValue !== null && conflictValue !== undefined) {
        const oldSql = `SELECT * FROM ${table} WHERE ${conflictCol} = $1`;
        const oldResult = await this.db.query(oldSql, [conflictValue]);
        oldRecord = (oldResult.rows[0] as Record<string, unknown>) ?? null;
      }
    }

    // Optimistic concurrency guard — ON CONFLICT path only (row exists), per OD4.
    // INSERT path (row doesn't exist) skips the guard entirely.
    if (oldRecord && versionCol) {
      if (expectedVersion === null) {
        throw new MissingVersionError(
          `Auditable entity upsert with existing row requires a 'version' field; entity ${meta.entityClassName} is auditable but no version was provided.`,
        );
      }
      const dbVersion = Number(oldRecord[versionCol.sqlName]);
      if (dbVersion !== expectedVersion) {
        // PG raises ERR01 — same mechanism as update/delete/restore/hardDelete
        const raiseSql = `DO $$ BEGIN RAISE EXCEPTION 'Optimistic Concurrency Violation' USING ERRCODE = 'ERR01', DETAIL = 'The record exists but the provided version (${expectedVersion}) does not match the current version of ${meta.entityClassName}.'; END $$;`;
        await this.db.query(raiseSql);
      }
    }

    const result = await this.db.query(sql, values);
    const upserted = result.rows?.[0] as TEntity;

    // Write audit log (fire-and-forget) — INSERT if new, UPDATE if conflict
    if (auditable && options.audit && actor !== undefined) {
      const pkCol = findPkColumn(meta);
      const entityId = pkCol ? (upserted as any)[pkCol.propertyKey] as bigint : 0n;
      const entityUuid = (upserted as any)["uuid"] as string | undefined ?? "";
      const newVersion = versionCol ? (upserted as any)[versionCol.propertyKey] as number : 1;
      const action = oldRecord ? AuditAction.UPDATE : AuditAction.INSERT;
      const delta = oldRecord
        ? calculateDeltaWithForcedFields(oldRecord, upserted as Record<string, unknown>, [])
        : calculateDelta({}, upserted as Record<string, unknown>);
      options.audit.writeAudit({
        entityClassName: meta.entityClassName,
        tableName: meta.tableName,
        entityId,
        entityUuid,
        action,
        changedAt: now,
        version: newVersion,
        changedBy: actor,
        delta,
      }).catch((err) => (options.logger ?? noopLogger).error("[DAL Audit Error]", err));
    }

    return upserted;
  }

  /** Update — auditable entity (actor required). */
  async update<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity>;
  /** Update — non-auditable entity (actor rejected). */
  async update<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity>;
  async update<TEntity extends object>(
    entity: EntityClass,
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TEntity> {
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

    const sql = `UPDATE ${table} SET ${setClauses.join(", ")} ${whereClause} RETURNING *`;
    const result = await this.db.query(sql, values);

    if (result.rowCount === 0) {
      if (expectedVersion !== null && versionCol) {
        // Auditable entity with version guard — disambiguate ERR01 (version mismatch) vs ERR03 (row vanished)
        await disambiguateZeroRows(this.db, table, matchCol.sqlName, matchParam, meta.entityClassName, expectedVersion, versionCol.sqlName);
      }
      throw new NotFoundError(`No ${table} found with ${matchCol.sqlName} = ${String(matchValue)}`);
    }

    const updated = result.rows[0] as TEntity;

    // Write audit log (fire-and-forget)
    if (auditable && options.audit && actor !== undefined && oldRecord) {
      const pk = findPkColumn(meta);
      const entityId = pk ? (updated as any)[pk.propertyKey] as bigint : 0n;
      const entityUuid = (updated as any)["uuid"] as string | undefined ?? "";
      const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);
      const newVersion = versionCol ? (updated as any)[versionCol.propertyKey] as number : 1;
      const forcedFields: string[] = [];
      const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
      const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
      if (updatedAtCol) forcedFields.push(updatedAtCol.sqlName);
      if (updatedByCol) forcedFields.push(updatedByCol.sqlName);
      const delta = calculateDeltaWithForcedFields(
        oldRecord,
        updated as Record<string, unknown>,
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

    return updated;
  }
  async delete<TEntity extends object & IAuditableEntity & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity>;
  /** Soft-delete — deletable but non-auditable entity (actor rejected). */
  async delete<TEntity extends object & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity>;
  async delete<TEntity extends object>(
    entity: EntityClass,
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TEntity> {
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

    const sql = `UPDATE ${table} SET ${setClauses.join(", ")} ${whereClause} RETURNING *`;
    const result = await this.db.query(sql, values);

    if (result.rowCount === 0) {
      if (expectedVersion !== null && versionCol) {
        await disambiguateZeroRows(this.db, table, matchCol.sqlName, matchParam, meta.entityClassName, expectedVersion, versionCol.sqlName);
      }
      throw new NotFoundError(`No ${table} found with ${matchCol.sqlName} = ${String(matchValue)}`);
    }

    const deleted = result.rows[0] as TEntity;

    // Write audit log (fire-and-forget)
    if (auditable && options.audit && actor !== undefined && oldRecord) {
      const pk = findPkColumn(meta);
      const entityId = pk ? (deleted as any)[pk.propertyKey] as bigint : 0n;
      const entityUuid = (deleted as any)["uuid"] as string | undefined ?? "";
      const newVersion = versionCol ? (deleted as any)[versionCol.propertyKey] as number : 1;
      const forcedFields: string[] = [];
      if (deletedAtCol) forcedFields.push(deletedAtCol.sqlName);
      if (deletedByCol) forcedFields.push(deletedByCol.sqlName);
      if (updatedAtCol) forcedFields.push(updatedAtCol.sqlName);
      if (updatedByCol) forcedFields.push(updatedByCol.sqlName);
      const delta = calculateDeltaWithForcedFields(
        oldRecord,
        deleted as Record<string, unknown>,
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

    return deleted;
  }

  /** Restore — auditable+deletable entity (actor required). */
  async restore<TEntity extends object & IAuditableEntity & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity>;
  /** Restore — deletable but non-auditable entity (actor rejected). */
  async restore<TEntity extends object & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity>;
  async restore<TEntity extends object>(
    entity: EntityClass,
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TEntity> {
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

    const sql = `UPDATE ${table} SET ${setClauses.join(", ")} ${whereClause} RETURNING *`;
    const result = await this.db.query(sql, values);

    if (result.rowCount === 0) {
      if (expectedVersion !== null && versionCol) {
        await disambiguateZeroRows(this.db, table, matchCol.sqlName, matchParam, meta.entityClassName, expectedVersion, versionCol.sqlName);
      }
      throw new NotFoundError(`No ${table} found with ${matchCol.sqlName} = ${String(matchValue)}`);
    }

    const restored = result.rows[0] as TEntity;

    // Write audit log (fire-and-forget)
    if (auditable && options.audit && actor !== undefined && oldRecord) {
      const pk = findPkColumn(meta);
      const entityId = pk ? (restored as any)[pk.propertyKey] as bigint : 0n;
      const entityUuid = (restored as any)["uuid"] as string | undefined ?? "";
      const newVersion = versionCol ? (restored as any)[versionCol.propertyKey] as number : 1;
      const forcedFields: string[] = [];
      if (deletedAtCol) forcedFields.push(deletedAtCol.sqlName);
      if (deletedByCol) forcedFields.push(deletedByCol.sqlName);
      if (updatedAtCol) forcedFields.push(updatedAtCol.sqlName);
      if (updatedByCol) forcedFields.push(updatedByCol.sqlName);
      const delta = calculateDeltaWithForcedFields(
        oldRecord,
        restored as Record<string, unknown>,
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

    return restored;
  }

  /** Hard-delete — auditable entity (actor required for audit log). */
  async hardDelete<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<void>;
  /** Hard-delete — non-auditable entity (actor rejected). */
  async hardDelete<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<void>;
  async hardDelete<TEntity extends object>(
    entity: EntityClass,
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<void> {
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

    const sql = `DELETE FROM ${table} ${whereClause}`;
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

    const insertSql = `INSERT INTO ${table} (${columnNames}) VALUES (${placeholders}) RETURNING *`;
    const insertResult = await this.db.query(insertSql, values);

    if (insertResult.rowCount === 0) {
      throw new Error(`Failed to clone record for ${meta.tableName}`);
    }

    return insertResult.rows[0] as TEntity;
  }

  // ─── Bulk ops ──────────────────────────────────────────────────────────────

  /** Bulk add — auditable entity (actor required). */
  async addMany<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & BulkOptions,
  ): Promise<TEntity[]>;
  /** Bulk add — non-auditable entity (actor rejected). */
  async addMany<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & BulkOptions,
  ): Promise<TEntity[]>;
  async addMany<TEntity extends object>(
    entity: EntityClass,
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & BulkOptions,
  ): Promise<TEntity[]> {
    if (rows.length === 0) return [];
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
    const results: TEntity[] = [];

    // When timeoutMs is provided, wrap batched INSERTs in a transaction with
    // SET LOCAL statement_timeout (transaction-scoped, no leakage).
    const useTx = options.timeoutMs !== undefined;
    const client = useTx ? await this.getClient() : null;
    try {
      if (useTx && client) {
        await client.query("BEGIN");
        await client.query(`SET LOCAL statement_timeout TO ${options.timeoutMs}`);
      }
      const db = useTx && client ? client : this.db;

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

        const sql = `INSERT INTO ${table} (${colsSql}) VALUES ${tuples.join(", ")} RETURNING *`;
        const result = await db.query(sql, values);
        results.push(...(result.rows as TEntity[]));
      }

      if (useTx && client) {
        await client.query("COMMIT");
      }
    } catch (err) {
      if (useTx && client) {
        await client.query("ROLLBACK").catch(() => {});
      }
      throw err;
    } finally {
      if (useTx && client) {
        (client as any).release?.();
      }
    }

    return results;
  }

  /** Bulk upsert — auditable entity (actor required). */
  async upsertMany<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & BulkOptions & UpsertOptions,
  ): Promise<TEntity[]>;
  /** Bulk upsert — non-auditable entity (actor rejected). */
  async upsertMany<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & BulkOptions & UpsertOptions,
  ): Promise<TEntity[]>;
  async upsertMany<TEntity extends object>(
    entity: EntityClass,
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & BulkOptions & UpsertOptions
  ): Promise<TEntity[]> {
    if (rows.length === 0) return [];
    const meta = getEntityPersistenceMeta(entity);
    const table = getQualifiedTableName(entity);
    const pk = findPkColumn(meta);
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;
    const conflictTarget = options.conflictTarget ?? pk?.sqlName ?? "uuid";

    // Find the conflict target's property key and check if it's a uuid column
    const conflictColMeta = Object.values(meta.columns).find((c) => c.sqlName === conflictTarget);
    const conflictPropKey = conflictColMeta?.propertyKey ?? conflictTarget;
    const conflictIsUuid = conflictColMeta
      ? effectivePgStorageType(columnHintsFromMetaColumn(conflictColMeta)) === "uuid"
      : conflictTarget === "uuid";

    const first = rows[0] as Record<string, unknown>;
    let keys = Object.keys(first).filter((k) => first[k] !== undefined);

    if (pk && meta.columns[pk.sqlName]?.usePostgresIdentity) {
      keys = keys.filter((k) => k !== pk!.propertyKey);
    }

    if (keys.length === 0) {
      throw new ValidationError("upsertMany: no columns to insert (all undefined?)");
    }

    for (const k of keys) {
      const sqlName = getColumnName(entity, k);
      if (!meta.columns[sqlName]) {
        throw new UnknownColumnError(`upsertMany: unknown column/property ${k}`);
      }
    }

    // Add audit columns for INSERT path
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

    // Build ON CONFLICT DO UPDATE SET — audit-aware
    const updateCols: string[] = [];
    for (const k of keys) {
      const sqlName = getColumnName(entity, k);
      const col = meta.columns[sqlName];
      if (sqlName === conflictTarget) continue;
      if (col?.auditableType === AuditableFieldType.CREATED_AT) continue;
      if (col?.auditableType === AuditableFieldType.CREATED_BY) continue;
      updateCols.push(`${quoteIdent(sqlName)} = EXCLUDED.${quoteIdent(sqlName)}`);
    }

    // Add audit stamping for UPDATE path
    if (auditable && actor !== undefined) {
      const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
      const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
      const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);

      if (updatedAtCol) updateCols.push(`${quoteIdent(updatedAtCol.sqlName)} = EXCLUDED.${quoteIdent(updatedAtCol.sqlName)}`);
      if (updatedByCol) updateCols.push(`${quoteIdent(updatedByCol.sqlName)} = EXCLUDED.${quoteIdent(updatedByCol.sqlName)}`);
      if (versionCol) updateCols.push(`${quoteIdent(versionCol.sqlName)} = ${table}.${quoteIdent(versionCol.sqlName)} + 1`);
    }

    const now = new Date();
    const batchSz = options.batchSize ?? autoBatchSize(allKeys.length);
    const results: TEntity[] = [];

    // When timeoutMs is provided, wrap batched upserts in a transaction with
    // SET LOCAL statement_timeout (transaction-scoped, no leakage).
    const useTx = options.timeoutMs !== undefined;
    const client = useTx ? await this.getClient() : null;
    try {
      if (useTx && client) {
        await client.query("BEGIN");
        await client.query(`SET LOCAL statement_timeout TO ${options.timeoutMs}`);
      }
      const db = useTx && client ? client : this.db;

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
            // For uuid conflict target, use COALESCE so missing uuids get generated
            if (k === conflictPropKey && conflictIsUuid) {
              params.push(`COALESCE($${values.length}, gen_random_uuid())`);
            } else {
              params.push(`$${values.length}`);
            }
          }
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

        const sql = `INSERT INTO ${table} (${colsSql}) VALUES ${tuples.join(", ")} ON CONFLICT (${quoteIdent(conflictTarget)}) DO UPDATE SET ${updateCols.join(", ")} RETURNING *`;
        const result = await db.query(sql, values);
        results.push(...(result.rows as TEntity[]));
      }

      if (useTx && client) {
        await client.query("COMMIT");
      }
    } catch (err) {
      if (useTx && client) {
        await client.query("ROLLBACK").catch(() => {});
      }
      throw err;
    } finally {
      if (useTx && client) {
        (client as any).release?.();
      }
    }

    return results;
  }

  /** Bulk soft-delete — auditable+deletable entity (actor required). */
  async deleteMany<TEntity extends object & IAuditableEntity & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity[]>;
  /** Bulk soft-delete — deletable but non-auditable entity (actor rejected). */
  async deleteMany<TEntity extends object & IDeletableEntity>(
    entity: EntityClass & { new (): TEntity },
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Promise<TEntity[]>;
  async deleteMany<TEntity extends object>(
    entity: EntityClass,
    matches: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Promise<TEntity[]> {
    if (matches.length === 0) return [];
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
    const setClauses: string[] = [];
    const values: unknown[] = [];

    const deletedAtCol = Object.values(meta.columns).find((c) => c.deletableType === DeletableFieldType.DELETED_AT);
    const deletedByCol = Object.values(meta.columns).find((c) => c.deletableType === DeletableFieldType.DELETED_BY);
    const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
    const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
    const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);

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

    const pgType = effectivePgStorageType(columnHintsFromMetaColumn(matchColMeta));
    values.push(matchValues);
    const sql = `UPDATE ${table} SET ${setClauses.join(", ")} WHERE ${quoteIdent(matchCol.sqlName)} = ANY($${values.length}::${pgType}[]) RETURNING *`;
    const result = await this.db.query(sql, values);
    return result.rows as TEntity[];
  }

  /** Bulk update — auditable entity (actor required). */
  async updateMany<TEntity extends object & IAuditableEntity>(
    entity: EntityClass & { new (): TEntity },
    updates: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<TEntity[]>;
  /** Bulk update — non-auditable entity (actor rejected). */
  async updateMany<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    updates: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<TEntity[]>;
  async updateMany<TEntity extends object>(
    entity: EntityClass,
    updates: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity> & BulkOptions,
  ): Promise<TEntity[]> {
    if (updates.length === 0) return [];
    const meta = getEntityPersistenceMeta(entity);
    const table = getQualifiedTableName(entity);
    const matchCol = resolveMatchColumn(entity, meta, options.matchBy as string | undefined);
    const auditable = isAuditableEntity(meta);
    const actor = (options as AuditableWriteOptions).actor;

    // Determine the update columns from the first row (excluding the match key)
    const first = updates[0] as Record<string, unknown>;
    const updateKeys = Object.keys(first).filter((k) => k !== matchCol.propertyKey && first[k] !== undefined);

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
    const client = await this.getClient();
    try {
      await client.query("BEGIN");
      if (options.timeoutMs !== undefined) {
        await client.query(`SET LOCAL statement_timeout TO ${options.timeoutMs}`);
      }

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

      const batchSz = options.batchSize ?? autoBatchSize(allTmpKeys.length);
      for (let i = 0; i < updates.length; i += batchSz) {
        const batch = updates.slice(i, i + batchSz);
        const values: unknown[] = [];
        const tuples: string[] = [];

        for (const row of batch) {
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
          tuples.push(`(${params.join(", ")})`);
        }

        const tmpColsSql = allTmpKeys.map((k) => quoteIdent(getColumnName(entity, k))).join(", ");
        await client.query(`INSERT INTO ${quoteIdent(tmpName)} (${tmpColsSql}) VALUES ${tuples.join(", ")}`, values);
      }

      // 3. Single UPDATE FROM temp table
      const setCols = updateKeys.map((k) => {
        const sqlName = getColumnName(entity, k);
        return `${quoteIdent(sqlName)} = tmp.${quoteIdent(sqlName)}`;
      });
      setCols.push(...auditSetCols);

      const updateSql = `UPDATE ${table} SET ${setCols.join(", ")} FROM ${quoteIdent(tmpName)} tmp WHERE ${table}.${quoteIdent(matchCol.sqlName)} = tmp.${quoteIdent(matchCol.sqlName)} RETURNING *`;
      const result = await client.query(updateSql);

      await client.query("COMMIT");
      return result.rows as TEntity[];
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
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
