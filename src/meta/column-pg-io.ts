/**
 * Bridge JS values ↔ PostgreSQL parameters / wire values for the DAL.
 *
 * - TS has only `Date` for instants; without `@Column({ pgType })` the schema layer maps that to **`timestamptz`**.
 * - With `@Column({ pgType: 'date' })`, `Date` values are sent as **`YYYY-MM-DD`** for a SQL `date` column.
 * - With `@Column({ pgType: 'timestamptz' })` (or default), `Date` is passed through for `node-pg` (`timestamptz`).
 */

import type { EntityPersistenceMeta } from "./entity-decorators.js";

export type ColumnPgPersistenceHints = {
  sqlName: string;
  inferredPgType: string;
  pgType?: string;
  tsDesignTypeCtorName?: string;
};

export function columnHintsFromMetaColumn(
  col: EntityPersistenceMeta["columns"][string]
): ColumnPgPersistenceHints {
  return {
    sqlName: col.sqlName,
    inferredPgType: col.inferredPgType,
    pgType: col.pgType,
    tsDesignTypeCtorName: col.tsDesignTypeCtorName,
  };
}

/** Effective storage type in PostgreSQL (explicit `pgType` wins over inference). */
export function effectivePgStorageType(h: ColumnPgPersistenceHints): string {
  return (h.pgType ?? h.inferredPgType).toLowerCase().trim();
}

/** Column represents an instant / calendar point stored via `Date` in the entity. */
export function isLogicalJsDateColumn(h: ColumnPgPersistenceHints): boolean {
  return h.tsDesignTypeCtorName === "Date" || /_at$/i.test(h.sqlName);
}

/**
 * Value to pass to `node-pg` query parameters (or similar drivers).
 * `Date` → `timestamptz` / `timestamp` as `Date`; SQL `date` as `YYYY-MM-DD` string.
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
  if (typeof value === "string" && isLogicalJsDateColumn(h)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return jsValueToPgParam(d, h);
  }
  // JSONB / JSON columns: serialize objects and arrays to JSON strings
  if ((stor === "jsonb" || stor === "json") && typeof value === "object") {
    return JSON.stringify(value);
  }
  return value;
}

/** Normalise a driver value (often ISO string) into `Date` on the entity when the column is date-like. */
export function pgValueToJsValue(value: unknown, h: ColumnPgPersistenceHints): unknown {
  if (value === null || value === undefined) return value;
  if (!isLogicalJsDateColumn(h)) return value;
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d;
  }
  return value;
}

export function entityDateToApiIso(value: Date): string {
  return value.toISOString();
}

/** After `Object.assign` from JSON, coerce ISO strings into `Date` for date-like columns. */
export function hydrateEntityDateFieldsFromJson<T extends object>(
  instance: T,
  meta: EntityPersistenceMeta
): void {
  for (const col of Object.values(meta.columns)) {
    const h = columnHintsFromMetaColumn(col);
    if (!isLogicalJsDateColumn(h)) continue;
    const key = col.propertyKey as keyof T;
    const v = instance[key];
    if (typeof v === "string" && v.length > 0) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) {
        (instance as Record<string, unknown>)[col.propertyKey] = d;
      }
    }
  }
}
