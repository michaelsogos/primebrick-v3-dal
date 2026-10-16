/**
 * Entity-annotation → PostgreSQL base type mapping — the single deterministic
 * table for the schema pipeline.
 *
 * Resolution order:
 *   1. explicit `@Column({ pgType })` (validated against `PgColumnType`)
 *   2. the TS type annotation — extracted statically by
 *      `entity-annotation-extract` (transpiler-independent)
 *   3. `throw` — an unmappable type is a contract violation, not a silent
 *      `text` column
 *
 * There is deliberately NO name-based inference: `*_uuid`, `id`, `version`,
 * `*_at` do not influence the type. Say what the column IS via the annotation
 * (`UUID`, `Date`, `bigint`, …) or via an explicit `pgType`.
 *
 * Modifiers are options, never SQL strings: `varchar(N)` ← `length` on a
 * `string` prop, `vector(N)` ← `length` on a `Vector` prop,
 * `numeric(p,s)` ← `precision`/`scale`.
 */
import type { EntityAnnotationInfo } from "./entity-annotation-extract.js";

export type EntityColumnTypeHints = {
  sqlName: string;
  propertyKey: string;
  isKey: boolean;
  /** Explicit `@Column({ pgType })` — always wins, must be a `PgColumnType`. */
  explicitPgType?: string;
  length?: number;
  precision?: number;
  scale?: number;
  /**
   * Semantic decorators pin the storage type of system columns —
   * `@AuditableField(VERSION)` is always `int4` regardless of how the prop
   * is annotated (`number` would otherwise infer `float8`).
   */
  auditableType?: string;
  deletableType?: string;
  synchronizableType?: string;
  /** Static source annotation (present in the schema pipeline; absent at
   *  runtime — runtime io never needs it, it drives params via value shape). */
  annotation?: EntityAnnotationInfo;
};

/**
 * Semantic pins applied between explicit `pgType` and annotation inference:
 * the annotation of a system field may be loose (`number` for `version`),
 * but the storage contract is fixed by the decorator's semantics.
 */
const AUDITABLE_TYPE_PINS: Record<string, string> = {
  CREATED_AT: "timestamptz",
  UPDATED_AT: "timestamptz",
  VERSION: "int4",
};
const DELETABLE_TYPE_PINS: Record<string, string> = {
  DELETED_AT: "timestamptz",
};
const SYNCHRONIZABLE_TYPE_PINS: Record<string, string> = {
  LAST_SYNCED_AT: "timestamptz",
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
    if (t === "vector") {
      return `vector(${Math.trunc(h.length)})`;
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
    if (t === "numeric" || t === "decimal") {
      return s === undefined ? `numeric(${Math.trunc(p)})` : `numeric(${Math.trunc(p)},${Math.trunc(s)})`;
    }
    return s === undefined ? `${t}(${Math.trunc(p)})` : `${t}(${Math.trunc(p)},${Math.trunc(s)})`;
  }

  return t;
}

/** Canonical spellings — aliases are folded here so snapshots are stable. */
const PG_TYPE_ALIASES: Record<string, string> = {
  "smallint": "int2",
  "integer": "int4",
  "int": "int4",
  "bigint": "int8",
  "real": "float4",
  "double precision": "float8",
  "bool": "boolean",
  "decimal": "numeric",
  "character varying": "varchar",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  "time with time zone": "timetz",
  "time without time zone": "time",
};

/** Fold alias spellings to canonical names (`integer` → `int4`, …). */
export function canonicalPgType(t: string): string {
  return PG_TYPE_ALIASES[t.trim().toLowerCase()] ?? t.trim().toLowerCase();
}

/**
 * Annotation → base pg type. Returns `null` for unmappable annotations —
 * the caller decides whether that's an error (schema pipeline) or a
 * non-authoritative runtime hint.
 */
