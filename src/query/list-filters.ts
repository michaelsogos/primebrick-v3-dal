/**
 * list-filters — canonical translation from HTTP list-filter conditions
 * (QS bracket notation, e.g. `filters[0][field]=x&filters[0][op]=ILIKE&
 * filters[0][value]=%25x%25`) to query-builder `FilterExpr`s.
 *
 * ONE canonical contract for every entity `/list` endpoint. Conditions arrive
 * already structured (the Express `qs` parser produces objects/arrays — no
 * JSON decoding anywhere on the wire).
 *
 * Semantics (superset of the former per-entity copies):
 * - FAIL CLOSED: an unknown `field` (not in `allowedFields`), an unknown
 *   `op`, or a malformed value throws `ValidationError` → 400. A criterion
 *   that cannot be applied must NEVER silently produce unfiltered rows —
 *   skipping a `uuid`-equality would return every row, which is a wrong
 *   answer, not a safe one. Allowlists are the SQL-injection barrier —
 *   field names are never trusted from the wire.
 * - `LIKE`/`ILIKE` + string value without `%` → wrapped as `%value%` (or via
 *   the caller's `escapeIlike` hook when the endpoint escapes wildcards).
 * - `IN`/`NOT IN` → `value` array passed through.
 * - `BETWEEN` + `{start,end}` → `[start, end]` (either bound null →
 *   `ValidationError` — a half-open range is not a BETWEEN).
 * - `IS`/`IS NOT` → only `null`/`boolean` values (enforced downstream by the
 *   query builder).
 * - All conditions are combined inside one group joined by `connector`
 *   (`AND` default), and the group itself is AND-joined with the caller's
 *   other filters (deleted_at, search, …). The per-condition `connector`
 *   field is accepted for wire compatibility but has no effect — children
 *   inside a group are joined uniformly by the group connector.
 */

import { getEntityPersistenceMeta, type EntityClass } from "../meta/entity-meta.js";
import { extJsonStringify } from "@primebrick/core";
import { ValidationError } from "../errors/errors.js";
import { field, Filter, type FilterExpr, type SqlExpressionOperand, type SqlOperator } from "./dsl.js";

export type ListFilterCondition = {
  field: string;
  op: string;
  value: unknown;
  connector?: SqlExpressionOperand;
};

export type ListFilterOptions = {
  /** Property keys the caller allows filtering on (allowlist). */
  allowedFields: ReadonlySet<string>;
  /** How conditions combine inside the group (default AND). */
  connector?: SqlExpressionOperand;
  /** Operator allowlist override (defaults to the full SqlOperator set). */
  validOps?: ReadonlySet<string>;
  /**
   * Optional escaping hook applied to LIKE/ILIKE string values that contain
   * no `%` wildcard — e.g. free-text search escaping `*`/`?`/`%`/`_`.
   * Must return the full pattern (including surrounding `%`).
   */
  escapeIlike?: (raw: string) => string;
};

/* ── Typed-value validation ───────────────────────────────────────────
 * `filters[i][value]` arrives as raw strings on schema-less services —
 * `version=not-a-number` used to reach SQL and escape as a PG cast error
 * (500). Validate coercion against the column's physical pg type at
 * translate time: cheap string checks, zero query cost.
 *
 * LIKE/ILIKE need no check (any string is a legal pattern; non-text
 * columns are CAST to text by the builder). IS/IS NOT only bind
 * null/boolean (enforced downstream). Calculated/virtual columns carry
 * no provable pg type — skipped rather than over-rejected. */
const VALUE_UNCHECKED_OPS = new Set(["LIKE", "ILIKE", "IS", "IS NOT"]);

