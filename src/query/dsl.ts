import type { EntityClass } from "../meta/entity-meta.js";

export type SqlOperator =
  | "="
  | "!="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "ILIKE"
  | "LIKE"
  | "IN"
  | "NOT IN"
  | "BETWEEN"
  | "IS"
  | "IS NOT"
  // pgvector distance operators — `<=>` cosine, `<->` L2, `<#>` inner
  // product, `<+>` L1, `<~>` hamming, `<%>` jaccard. In `field_value`
  // filters the bound value is auto-serialized and cast `::vector`.
  | "<=>"
  | "<->"
  | "<#>"
  | "<+>"
  | "<~>"
  | "<%>"
  // Full-text match (tsvector @@ tsquery).
  | "@@";

/**
 * A parameterized SQL operand for `Filter.expr` — `?` markers inside `sql`
 * are replaced by `$n` bound parameters in order of appearance.
 *
 * `sql` is a trusted literal (never interpolated user input); `params`
 * carries the only dynamic data. Example:
 *   `{ sql: "to_tsvector(?, d.content)", params: ["simple"] }`
 */
export type ExprOperand = { sql: string; params?: unknown[] };

export type SqlSortDirection = "ASC" | "DESC";
export type SqlJoinType = "INNER" | "LEFT" | "RIGHT";
export type SqlExpressionOperand = "AND" | "OR";

export type FieldRef<TEntity, K extends keyof TEntity & string> = {
  entity: EntityClass;
  key: K;
};

export function field<TEntity, K extends keyof TEntity & string>(
  entity: EntityClass,
  key: K
): FieldRef<TEntity, K> {
  return { entity, key };
}

export type FilterExpr =
  | {
      kind: "field_value";
      left: FieldRef<any, any>;
      op: SqlOperator;
      right: unknown;
      operand: SqlExpressionOperand;
    }
  | {
      kind: "field_field";
      left: FieldRef<any, any>;
      op: SqlOperator;
      right: FieldRef<any, any>;
      operand: SqlExpressionOperand;
    }
  | {
      kind: "raw";
      left: string;
      op: SqlOperator;
      right: string;
      operand: SqlExpressionOperand;
    }
  | {
      /** Parameterized operands — functions, casts, computed expressions
       *  (e.g. `to_tsvector('simple', d.content) @@ websearch_to_tsquery(…)`).
       *  Unlike `raw` (trusted literals only), `?` markers inside `sql` bind
       *  real parameters — the only safe way to mix SQL functions with
       *  user-provided values. */
      kind: "expr";
      left: ExprOperand;
      op: SqlOperator;
      right: ExprOperand;
      operand: SqlExpressionOperand;
    }
  | {
      kind: "group";
      filters: FilterExpr[];
      /** Outer joiner — how this group combines with its siblings (default AND). */
      operand: SqlExpressionOperand;
      /** Inner connector — how the group's children combine (default: operand). */
      connector?: SqlExpressionOperand;
    };

export const Filter = {
  fieldValue(
    left: FieldRef<any, any>,
    op: SqlOperator,
    right: unknown,
    operand: SqlExpressionOperand = "AND"
  ): FilterExpr {
    return { kind: "field_value", left, op, right, operand };
  },
  fieldField(
    left: FieldRef<any, any>,
    op: SqlOperator,
    right: FieldRef<any, any>,
    operand: SqlExpressionOperand = "AND"
  ): FilterExpr {
    return { kind: "field_field", left, op, right, operand };
  },
  raw(left: string, op: SqlOperator, right: string, operand: SqlExpressionOperand = "AND"): FilterExpr {
    return { kind: "raw", left, op, right, operand };
  },
  /**
   * Binary comparison between parameterized SQL expressions — the standard
   * way to express function calls / casts on either side of an operator
   * with bound values. `?` markers become `$n` params in order.
   *
   *   Filter.expr(
   *     { sql: "to_tsvector(?, d.content)", params: ["simple"] },
   *     "@@",
   *     { sql: "websearch_to_tsquery(?, ?)", params: ["simple", userQuery] },
   *   )
   *   // → to_tsvector($1, d.content) @@ websearch_to_tsquery($2, $3)
   */
  expr(left: ExprOperand, op: SqlOperator, right: ExprOperand, operand: SqlExpressionOperand = "AND"): FilterExpr {
    return { kind: "expr", left, op, right, operand };
  },
  /**
   * `connector` joins the children INSIDE the parens; `operand` joins the
   * group to its SIBLINGS. `Filter.group(ors, "OR")` therefore renders
   * `(a OR b)` and is AND-joined to siblings — the historically intended
   * semantic (e.g. search clauses).
   */
  group(filters: FilterExpr[], connector: SqlExpressionOperand = "AND", operand: SqlExpressionOperand = "AND"): FilterExpr {
    return { kind: "group", filters, operand, connector };
  },
};