export function pgTypeFromAnnotation(a: EntityAnnotationInfo): string | null {
  // Strip generic arguments — `Uint8Array<ArrayBufferLike>` (TS ≥5.7) is the
  // same column kind as `Uint8Array`. Records/Maps stay object-like → jsonb.
  const name = a.typeName.replace(/<.*>$/, "");
  if (a.isArray) {
    const el = a.elementTypeName;
    const base =
      el === "string" || el === "String" || el === "UUID" ? (el === "UUID" ? "uuid" : "text")
      : el === "number" ? "float8"
      : el === "bigint" ? "int8"
      : el === "boolean" ? "boolean"
      : el === "Decimal" ? "numeric"
      : null;
    return base === null ? null : `${base}[]`;
  }
  switch (name) {
    // branded / guarded types
    case "UUID": return "uuid";
    case "Decimal": return "numeric";
    case "ISODate": return "date";
    case "ISOTime": return "time";
    case "Vector": return "vector";
    // primitives
    case "string":
    case "String": return "text";
    case "number":
    case "Number": return "float8";
    case "bigint":
    case "BigInt": return "int8";
    case "boolean":
    case "Boolean": return "boolean";
    case "Date": return "timestamptz";
    case "Uint8Array":
    case "Buffer": return "bytea";
  }
  if (a.isStringLiteralUnion) return "text";
  // Callable/tuple/enum/symbol/exotic-union shapes are never columns — check
  // here (after the name switch: branded intersections like `UUID` resolve by
  // name above) and before the object-like fallback: a function type IS
  // `Object`-flagged and would otherwise slip through to `jsonb` instead of
  // throwing.
  if (a.isUnmappable) return null;
  // interfaces, Records, object-literal shapes, `unknown`/`any` → jsonb
  if (a.isObjectLike || name === "object" || name === "unknown" || name === "any") {
    return "jsonb";
  }
  // anything else — unmappable, caller throws
  return null;
}

function semanticPin(h: EntityColumnTypeHints): string | undefined {
  return (
    (h.auditableType ? AUDITABLE_TYPE_PINS[h.auditableType] : undefined) ??
    (h.deletableType ? DELETABLE_TYPE_PINS[h.deletableType] : undefined) ??
    (h.synchronizableType ? SYNCHRONIZABLE_TYPE_PINS[h.synchronizableType] : undefined) ??
    undefined
  );
}

/** Resolved SQL type name for compare + snapshot (not full column DDL). */
export function inferPgTypeFromEntityColumn(h: EntityColumnTypeHints): string {
  const base =
    h.explicitPgType?.trim() ??
    semanticPin(h) ??
    (h.annotation ? pgTypeFromAnnotation(h.annotation) : null) ??
    "text"; // runtime-only fallback when no static info — non-authoritative
  return applyTypeModifiers(base, h);
}

/**
 * Authoritative resolve for the schema pipeline: explicit `pgType`, else
 * semantic decorator pin, else annotation inference. Throws when none can
 * produce a type — an unmappable entity property must never silently
 * become `text`.
 */
export function resolvePgTypeForSchema(h: EntityColumnTypeHints): string {
  if (h.explicitPgType !== undefined && h.annotation) {
    assertPgTypeCompatible(h.annotation, h.explicitPgType, h.propertyKey);
  }
  const base = h.explicitPgType?.trim() ?? semanticPin(h);
  if (base) return applyTypeModifiers(base, h);
  if (!h.annotation) {
    throw new Error(`No type information for ${h.propertyKey} — run the schema pipeline with static annotation extraction`);
  }
  const inferred = pgTypeFromAnnotation(h.annotation);
  if (inferred === null) {
    throw new Error(
      `Unmappable type "${h.annotation.annotation}" on ${h.propertyKey} — ` +
        `declare @Column({ pgType }) explicitly`,
    );
  }
  return applyTypeModifiers(inferred, h);
}

// ─── annotation ↔ pgType compatibility matrix ────────────────────────────────