const INT_PG = new Set(["int2", "int4", "int8", "smallint", "integer", "bigint", "serial", "bigserial", "oid"]);
const NUMERIC_PG = new Set(["numeric", "decimal", "real", "double precision", "float4", "float8", "money"]);
const TEMPORAL_PG = new Set(["timestamptz", "timestamp", "date", "time", "timetz"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertFilterValueType(fieldKey: string, value: unknown, pgType: string): void {
  const elements = Array.isArray(value) ? value : [value];
  for (const el of elements) {
    if (el === null || el === undefined) continue;
    const s = String(el).trim();
    let ok: boolean;
    let expected: string;
    if (INT_PG.has(pgType)) {
      ok = typeof el === "number" ? Number.isInteger(el) : /^[+-]?\d+$/.test(s);
      expected = "integer";
    } else if (NUMERIC_PG.has(pgType)) {
      ok = s !== "" && Number.isFinite(Number(el));
      expected = "number";
    } else if (pgType === "bool" || pgType === "boolean") {
      ok = el === true || el === false || s === "true" || s === "false";
      expected = "boolean";
    } else if (TEMPORAL_PG.has(pgType)) {
      ok = s !== "" && Number.isFinite(Date.parse(s));
      expected = "date/time";
    } else if (pgType === "uuid") {
      ok = UUID_RE.test(s);
      expected = "uuid";
    } else {
      continue;
    }
    if (!ok) {
      throw new ValidationError(
        `Invalid filter value ${extJsonStringify(el)} for "${fieldKey}" — expected ${expected}`,
      );
    }
  }
}

const DEFAULT_VALID_OPS: ReadonlySet<string> = new Set([
  "=",
  "!=",
  "<>",
  "<",
  "<=",
  ">",
  ">=",
  "ILIKE",
  "LIKE",
  "IN",
  "NOT IN",
  "BETWEEN",
  "IS",
  "IS NOT",
]);

export function translateFilterConditions(
  entity: EntityClass,
  conditions: ListFilterCondition[] | undefined | null,
  options: ListFilterOptions
): FilterExpr[] | null {
  if (!conditions || conditions.length === 0) return null;

  const validOps = options.validOps ?? DEFAULT_VALID_OPS;
  const connector = options.connector ?? "AND";

  // Physical pg type per propertyKey — calculated/virtual keys are absent
  // (no provable type → skip, never over-reject).
  const pgTypeByProp = new Map<string, string>();
  for (const c of Object.values(getEntityPersistenceMeta(entity).columns)) {
    const t = (c.pgType ?? c.inferredPgType ?? "").toLowerCase().replace(/\(.*\)/, "").trim();
    if (t) pgTypeByProp.set(c.propertyKey, t);
  }

  const exprs: FilterExpr[] = [];

  for (const cond of conditions) {
    if (!validOps.has(cond.op)) {
      throw new ValidationError(`Invalid filter op "${cond.op}" — allowed: ${[...validOps].join(", ")}`);
    }
    if (!options.allowedFields.has(cond.field)) {
      throw new ValidationError(`Invalid filter field "${cond.field}" — allowed: ${[...options.allowedFields].sort().join(", ")}`);
    }

    let value: unknown = cond.value;

    if ((cond.op === "ILIKE" || cond.op === "LIKE") && typeof value === "string" && !value.includes("%")) {
      value = options.escapeIlike ? options.escapeIlike(value) : `%${value}%`;
    }

    if (cond.op === "BETWEEN") {
      if (
        typeof value === "object" &&
        value !== null &&
        "start" in value &&
        "end" in value
      ) {
        const { start, end } = value as { start: unknown; end: unknown };
        if (start === null || start === undefined || end === null || end === undefined) {
          throw new ValidationError(`BETWEEN on "${cond.field}" needs both start and end`);
        }
        value = [start, end];
      } else if (!Array.isArray(value)) {
        throw new ValidationError(`BETWEEN on "${cond.field}" needs {start,end} or [start,end]`);
      }
    }

    if (!VALUE_UNCHECKED_OPS.has(cond.op)) {
      const pgType = pgTypeByProp.get(cond.field);
      if (pgType) assertFilterValueType(cond.field, value, pgType);
    }

    exprs.push(Filter.fieldValue(field(entity, cond.field as never), cond.op as SqlOperator, value, connector));
  }

  if (exprs.length === 0) return null;
  if (exprs.length === 1) return [Filter.group(exprs, "AND")];

  return [Filter.group([Filter.group(exprs, connector)], "AND")];
}