export type SortingExpr =
  | { field: FieldRef<any, any>; dir: SqlSortDirection }
  /** ORDER BY a projected column alias (e.g. an aggregate/expr projection). */
  | { kind: "alias"; alias: string; dir: SqlSortDirection }
  /** ORDER BY a parameterized expression — `?` markers bind `params`. */
  | { kind: "expr"; sql: string; params?: unknown[]; dir: SqlSortDirection };
export const Sort = {
  by(field: FieldRef<any, any>, dir: SqlSortDirection = "ASC"): SortingExpr {
    return { field, dir };
  },
  /** Sort on a projected alias — e.g. `Sort.byAlias("bucket", "DESC")` after
   *  `Project.expr("date_trunc('hour', created_at)", "bucket")`. */
  byAlias(alias: string, dir: SqlSortDirection = "ASC"): SortingExpr {
    return { kind: "alias", alias, dir };
  },
  /** Sort on a parameterized expression — `?` markers bind `params` in
   *  order (same contract as `Filter.expr`/`GroupBy.expr`). */
  byExpr(sql: string, params: unknown[] | undefined, dir: SqlSortDirection = "ASC"): SortingExpr {
    return { kind: "expr", sql, params, dir };
  },
};

/**
 * GROUP BY operand — either an entity field reference or a parameterized
 * SQL expression (`?` markers bind `params` in order). Expressions are
 * required for grouping over computed values like `date_trunc(?, created_at)`.
 * Non-aggregate `field` projections are auto-added to GROUP BY by the
 * builder; expression projections must be listed here explicitly when they
 * are the grouping key.
 */
export type GroupByOperand =
  | FieldRef<any, any>
  | { kind: "expr"; sql: string; params?: unknown[] };
export const GroupBy = {
  /** Group by a parameterized expression — e.g.
   *  `GroupBy.expr("date_trunc(?, created_at)", ["hour"])`. Column refs in
   *  `sql` are trusted literals (same contract as `Project.expr`); only
   *  `params` carry runtime data. */
  expr(sql: string, params?: unknown[]): GroupByOperand {
    return { kind: "expr", sql, params };
  },
};

export type JoinExpr = {
  right: FieldRef<any, any>;
  left: FieldRef<any, any>;
  type: SqlJoinType;
  alias?: string;
  options?: { castRightTo?: string; castLeftTo?: string };
};
export const Join = {
  on(
    left: FieldRef<any, any>,
    right: FieldRef<any, any>,
    type: SqlJoinType = "INNER",
    options?: { castRightTo?: string; castLeftTo?: string; alias?: string }
  ): JoinExpr {
    return { right, left, type, alias: options?.alias, options: { castRightTo: options?.castRightTo, castLeftTo: options?.castLeftTo } };
  },
};

export type FieldProjector =
  | { kind: "field"; field: FieldRef<any, any>; alias?: string }
  /** `expr` is a trusted literal; `?` markers bind `params` in order
   *  (same contract as `Filter.expr`/`GroupBy.expr`/`Sort.byExpr`). */
  | { kind: "expr"; expr: string; alias: string; params?: unknown[] };

export const Project = {
  field(field: FieldRef<any, any>, alias?: string): FieldProjector {
    return { kind: "field", field, alias };
  },
  expr(expr: string, alias: string, params?: unknown[]): FieldProjector {
    return params !== undefined ? { kind: "expr", expr, alias, params } : { kind: "expr", expr, alias };
  },
};
