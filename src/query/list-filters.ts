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
 * - Unknown `field` (not in `allowedFields`) or unknown `op` → condition is
 *   skipped (allowlists are the SQL-injection barrier — field names are never
 *   trusted from the wire).
 * - `LIKE`/`ILIKE` + string value without `%` → wrapped as `%value%` (or via
 *   the caller's `escapeIlike` hook when the endpoint escapes wildcards).
 * - `IN`/`NOT IN` → `value` array passed through.
 * - `BETWEEN` + `{start,end}` → `[start, end]` (skipped when either bound is
 *   null — a half-open range is not a BETWEEN).
 * - `IS`/`IS NOT` → only `null`/`boolean` values (enforced downstream by the
 *   query builder).
 * - All conditions are combined inside one group joined by `connector`
 *   (`AND` default), and the group itself is AND-joined with the caller's
 *   other filters (deleted_at, search, …). The per-condition `connector`
 *   field is accepted for wire compatibility but has no effect — children
 *   inside a group are joined uniformly by the group connector.
 */

import type { EntityClass } from "../meta/entity-meta.js";
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

  const exprs: FilterExpr[] = [];

  for (const cond of conditions) {
    if (!validOps.has(cond.op)) continue;
    if (!options.allowedFields.has(cond.field)) continue;

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
        if (start === null || start === undefined || end === null || end === undefined) continue;
        value = [start, end];
      } else if (!Array.isArray(value)) {
        continue;
      }
    }

    exprs.push(Filter.fieldValue(field(entity, cond.field as never), cond.op as SqlOperator, value, connector));
  }

  if (exprs.length === 0) return null;
  if (exprs.length === 1) return [Filter.group(exprs, "AND")];

  return [Filter.group([Filter.group(exprs, connector)], "AND")];
}