function stripTypeModifiers(t: string): string {
  return t.replace(/\s*\(.*$/, "").trim();
}

/** Canonical annotation family key (primitives lowercased, brands kept). */
function annotationKey(a: EntityAnnotationInfo): string | null {
  if (a.isArray) {
    const el = a.elementTypeName;
    if (!el) return null;
    if (el === "string" || el === "String") return "string[]";
    if (el === "number" || el === "Number") return "number[]";
    if (el === "bigint" || el === "BigInt") return "bigint[]";
    if (el === "boolean" || el === "Boolean") return "boolean[]";
    // Branded element families keep their name (`UUID[]`, `Decimal[]`).
    if (el === "UUID" || el === "Decimal") return `${el}[]`;
    return null; // unmappable element — explicit pgType is the escape hatch
  }
  const n = a.typeName.replace(/<.*>$/, "");
  if (n === "string" || n === "String" || a.isStringLiteralUnion) return "string";
  if (n === "number" || n === "Number") return "number";
  if (n === "bigint" || n === "BigInt") return "bigint";
  if (n === "boolean" || n === "Boolean") return "boolean";
  if (n === "Uint8Array" || n === "Buffer") return "Uint8Array";
  // Named families first — `Date`/`Vector`/`Decimal` are object-like at the
  // type level but carry their own whitelist; generic objects → "object".
  if (PG_TYPE_ALLOWED[n] !== undefined) return n;
  if (a.isObjectLike || n === "object" || n === "unknown" || n === "any") return "object";
  return null; // unmappable — explicit pgType is the escape hatch
}

/**
 * Whitelist: explicit `pgType` values legal for each annotation family.
 * An annotation family NOT listed here is unmappable — an explicit `pgType`
 * is then the sanctioned escape hatch and always allowed.
 */
const PG_TYPE_ALLOWED: Record<string, readonly string[]> = {
  UUID: ["uuid"],
  string: ["text", "varchar", "char", "citext", "uuid", "inet", "cidr", "macaddr", "macaddr8", "json", "jsonb", "xml"],
  number: ["float8", "float4", "int4", "int2"],
  bigint: ["int8"],
  boolean: ["boolean"],
  Decimal: ["numeric"],
  Date: ["timestamptz", "timestamp"],
  ISODate: ["date"],
  ISOTime: ["time", "timetz"],
  Vector: ["vector"],
  Uint8Array: ["bytea"],
  object: ["jsonb", "json"],
  "string[]": ["text[]", "varchar[]", "jsonb", "json"],
  "UUID[]": ["uuid[]"],
  "number[]": ["float8[]", "float4[]", "int4[]", "int2[]", "numeric[]"],
  "bigint[]": ["int8[]", "numeric[]"],
  "boolean[]": ["boolean[]"],
  "Decimal[]": ["numeric[]"],
};

/**
 * Throws when an explicit `pgType` is incompatible with the declared TS
 * annotation family (e.g. `UUID` + `pgType:"text"`, `number` + `pgType:
 * "int8"`). Unmappable families pass — the explicit type is their contract.
 */
export function assertPgTypeCompatible(
  annotation: EntityAnnotationInfo,
  explicitPgType: string,
  propertyKey: string,
): void {
  const key = annotationKey(annotation);
  const allowed = key === null ? undefined : PG_TYPE_ALLOWED[key];
  if (!allowed) return; // escape hatch — unmappable families
  const canon = canonicalPgType(stripTypeModifiers(explicitPgType));
  if (!allowed.includes(canon)) {
    throw new Error(
      `pgType "${explicitPgType}" is incompatible with annotation "${annotation.annotation}" ` +
        `on ${propertyKey} — allowed: ${allowed.join(", ")}`,
    );
  }
}

/** Advisory warning — never fails a build, printed by `primebrick-db`. */
export type EntityTypeWarning = {
  kind: "uuid-name" | "redundant-pgType";
  entity: string;
  column: string;
  message: string;
};

const UUID_NAME_RE = /(^|_)uuid$/i;

/**
 * Authoring warnings for one column:
 * - `uuid-name` — a `*_uuid`/`uuid` column resolving to a non-uuid type.
 *   The name SAYS uuid; either the column should be `uuid` (retype the prop
 *   to `UUID` or set `pgType:"uuid"`) or the name lies.
 * - `redundant-pgType` — explicit `pgType` equal to what the annotation
 *   already infers; drop it (we never spell out the default).
 */
export function columnTypeWarnings(
  entityName: string,
  h: EntityColumnTypeHints,
  resolved: string,
): EntityTypeWarning[] {
  const out: EntityTypeWarning[] = [];
  const canonResolved = canonicalPgType(stripTypeModifiers(resolved));
  const uuidNamed = UUID_NAME_RE.test(h.sqlName);
  // An explicit pgType on a `*_uuid` column IS the answer to the uuid-name
  // question — `pgType:"text"` declares a deliberate loose reference and
  // silences both warnings for this column.
  if (uuidNamed && h.explicitPgType === undefined && canonResolved !== "uuid" && canonResolved !== "uuid[]") {
    out.push({
      kind: "uuid-name",
      entity: entityName,
      column: h.sqlName,
      message:
        `${entityName}.${h.propertyKey} (${h.sqlName}) is named *_uuid but resolves to ` +
        `${resolved} — sure it should not be uuid? (retype to UUID, set pgType:"uuid", ` +
        `or declare pgType:"text" explicitly if the loose reference is intended)`,
    });
  }
  if (h.explicitPgType !== undefined && h.annotation && !uuidNamed) {
    const inferred = pgTypeFromAnnotation(h.annotation);
    if (
      inferred !== null &&
      canonicalPgType(stripTypeModifiers(h.explicitPgType)) ===
        canonicalPgType(stripTypeModifiers(applyTypeModifiers(inferred, { ...h, explicitPgType: undefined })))
    ) {
      out.push({
        kind: "redundant-pgType",
        entity: entityName,
        column: h.sqlName,
        message:
          `${entityName}.${h.propertyKey}: pgType "${h.explicitPgType}" restates the ` +
          `${h.annotation.annotation} default (${inferred}) — remove it`,
      });
    }
  }
  return out;
}
