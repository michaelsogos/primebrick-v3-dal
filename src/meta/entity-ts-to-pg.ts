/**
 * Map TypeScript `design:type` metadata (when present, e.g. `tsc` build) plus **naming heuristics**
 * to PostgreSQL **base** type names (identity / unique indexes are handled in DDL, not here).
 *
 * **Instants:** JS/TS only has `Date`. Without `@Column({ pgType })`, a `Date` property maps to **`timestamptz`**
 * (audit `*_at` columns use the same default). With `@Column({ pgType: 'date' })`, DDL uses SQL `date` and
 * the DAL (`column-pg-io`) binds `Date` as `YYYY-MM-DD`.
 *
 * Note: `tsx` / esbuild does **not** emit `emitDecoratorMetadata`; the `*_at` name branch still yields `timestamptz`.
 */

export type EntityColumnTypeHints = {
  sqlName: string;
  propertyKey: string;
  isKey: boolean;
  /** `Reflect.getMetadata("design:type").name`, e.g. "String", "Number" */
  tsDesignTypeCtorName?: string;
  /** Explicit `@Column({ pgType })` wins over inference */
  explicitPgType?: string;
  length?: number;
  precision?: number;
  scale?: number;
};

function applyTypeModifiers(baseType: string, h: EntityColumnTypeHints): string {
  const t = baseType.trim();
  const hasParens = /\w\s*\(.*\)$/.test(t);
  if (hasParens) return t;

  if (h.length !== undefined) {
    if (!Number.isFinite(h.length) || h.length <= 0) {
      throw new Error(`Invalid length for ${h.propertyKey}: ${h.length}`);
    }
    if (t === "text" || t === "varchar" || t === "character varying") {
      return `varchar(${Math.trunc(h.length)})`;
    }
    if (t === "char" || t === "character") {
      return `char(${Math.trunc(h.length)})`;
    }
  }

  if (h.precision !== undefined || h.scale !== undefined) {
    const p = h.precision;
    const s = h.scale;
    if (p === undefined || !Number.isFinite(p) || p <= 0) {
      throw new Error(`Invalid precision for ${h.propertyKey}: ${p}`);
    }
    if (s !== undefined && (!Number.isFinite(s) || s < 0)) {
      throw new Error(`Invalid scale for ${h.propertyKey}: ${s}`);
    }
    if (t === "numeric" || t === "decimal" || t === "number" || t === "float" || t === "float8" || t === "float4") {
      return s === undefined ? `numeric(${Math.trunc(p)})` : `numeric(${Math.trunc(p)},${Math.trunc(s)})`;
    }
    return s === undefined ? `${t}(${Math.trunc(p)})` : `${t}(${Math.trunc(p)},${Math.trunc(s)})`;
  }

  return t;
}

function inferFromSqlAndPropertyNames(h: EntityColumnTypeHints): string {
  const sl = h.sqlName.toLowerCase();
  const pk = h.propertyKey.toLowerCase();

  if (sl === "uuid" || pk === "uuid") {
    return "uuid";
  }
  if ((sl === "id" || pk === "id") && h.isKey) {
    return "bigint";
  }
  if (sl === "id" || pk === "id") {
    return "integer";
  }
  if (sl === "version" || pk === "version") {
    return "integer";
  }
  if (
    sl.endsWith("_at") ||
    sl === "created_at" ||
    sl === "updated_at" ||
    sl === "deleted_at" ||
    sl === "created_on" ||
    sl === "updated_on"
  ) {
    return "timestamptz";
  }
  if (sl === "created_by" || sl === "updated_by" || sl === "deleted_by") {
    return "text";
  }
  return "text";
}

function inferFromDesignTypeName(h: EntityColumnTypeHints): string | null {
  const name = h.tsDesignTypeCtorName;
  if (!name) return null;
  const sl = h.sqlName.toLowerCase();
  const pk = h.propertyKey.toLowerCase();

  if (name === "Number") {
    if ((sl === "id" || pk === "id") && h.isKey) return "bigint";
    if (sl === "version" || pk === "version") return "integer";
    return "integer";
  }
  if (name === "Boolean") return "boolean";
  if (name === "Date") return "timestamptz";
  if (name === "String") {
    if (sl === "uuid" || pk === "uuid") return "uuid";
    if (
      sl.endsWith("_at") ||
      sl === "created_at" ||
      sl === "updated_at" ||
      sl === "deleted_at"
    ) {
      return "timestamptz";
    }
    return "text";
  }
  return null;
}

/**
 * When `emitDecoratorMetadata` is on, `string | null` and many unions emit `design:type` = `Object`.
 * Scalar constructors (`String`, `Number`, …) are treated as NOT NULL in DDL unless `@Column({ nullable })` overrides.
 */
export function inferColumnNullableFromDesignType(
  designType: unknown,
  isKey: boolean,
  isUnique: boolean
): boolean | undefined {
  if (isKey || isUnique) return false;
  if (!designType || typeof designType !== "function") return undefined;
  const name = (designType as Function).name;
  if (name === "Object") return true;
  return false;
}

/** Resolved SQL **type name** for compare + snapshot (not full column DDL). */
export function inferPgTypeFromEntityColumn(h: EntityColumnTypeHints): string {
  const base =
    h.explicitPgType?.trim() ||
    inferFromDesignTypeName(h) ||
    inferFromSqlAndPropertyNames(h);
  return applyTypeModifiers(base, h);
}
