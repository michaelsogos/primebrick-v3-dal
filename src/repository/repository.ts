import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";

import type { EntityClass } from "../meta/entity-meta.js";
import {
  getColumnName,
  getEntityPersistenceMeta,
  getTableName,
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
  BulkOptions,
  AuditPort,
  LoggerPort,
} from "../types/types.js";
import { AuditAction } from "../types/types.js";
import { NotFoundError, MultipleRowsError, UnknownColumnError, ValidationError } from "../errors/errors.js";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

/** No-op logger — used when no LoggerPort is injected. */
const noopLogger: LoggerPort = {
  error() {},
  warn() {},
  info() {},
};

/** Calculate delta between old and new records for audit. */
function calculateDelta(
  oldEntity: Record<string, unknown>,
  newEntity: Record<string, unknown>
): Record<string, { old: unknown; new: unknown }> {
  const delta: Record<string, { old: unknown; new: unknown }> = {};
  for (const key in newEntity) {
    if (JSON.stringify(oldEntity[key]) !== JSON.stringify(newEntity[key])) {
      delta[key] = { old: oldEntity[key], new: newEntity[key] };
    }
  }
  return delta;
}

/** Calculate delta and force include specific fields even when unchanged. */
function calculateDeltaWithForcedFields(
  oldEntity: Record<string, unknown>,
  newEntity: Record<string, unknown>,
  forceFields: string[]
): Record<string, { old: unknown; new: unknown }> {
  const delta = calculateDelta(oldEntity, newEntity);
  for (const key of forceFields) {
    if (!(key in delta) && key in newEntity) {
      delta[key] = { old: oldEntity[key] ?? null, new: newEntity[key] };
    }
  }
  return delta;
}

/** Find the uuid column from entity metadata. */
function findUuidColumn(meta: ReturnType<typeof getEntityPersistenceMeta>): {
  sqlName: string;
  propertyKey: string;
} | null {
  const col = Object.values(meta.columns).find((c) => c.sqlName === "uuid" || c.isUnique);
  if (!col) return null;
  return { sqlName: col.sqlName, propertyKey: col.propertyKey };
}

