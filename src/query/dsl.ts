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
  | "IS NOT";

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
      kind: "group";
      filters: FilterExpr[];
      operand: SqlExpressionOperand;
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
  group(filters: FilterExpr[], operand: SqlExpressionOperand = "AND"): FilterExpr {
    return { kind: "group", filters, operand };
  },
};

export type SortingExpr = { field: FieldRef<any, any>; dir: SqlSortDirection };
export const Sort = {
  by(field: FieldRef<any, any>, dir: SqlSortDirection = "ASC"): SortingExpr {
    return { field, dir };
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
  | { kind: "expr"; expr: string; alias: string };

export const Project = {
  field(field: FieldRef<any, any>, alias?: string): FieldProjector {
    return { kind: "field", field, alias };
  },
  expr(expr: string, alias: string): FieldProjector {
    return { kind: "expr", expr, alias };
  },
};
