/**
 * Normalize PostgreSQL physical types for comparisons (PostGIS, arrays, aliases).
 * Mirrors the spirit of pg-diff-api (CatalogApi uses pg_type.typname + typcategory).
 */

import type { SchemaColumnMeta } from "./schema-types.js";

const TIMESTAMP_ALIASES = new Set(["timestamp", "timestamptz", "timestamp without time zone", "timestamp with time zone"]);

/** PostGIS / spatial family (typcategory "G" in pg_type for geometry-like). */
function spatialBucket(typname: string | undefined | null, typcategory: string | undefined | null): string | null {
  const n = (typname ?? "").toLowerCase();
  if (typcategory === "G" || n === "geometry" || n === "geography" || n === "box2d" || n === "box3d") {
    return `spatial:${n || "geometry"}`;
  }
  return null;
}

/** Build a stable string for equality checks across entity hints and catalog introspection. */
export function comparablePgType(meta: Pick<SchemaColumnMeta, "typname" | "typcategory" | "dataType" | "formatType">): string {
  const typname = (meta.typname ?? "").toLowerCase();
  const typcat = meta.typcategory ?? "";
  const dt = (meta.dataType ?? "").toLowerCase();
  const fmt = (meta.formatType ?? "").toLowerCase();

  const spatial = spatialBucket(typname || null, typcat || null);
  if (spatial) return spatial;

  if (typname.endsWith("[]") || fmt.endsWith("[]") || (dt === "array" && typname.startsWith("_"))) {
    const base = fmt.endsWith("[]")
      ? fmt.slice(0, -2)
      : typname.endsWith("[]")
        ? typname.slice(0, -2)
        : typname.replace(/^_/, "");
    return `array:${comparablePgType({ typname: base })}`;
  }

  if (typname === "int4" || typname === "integer") return "int4";
  if (typname === "int8" || typname === "bigint") return "int8";
  if (typname === "int2" || typname === "smallint") return "int2";
  if (typname === "bool" || typname === "boolean") return "bool";
  if (typname === "float4" || typname === "real") return "float4";
  if (typname === "float8" || typname === "double precision") return "float8";
  if (typname === "numeric") return "numeric";

  if (typname === "varchar" || typname === "character varying" || typname.startsWith("varchar(")) {
    return "varchar";
  }
  if (typname === "bpchar" || typname === "char" || typname === "character") return "char";

  if (typname === "text") return "text";
  if (typname === "uuid") return "uuid";
  if (typname === "json" || typname === "jsonb") return typname;

  if (TIMESTAMP_ALIASES.has(typname) || TIMESTAMP_ALIASES.has(dt)) {
    if (typname.includes("tz") || dt.includes("time zone") || fmt.includes("tz")) return "timestamptz";
    return "timestamp";
  }

  if (typname === "date") return "date";
  if (typname === "time" || typname === "timetz") return typname;

  // pgvector — typmod carries the dimension; compare it, don't drop it.
  // Entity hint arrives as "vector(1024)"; catalog as typname "vector" +
  // format_type "vector(1024)".
  if (typname === "vector" || typname.startsWith("vector(") || fmt === "vector" || fmt.startsWith("vector(")) {
    const dim = /vector\((\d+)\)/.exec(typname)?.[1] ?? /vector\((\d+)\)/.exec(fmt)?.[1];
    return dim ? `vector(${dim})` : "vector";
  }

  if (typname) return `raw:${typname}`;
  if (dt) return `ischema:${dt}`;
  if (fmt) return `format:${fmt}`;
  return "unknown";
}

/** True if two metas are “same enough” for rename pairing (not for strict migration). */
export function typesCompatibleForRename(a: SchemaColumnMeta, b: SchemaColumnMeta): boolean {
  const ca = comparablePgType(a);
  const cb = comparablePgType(b);
  if (ca !== "unknown" && cb !== "unknown" && ca === cb) return true;
  // Entity may only declare a loose hint on dataType without typname
  if (a.dataType && b.typname && comparablePgType({ ...a, typname: a.dataType }) === comparablePgType(b)) return true;
  if (b.dataType && a.typname && comparablePgType(a) === comparablePgType({ ...b, typname: b.dataType })) return true;
  return false;
}

/**
 * Canonicalize a column DEFAULT expression for snapshot comparison.
 * `pg_get_expr` de-parses stored defaults into PG's canonical form —
 * `'x'::character varying`, `(1)::bigint`, `'now'::text::timestamptz` —
 * while the entity side authors the raw SQL (`'x'`, `1`, `now()`).
 * We strip `::<type>` casts and redundant outer parens, and collapse
 * whitespace — all strictly outside single-quoted literals so values
 * like `'foo::bar'` or `'a  b'` survive untouched.
 * `undefined` = no default (or unknown).
 */
export function normalizeDefaultExpr(expr: string | null | undefined): string | undefined {
  if (expr == null) return undefined;
  const src = expr.trim();
  // pass 1 — strip `::<type>` casts + collapse whitespace (outside quotes)
  let out = "";
  let i = 0;
  let inQ = false;
  while (i < src.length) {
    const ch = src[i]!;
    if (inQ) {
      out += ch;
      // SQL escapes a quote inside a literal by doubling it
      if (ch === "'" && src[i + 1] === "'") { out += "'"; i++; }
      else if (ch === "'") inQ = false;
      i++;
      continue;
    }
    if (ch === "'") { inQ = true; out += ch; i++; continue; }
    if (ch === ":" && src[i + 1] === ":") {
      const m = /^::\s*"?(?:pg_catalog\.)?\w+"?(?:\s+varying|\s+precision|\s+with\s+time\s+zone|\s+without\s+time\s+zone)*(?:\s*\(\s*\d+(?:\s*,\s*\d+)*\s*\))?(?:\s*\[\s*\])*/i.exec(src.slice(i));
      if (m) { i += m[0].length; continue; }
    }
    if (/\s/.test(ch)) {
      if (out.length > 0 && !out.endsWith(" ")) out += " ";
      i++;
      while (i < src.length && /\s/.test(src[i]!)) i++;
      continue;
    }
    out += ch;
    i++;
  }
  let s = out.trim();
  // pass 2 — strip balanced redundant outer parens (outside quotes)
  for (;;) {
    if (!(s.startsWith("(") && s.endsWith(")"))) break;
    const inner = s.slice(1, -1);
    let depth = 0;
    let q = false;
    let balanced = true;
    for (const c of inner) {
      if (c === "'") q = !q;
      if (q) continue;
      if (c === "(") depth++;
      else if (c === ")" && --depth < 0) { balanced = false; break; }
    }
    if (!balanced || depth !== 0) break;
    s = inner.trim();
  }
  return s === "" ? undefined : s;
}
