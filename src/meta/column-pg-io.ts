/**
 * Bridge JS values ↔ PostgreSQL parameters / wire values for the DAL.
 *
 * Runtime io is driven by three deterministic sources — never by property
 * names and never by `design:type` (transpiler-dependent):
 *
 *   1. explicit `@Column` metadata (`pgType`, `jsType`)
 *   2. semantic decorator flags (`@AuditableField(*_AT)`, `@DeletableField`,
 *      `@SynchronizableField`)
 *   3. value shape (`Date` / `Decimal` / `Vector` / `bigint` instances)
 *
 * Type mapping (entity annotation → storage type) is done once, statically,
 * in the schema pipeline — runtime only needs to convert VALUES.
 */

import { Decimal, dec, toPG } from "@primebrick/core/decimal";
import { Vector } from "../types/vector.js";
import type { EntityPersistenceMeta } from "./entity-decorators.js";

export type ColumnPgPersistenceHints = {
  sqlName: string;
  /** Resolved storage type from runtime meta — explicit pgType or semantic
   *  pin (`'text'` when unknown). Non-authoritative: used as a codec hint,
   *  not as schema truth. */
  inferredPgType: string;
  pgType?: string;
  /** Explicit runtime hydration marker — see `ColumnOptions.jsType`. */
  jsType?: "instant" | "decimal" | "vector";
  isAuditable?: boolean;
  auditableType?: string;
  isDeletable?: boolean;
  deletableType?: string;
  isSynchronizable?: boolean;
  synchronizableType?: string;
};

export function columnHintsFromMetaColumn(
  col: EntityPersistenceMeta["columns"][string]
): ColumnPgPersistenceHints {
  return {
    sqlName: col.sqlName,
    inferredPgType: col.inferredPgType,
    pgType: col.pgType,
    jsType: col.jsType,
    isAuditable: col.isAuditable,
    auditableType: col.auditableType,
    isDeletable: col.isDeletable,
    deletableType: col.deletableType,
    isSynchronizable: col.isSynchronizable,
    synchronizableType: col.synchronizableType,
  };
}

/** Effective storage type in PostgreSQL (explicit `pgType` wins over inference). */
export function effectivePgStorageType(h: ColumnPgPersistenceHints): string {
  return (h.pgType ?? h.inferredPgType).toLowerCase().trim();
}

/**
 * Column carries a `Date`-valued property — an audit/deletable/sync `*_AT`
 * field, an `instant` codec hint, or an explicit timestamptz/timestamp
 * pgType. `date`/`time`/`timetz` columns are `ISODate`/`ISOTime` strings —
 * NOT Dates — by contract.
 */
export function isLogicalJsDateColumn(h: ColumnPgPersistenceHints): boolean {
  if (h.jsType === "instant") return true;
  if (h.auditableType === "CREATED_AT" || h.auditableType === "UPDATED_AT") return true;
  if (h.deletableType === "DELETED_AT") return true;
  if (h.synchronizableType === "LAST_SYNCED_AT") return true;
  // explicit pgType or semantic pin resolve to the timestamp family —
  // `date`/`time` are ISODate/ISOTime strings, NOT Dates, by contract.
  return /^(timestamp|timestamptz)\b/.test(effectivePgStorageType(h));
}

/** Column carries a `Decimal` value (`numeric` storage). */
function isDecimalColumn(h: ColumnPgPersistenceHints): boolean {
  return h.jsType === "decimal" || /^(numeric|decimal)\b/.test(effectivePgStorageType(h));
}

/** Column carries a `Vector` value (pgvector `vector(N)` storage). */
function isVectorColumn(h: ColumnPgPersistenceHints): boolean {
  return h.jsType === "vector" || effectivePgStorageType(h).startsWith("vector");
}

/**
 * Value to pass to `node-pg` query parameters.
 * `Date` → passthrough (timestamptz) or `YYYY-MM-DD` (SQL `date`);
 * `Decimal` → plain numeric string; `Vector`/`number[]` → `'[…]'` literal;
 * jsonb payloads → JSON string (nested bigint → number — jsonb numerics are
 * doubles anyway and BigInt breaks JSON.stringify).
 */
export function jsValueToPgParam(value: unknown, h: ColumnPgPersistenceHints): unknown {
  if (value === null || value === undefined) return value;
  const stor = effectivePgStorageType(h);
  if (value instanceof Date) {
    if (stor === "date" || /^date\b/i.test(stor)) {
      return value.toISOString().slice(0, 10);
    }
    return value;
  }
  if (value instanceof Decimal) return toPG(value);
  if (value instanceof Vector) return value.toString();
  if (typeof value === "string" && isLogicalJsDateColumn(h)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return jsValueToPgParam(d, h);
  }
  if (isVectorColumn(h)) {
    if (Array.isArray(value)) return `[${value.join(",")}]`;
    return value;
  }
  if (stor === "jsonb" || stor === "json") {
    if (typeof value === "object") {
      // standards-exempt: ext-json — jsonb storage format is plain JSON by contract; bigint→number is the deliberate coercion (no @primebrick/sdk dep)
      return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
    }
    if (typeof value === "bigint") return Number(value);
  }
  return value;
}

/**
 * Normalise a driver value into the entity-side type: `Date` for date-like
 * columns, `Decimal` for numeric columns, `Vector` for vector columns.
 * Driver-native shapes (pg already returns `Date`/`bigint`/arrays) pass
 * through unchanged.
 */
export function pgValueToJsValue(value: unknown, h: ColumnPgPersistenceHints): unknown {
  if (value === null || value === undefined) return value;
  if (isDecimalColumn(h)) {
    if (value instanceof Decimal) return value;
    if (typeof value === "string") return dec(value.replace(/d$/, ""));
    if (typeof value === "number" || typeof value === "bigint") return dec(value);
    return value;
  }
  if (isVectorColumn(h)) {
    if (value instanceof Vector) return value;
    if (typeof value === "string" || Array.isArray(value)) return Vector.from(value);
    return value;
  }
  if (isLogicalJsDateColumn(h)) {
    if (value instanceof Date) return value;
    if (typeof value === "string" || typeof value === "number") {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? value : d;
    }
  }
  return value;
}

export function entityDateToApiIso(value: Date): string {
  return value.toISOString();
}

/**
 * After `Object.assign` from JSON, restore column-typed values on the
 * entity: `instant` → `Date`, `decimal` → `Decimal` (wire `"N.Nd"` or a
 * bare numeric string), `vector` → `Vector`.
 */
export function hydrateEntityDateFieldsFromJson<T extends object>(
  instance: T,
  meta: EntityPersistenceMeta
): void {
  for (const col of Object.values(meta.columns)) {
    const h = columnHintsFromMetaColumn(col);
    const key = col.propertyKey as keyof T;
    const v = instance[key];
    if (v === null || v === undefined) continue;
    const converted = pgValueToJsValue(v, h);
    if (converted !== v) {
      (instance as Record<string, unknown>)[col.propertyKey] = converted;
    }
  }
}