/** Find the PK column from entity metadata. */
function findPkColumn(meta: ReturnType<typeof getEntityPersistenceMeta>): {
  sqlName: string;
  propertyKey: string;
} | null {
  const col = Object.values(meta.columns).find((c) => c.isKey);
  if (!col) return null;
  return { sqlName: col.sqlName, propertyKey: col.propertyKey };
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
    id: number | string,
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
    const uuidCol = findUuidColumn(meta);
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
    const throwIfNotFound = (options as any)?.throwIfNotFound ?? true;
    const meta = getEntityPersistenceMeta(entity);

    const q = buildSelectQuery({
      entity,
      fields: fields ?? undefined,
      joins: options?.joins,
      filters: options?.filters,
      sorting: options?.sorting,
      deletedRecords: options?.deletedRecords,
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
      limit,
      offset,
      includeTotalRecordsWindow: true,
    });
    const r = await this.db.query(q.text, q.values);

    const rows = (r.rows ?? []) as Array<TResult & { _total_records?: number | string | null }>;
    const totalRaw = rows[0]?._total_records ?? 0;
    const total_records = typeof totalRaw === "string" ? Number(totalRaw) : Number(totalRaw ?? 0);

    const entities = rows.map((x) => {
      const { _total_records, ...rest } = x as any;
      return rest as TResult;
    });

    return { entities, total_records };
  }

  async count(entity: EntityClass): Promise<number> {
    const table = getTableName(entity);
    const r = await this.db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "${table}"`, []);
    return Number(r.rows?.[0]?.n ?? 0);
  }

  // ─── Write ops ─────────────────────────────────────────────────────────────

  async add<TEntity extends object>(
    entity: EntityClass,
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions
  ): Promise<TEntity> {
    const meta = getEntityPersistenceMeta(entity);
    const table = getTableName(entity);
    const pk = findPkColumn(meta);
    const isAuditable = meta.isAuditable || Object.values(meta.columns).some((c) => c.isAuditable);

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
    if (isAuditable) {
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
        values.push(options.actor);
        params.push(`$${values.length}`);
      }
      if (updatedAtCol && !keys.includes(updatedAtCol.propertyKey)) {
        colsSql.push(quoteIdent(updatedAtCol.sqlName));
        values.push(now);
        params.push(`$${values.length}`);
      }
      if (updatedByCol && !keys.includes(updatedByCol.propertyKey)) {
        colsSql.push(quoteIdent(updatedByCol.sqlName));
        values.push(options.actor);
        params.push(`$${values.length}`);
      }
    }

    const sql = `INSERT INTO ${quoteIdent(table)} (${colsSql.join(", ")}) VALUES (${params.join(", ")}) RETURNING *`;
    const result = await this.db.query(sql, values);
    const inserted = result.rows?.[0] as TEntity;

    // Write audit if port is injected
    if (isAuditable && options.audit && pk) {
      const entityId = (inserted as any)[pk.propertyKey] as number;
      const uuidCol = findUuidColumn(meta);
      const entityUuid = uuidCol ? (inserted as any)[uuidCol.propertyKey] as string : "";
      const delta = calculateDelta({}, { ...rec, updated_at: now, updated_by: options.actor });
      options.audit.writeAudit({
        entityClassName: meta.entityClassName,
        tableName: meta.tableName,
        entityId,
        entityUuid,
        action: AuditAction.INSERT,
        changedAt: now,
        version: 1,
        changedBy: options.actor,
        delta,
      }).catch((err) => (options.logger ?? noopLogger).error("[DAL Audit Error]", err));
    }

    return inserted;
  }

  async upsert<TEntity extends object>(
    entity: EntityClass,
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & { conflictTarget?: string }
  ): Promise<TEntity> {
    const meta = getEntityPersistenceMeta(entity);
    const table = getTableName(entity);
    const pk = findPkColumn(meta);
    const isAuditable = meta.isAuditable || Object.values(meta.columns).some((c) => c.isAuditable);
    const conflictTarget = options.conflictTarget ?? "uuid";

    const rec = row as Record<string, unknown>;
    let keys = Object.keys(rec).filter((k) => rec[k] !== undefined);

    if (pk && meta.columns[pk.sqlName]?.usePostgresIdentity) {
      keys = keys.filter((k) => k !== pk!.propertyKey);
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
    if (isAuditable) {
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
        values.push(options.actor);
        params.push(`$${values.length}`);
      }
      if (updatedAtCol && !keys.includes(updatedAtCol.propertyKey)) {
        colsSql.push(quoteIdent(updatedAtCol.sqlName));
        values.push(now);
        params.push(`$${values.length}`);
      }
      if (updatedByCol && !keys.includes(updatedByCol.propertyKey)) {
        colsSql.push(quoteIdent(updatedByCol.sqlName));
        values.push(options.actor);
        params.push(`$${values.length}`);
      }
    }

    // Build ON CONFLICT DO UPDATE SET — audit-aware
    const updateCols: string[] = [];
    const actorParamIdx = values.length + 1;
    values.push(options.actor);
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
    if (isAuditable) {
      const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
      const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
      const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);

      if (updatedAtCol) updateCols.push(`${quoteIdent(updatedAtCol.sqlName)} = $${nowParamIdx}`);
      if (updatedByCol) updateCols.push(`${quoteIdent(updatedByCol.sqlName)} = $${actorParamIdx}`);
      if (versionCol) updateCols.push(`${quoteIdent(versionCol.sqlName)} = ${quoteIdent(table)}.${quoteIdent(versionCol.sqlName)} + 1`);
    }

    const conflictCol = quoteIdent(conflictTarget);
    const sql = `INSERT INTO ${quoteIdent(table)} (${colsSql.join(", ")}) VALUES (${params.join(", ")}) ON CONFLICT (${conflictCol}) DO UPDATE SET ${updateCols.join(", ")} RETURNING *`;

    const result = await this.db.query(sql, values);
    return result.rows?.[0] as TEntity;
  }

  async update<TEntity extends object>(
    entity: EntityClass,
    uuid: string,
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions
  ): Promise<TEntity> {
    const meta = getEntityPersistenceMeta(entity);
    const table = getTableName(entity);
    const pk = findPkColumn(meta);
    const uuidCol = findUuidColumn(meta);
    if (!uuidCol) throw new Error(`Entity ${meta.entityClassName} has no uuid column`);
    const isAuditable = meta.isAuditable || Object.values(meta.columns).some((c) => c.isAuditable);

    const updateRec = updates as Record<string, unknown>;
    const setClauses: string[] = [];
    const values: unknown[] = [];
    const now = new Date();

    // Add audit stamping
    if (isAuditable) {
      const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
      const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
      const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);

      if (updatedAtCol) {
        setClauses.push(`${quoteIdent(updatedAtCol.sqlName)} = $${values.length + 1}`);
        values.push(now);
      }
      if (updatedByCol) {
        setClauses.push(`${quoteIdent(updatedByCol.sqlName)} = $${values.length + 1}`);
        values.push(options.actor);
      }
      if (versionCol) {
        setClauses.push(`${quoteIdent(versionCol.sqlName)} = ${quoteIdent(versionCol.sqlName)} + 1`);
      }
    }

    // Add user-provided updates
    let userFieldCount = 0;
    for (const [key, value] of Object.entries(updateRec)) {
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

    const sql = `UPDATE ${quoteIdent(table)} SET ${setClauses.join(", ")} WHERE ${quoteIdent(uuidCol.sqlName)} = $${values.length + 1} RETURNING *`;
    values.push(uuid);
    const result = await this.db.query(sql, values);

    if (result.rowCount === 0) {
      throw new NotFoundError(`No ${table} found with uuid ${uuid}`);
    }

    return result.rows[0] as TEntity;
  }

  async delete<TEntity extends object>(
    entity: EntityClass,
    uuid: string,
    options: WriteOptions
  ): Promise<TEntity> {
    const meta = getEntityPersistenceMeta(entity);
    const table = getTableName(entity);
    const uuidCol = findUuidColumn(meta);
    if (!uuidCol) throw new Error(`Entity ${meta.entityClassName} has no uuid column`);
    const isAuditable = meta.isAuditable || Object.values(meta.columns).some((c) => c.isAuditable);
    const isDeletable = Object.values(meta.columns).some((c) => c.isDeletable);
    if (!isDeletable) throw new Error(`Entity ${meta.entityClassName} has no @DeletableField — cannot soft delete`);

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
    if (deletedByCol) {
      setClauses.push(`${quoteIdent(deletedByCol.sqlName)} = $${values.length + 1}`);
      values.push(options.actor);
    }
    if (updatedAtCol) {
      setClauses.push(`${quoteIdent(updatedAtCol.sqlName)} = $${values.length + 1}`);
      values.push(now);
    }
    if (updatedByCol) {
      setClauses.push(`${quoteIdent(updatedByCol.sqlName)} = $${values.length + 1}`);
      values.push(options.actor);
    }
    if (versionCol) {
      setClauses.push(`${quoteIdent(versionCol.sqlName)} = ${quoteIdent(versionCol.sqlName)} + 1`);
    }

    const sql = `UPDATE ${quoteIdent(table)} SET ${setClauses.join(", ")} WHERE ${quoteIdent(uuidCol.sqlName)} = $${values.length + 1} RETURNING *`;
    values.push(uuid);
    const result = await this.db.query(sql, values);

    if (result.rowCount === 0) {
      throw new NotFoundError(`No ${table} found with uuid ${uuid}`);
    }

    return result.rows[0] as TEntity;
  }

  async restore<TEntity extends object>(
    entity: EntityClass,
    uuid: string,
    options: WriteOptions
  ): Promise<TEntity> {
    const meta = getEntityPersistenceMeta(entity);
    const table = getTableName(entity);
    const uuidCol = findUuidColumn(meta);
    if (!uuidCol) throw new Error(`Entity ${meta.entityClassName} has no uuid column`);
    const isDeletable = Object.values(meta.columns).some((c) => c.isDeletable);
    if (!isDeletable) throw new Error(`Entity ${meta.entityClassName} has no @DeletableField — cannot restore`);

    const now = new Date();
    const setClauses: string[] = [];
    const values: unknown[] = [];

    const deletedAtCol = Object.values(meta.columns).find((c) => c.deletableType === DeletableFieldType.DELETED_AT);
    const deletedByCol = Object.values(meta.columns).find((c) => c.deletableType === DeletableFieldType.DELETED_BY);
    const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
    const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
    const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);

    if (deletedAtCol) {
      setClauses.push(`${quoteIdent(deletedAtCol.sqlName)} = NULL`);
    }
    if (deletedByCol) {
      setClauses.push(`${quoteIdent(deletedByCol.sqlName)} = NULL`);
    }
    if (updatedAtCol) {
      setClauses.push(`${quoteIdent(updatedAtCol.sqlName)} = $${values.length + 1}`);
      values.push(now);
    }
    if (updatedByCol) {
      setClauses.push(`${quoteIdent(updatedByCol.sqlName)} = $${values.length + 1}`);
      values.push(options.actor);
    }
    if (versionCol) {
      setClauses.push(`${quoteIdent(versionCol.sqlName)} = ${quoteIdent(versionCol.sqlName)} + 1`);
    }

    const sql = `UPDATE ${quoteIdent(table)} SET ${setClauses.join(", ")} WHERE ${quoteIdent(uuidCol.sqlName)} = $${values.length + 1} RETURNING *`;
    values.push(uuid);
    const result = await this.db.query(sql, values);

    if (result.rowCount === 0) {
      throw new NotFoundError(`No ${table} found with uuid ${uuid}`);
    }

    return result.rows[0] as TEntity;
  }

  async hardDelete<TEntity extends object>(
    entity: EntityClass,
    uuid: string,
    options: WriteOptions
  ): Promise<void> {
    const meta = getEntityPersistenceMeta(entity);
    const table = getTableName(entity);
    const uuidCol = findUuidColumn(meta);
    if (!uuidCol) throw new Error(`Entity ${meta.entityClassName} has no uuid column`);

    const sql = `DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(uuidCol.sqlName)} = $1`;
    const result = await this.db.query(sql, [uuid]);

    if (result.rowCount === 0) {
      throw new NotFoundError(`No ${table} found with uuid ${uuid}`);
    }
  }

  // ─── Bulk ops ──────────────────────────────────────────────────────────────

  async addMany<TEntity extends object>(
    entity: EntityClass,
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & { batchSize?: number }
  ): Promise<TEntity[]> {
    if (rows.length === 0) return [];
    const meta = getEntityPersistenceMeta(entity);
    const table = getTableName(entity);
    const pk = findPkColumn(meta);
    const isAuditable = meta.isAuditable || Object.values(meta.columns).some((c) => c.isAuditable);

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
    if (isAuditable) {
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
            values.push(options.actor);
          } else if (col.auditableType === AuditableFieldType.VERSION) {
            values.push(1);
          } else {
            values.push(null);
          }
          params.push(`$${values.length}`);
        }
        tuples.push(`(${params.join(", ")})`);
      }

      const sql = `INSERT INTO ${quoteIdent(table)} (${colsSql}) VALUES ${tuples.join(", ")} RETURNING *`;
      const result = await this.db.query(sql, values);
      results.push(...(result.rows as TEntity[]));
    }

    return results;
  }

  async upsertMany<TEntity extends object>(
    entity: EntityClass,
    rows: Array<Partial<Record<keyof TEntity & string, unknown>>>,
    options: BulkOptions
  ): Promise<TEntity[]> {
    if (rows.length === 0) return [];
    const meta = getEntityPersistenceMeta(entity);
    const table = getTableName(entity);
    const pk = findPkColumn(meta);
    const isAuditable = meta.isAuditable || Object.values(meta.columns).some((c) => c.isAuditable);
    const conflictTarget = options.conflictTarget ?? "uuid";

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
    if (isAuditable) {
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
    if (isAuditable) {
      const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
      const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
      const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);

      if (updatedAtCol) updateCols.push(`${quoteIdent(updatedAtCol.sqlName)} = EXCLUDED.${quoteIdent(updatedAtCol.sqlName)}`);
      if (updatedByCol) updateCols.push(`${quoteIdent(updatedByCol.sqlName)} = EXCLUDED.${quoteIdent(updatedByCol.sqlName)}`);
      if (versionCol) updateCols.push(`${quoteIdent(versionCol.sqlName)} = ${quoteIdent(table)}.${quoteIdent(versionCol.sqlName)} + 1`);
    }

    const now = new Date();
    const batchSz = options.batchSize ?? autoBatchSize(allKeys.length);
    const results: TEntity[] = [];

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
            values.push(options.actor);
          } else if (col.auditableType === AuditableFieldType.VERSION) {
            values.push(1);
          } else {
            values.push(null);
          }
          params.push(`$${values.length}`);
        }
        tuples.push(`(${params.join(", ")})`);
      }

      const sql = `INSERT INTO ${quoteIdent(table)} (${colsSql}) VALUES ${tuples.join(", ")} ON CONFLICT (${quoteIdent(conflictTarget)}) DO UPDATE SET ${updateCols.join(", ")} RETURNING *`;
      const result = await this.db.query(sql, values);
      results.push(...(result.rows as TEntity[]));
    }

    return results;
  }

  async deleteMany<TEntity extends object>(
    entity: EntityClass,
    uuids: string[],
    options: WriteOptions
  ): Promise<TEntity[]> {
    if (uuids.length === 0) return [];
    const meta = getEntityPersistenceMeta(entity);
    const table = getTableName(entity);
    const uuidCol = findUuidColumn(meta);
    if (!uuidCol) throw new Error(`Entity ${meta.entityClassName} has no uuid column`);
    const isDeletable = Object.values(meta.columns).some((c) => c.isDeletable);
    if (!isDeletable) throw new Error(`Entity ${meta.entityClassName} has no @DeletableField — cannot soft delete`);

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
    if (deletedByCol) {
      setClauses.push(`${quoteIdent(deletedByCol.sqlName)} = $${values.length + 1}`);
      values.push(options.actor);
    }
    if (updatedAtCol) {
      setClauses.push(`${quoteIdent(updatedAtCol.sqlName)} = $${values.length + 1}`);
      values.push(now);
    }
    if (updatedByCol) {
      setClauses.push(`${quoteIdent(updatedByCol.sqlName)} = $${values.length + 1}`);
      values.push(options.actor);
    }
    if (versionCol) {
      setClauses.push(`${quoteIdent(versionCol.sqlName)} = ${quoteIdent(versionCol.sqlName)} + 1`);
    }

    values.push(uuids);
    const sql = `UPDATE ${quoteIdent(table)} SET ${setClauses.join(", ")} WHERE ${quoteIdent(uuidCol.sqlName)} = ANY($${values.length}::uuid[]) RETURNING *`;
    const result = await this.db.query(sql, values);
    return result.rows as TEntity[];
  }

  async updateMany<TEntity extends object>(
    entity: EntityClass,
    updates: Array<{ uuid: string } & Partial<Record<keyof TEntity & string, unknown>>>,
    options: WriteOptions & { batchSize?: number }
  ): Promise<TEntity[]> {
    if (updates.length === 0) return [];
    const meta = getEntityPersistenceMeta(entity);
    const table = getTableName(entity);
    const uuidCol = findUuidColumn(meta);
    if (!uuidCol) throw new Error(`Entity ${meta.entityClassName} has no uuid column`);
    const isAuditable = meta.isAuditable || Object.values(meta.columns).some((c) => c.isAuditable);

    // Determine the update columns from the first row (excluding uuid)
    const first = updates[0] as Record<string, unknown>;
    const updateKeys = Object.keys(first).filter((k) => k !== "uuid" && first[k] !== undefined);

    if (updateKeys.length === 0) {
      throw new ValidationError("updateMany: no columns to update (only uuid provided?)");
    }

    for (const k of updateKeys) {
      const sqlName = getColumnName(entity, k);
      if (!meta.columns[sqlName]) {
        throw new UnknownColumnError(`updateMany: unknown column/property ${k}`);
      }
    }

    // Add audit columns for the SET clause
    const auditSetCols: string[] = [];
    if (isAuditable) {
      const updatedAtCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_AT);
      const updatedByCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.UPDATED_BY);
      const versionCol = Object.values(meta.columns).find((c) => c.auditableType === AuditableFieldType.VERSION);
      if (updatedAtCol) auditSetCols.push(`${quoteIdent(updatedAtCol.sqlName)} = tmp.${quoteIdent(updatedAtCol.sqlName)}`);
      if (updatedByCol) auditSetCols.push(`${quoteIdent(updatedByCol.sqlName)} = tmp.${quoteIdent(updatedByCol.sqlName)}`);
      if (versionCol) auditSetCols.push(`${quoteIdent(versionCol.sqlName)} = ${quoteIdent(table)}.${quoteIdent(versionCol.sqlName)} + 1`);
    }

    // TEMP TABLE strategy: CREATE TEMP TABLE → batch INSERT → UPDATE FROM → COMMIT
    // We need a transaction for ON COMMIT DROP
    const client = await this.getClient();
    try {
      await client.query("BEGIN");

      // 1. Create temp table — columns must include PG types
      const tmpColDefs: string[] = [];
      const uuidColMeta = Object.values(meta.columns).find((c) => c.propertyKey === uuidCol.propertyKey);
      const uuidPgType = uuidColMeta ? effectivePgStorageType(columnHintsFromMetaColumn(uuidColMeta)) : "uuid";
      tmpColDefs.push(`${quoteIdent(uuidCol.sqlName)} ${uuidPgType}`);

      for (const k of updateKeys) {
        const colMeta = Object.values(meta.columns).find((c) => c.propertyKey === k);
        const pgType = colMeta ? effectivePgStorageType(columnHintsFromMetaColumn(colMeta)) : "text";
        tmpColDefs.push(`${quoteIdent(getColumnName(entity, k))} ${pgType}`);
      }

      if (isAuditable) {
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
      const allTmpKeys = [uuidCol.propertyKey, ...updateKeys];
      if (isAuditable) {
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
            if (k === uuidCol.propertyKey) {
              values.push(rec["uuid"]);
            } else if (isAuditable) {
              const col = Object.values(meta.columns).find((c) => c.propertyKey === k);
              if (col?.auditableType === AuditableFieldType.UPDATED_AT) {
                values.push(now);
              } else if (col?.auditableType === AuditableFieldType.UPDATED_BY) {
                values.push(options.actor);
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

      const updateSql = `UPDATE ${quoteIdent(table)} SET ${setCols.join(", ")} FROM ${quoteIdent(tmpName)} tmp WHERE ${quoteIdent(table)}.${quoteIdent(uuidCol.sqlName)} = tmp.${quoteIdent(uuidCol.sqlName)} RETURNING *`;
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
