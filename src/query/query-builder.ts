import type { EntityClass } from "../meta/entity-meta.js";
import { getColumnName, getEntityPersistenceMeta, getTableName, getQualifiedTableName } from "../meta/entity-meta.js";

import type { FieldProjector, FilterExpr, JoinExpr, SortingExpr } from "./dsl.js";
import type { WithDeletedRecords } from "../types/types.js";

export type SqlQuery = { text: string; values: unknown[] };

function assertValidIdentPart(s: string, what: string): void {
  // Keep it strict to avoid SQL injection through identifiers.
  // Allow: letters, digits, underscore; must start with letter or underscore.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    throw new Error(`Invalid ${what}: ${JSON.stringify(s)}`);
  }
}

export function quoteIdent(ident: string): string {
  assertValidIdentPart(ident, "identifier");
  return `"${ident}"`;
}

function qTable(entity: EntityClass, tableNameOverride?: string): string {
  if (tableNameOverride) {
    const meta = getEntityPersistenceMeta(entity);
    return `${quoteIdent(meta.tableSchema)}.${quoteIdent(tableNameOverride)}`;
  }
  return getQualifiedTableName(entity);
}

function qCol(entity: EntityClass, propertyKey: string): string {
  const sql = getColumnName(entity, propertyKey);
  assertValidIdentPart(sql, "columnName");
  return quoteIdent(sql);
}

function qQualifiedField(entity: EntityClass, propertyKey: string, tableNameOverride?: string): string {
  return `${qTable(entity, tableNameOverride)}.${qCol(entity, propertyKey)}`;
}

function hasDeletedAtColumn(entity: EntityClass): boolean {
  const meta = getEntityPersistenceMeta(entity);
  return Boolean(meta.columns["deleted_at"]);
}

class ParamWriter {
  values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

function renderProjection(entity: EntityClass, fields?: FieldProjector[], joins?: JoinExpr[], tableNameOverride?: string): string[] {
  const projections: string[] = [];

  if (fields && fields.length > 0) {
    projections.push(...fields.map((f) => {
      if (f.kind === "expr") {
        return `${f.expr} AS ${quoteIdent(f.alias)}`;
      }
      // Use override table name only when the field's entity matches the base entity
      const useOverride = tableNameOverride && f.field.entity === entity ? tableNameOverride : undefined;
      const t = qTable(f.field.entity, useOverride);
      const c = qCol(f.field.entity, f.field.key);
      const alias = f.alias ?? getColumnName(f.field.entity, f.field.key);
      assertValidIdentPart(alias, "projectionAlias");
      return `${t}.${c} AS ${quoteIdent(alias)}`;
    }));
  } else {
    // Default: all persisted columns from base entity, aliased to TS property name.
    const meta = getEntityPersistenceMeta(entity);
    for (const c of Object.values(meta.columns)) {
      assertValidIdentPart(c.propertyKey, "propertyKey");
      projections.push(`${qTable(entity, tableNameOverride)}.${quoteIdent(c.sqlName)} AS ${quoteIdent(c.propertyKey)}`);
    }
  }

  // Add projections for display_name fields from joined tables (auditable joins).
  if (joins) {
    for (const j of joins) {
      if (j.alias) {
        let fieldName = '';
        if (j.alias === 'creator') fieldName = 'created_by_name';
        else if (j.alias === 'updater') fieldName = 'updated_by_name';
        else if (j.alias === 'deleter') fieldName = 'deleted_by_name';

        if (fieldName) {
          projections.push(`${quoteIdent(j.alias)}.display_name AS ${quoteIdent(fieldName)}`);
        }
      }
    }
  }

  return projections;
}

function renderJoins(joins: JoinExpr[] | undefined, baseEntity?: EntityClass, tableNameOverride?: string): string[] {
  if (!joins || joins.length === 0) return [];
  const out: string[] = [];
  for (const j of joins) {
    // LEFT table (joined entity) should never use the override - it has its own table name
    const leftOverride = undefined;
    // Apply tableName override to the RIGHT table (the base entity being queried)
    const rightOverride = tableNameOverride && j.right.entity === baseEntity ? tableNameOverride : undefined;
    // The JOIN clause uses the LEFT entity's table name (the table we're joining)
    const joinTable = qTable(j.left.entity, leftOverride);
    const aliasClause = j.alias ? ` AS ${quoteIdent(j.alias)}` : '';

    const rightColName = getColumnName(j.right.entity, j.right.key);
    assertValidIdentPart(rightColName, "columnName");
    // Right side should use the base table (not the alias) when it's the base entity
    const rightTableRef = (j.right.entity === baseEntity) ? qTable(j.right.entity, rightOverride) : (j.alias ? quoteIdent(j.alias) : qTable(j.right.entity, rightOverride));
    let rightExpr = `${rightTableRef}.${quoteIdent(rightColName)}`;
    let rightExprRaw = rightExpr; // Keep raw for regex guardrail
    let colMeta = null;

    if (j.options?.castRightTo) {
      rightExpr = `${rightExpr}::${j.options.castRightTo}`;
    } else {
      const meta = getEntityPersistenceMeta(j.right.entity);
      colMeta = meta.columns[rightColName];
      if (colMeta?.castInJoin) {
        rightExpr = `${rightExpr}::${colMeta.castInJoin}`;
      }
    }

    // LEFT side should use the alias (not the table name) when an alias is provided
    const leftTableRef = j.alias ? quoteIdent(j.alias) : qTable(j.left.entity, leftOverride);
    const leftExpr = `${leftTableRef}.${quoteIdent(getColumnName(j.left.entity, j.left.key))}`;
    let leftExprWithCast = leftExpr;

    if (j.options?.castLeftTo) {
      leftExprWithCast = `${leftExpr}::${j.options.castLeftTo}`;
    }

    let onExpr: string;

    if (j.options?.castRightTo === 'uuid' || (colMeta?.castInJoin === 'uuid')) {
      // Use CASE to only cast when the value matches UUID pattern (short-circuit evaluation)
      onExpr = `CASE WHEN ${rightExprRaw} ~ '^[0-9a-fA-F-]{36}$' THEN ${rightExpr} = ${leftExprWithCast} ELSE FALSE END`;
    } else {
      onExpr = `${rightExpr} = ${leftExprWithCast}`;
    }

    out.push(`${j.type} JOIN ${joinTable}${aliasClause} ON ${onExpr}`);
  }
  return out;
}

function renderFilterExpr(w: ParamWriter, f: FilterExpr, baseEntity?: EntityClass, tableNameOverride?: string): string {
  switch (f.kind) {
    case "field_value": {
      const useOverride = tableNameOverride && f.left.entity === baseEntity ? tableNameOverride : undefined;
      const baseLeft = qQualifiedField(f.left.entity, f.left.key, useOverride);
      const left =
        (f.op === "ILIKE" || f.op === "LIKE") && String(f.left.key) === "uuid"
          ? `CAST(${baseLeft} AS text)`
          : baseLeft;
      if (f.op === "IN" || f.op === "NOT IN") {
        const arr = Array.isArray(f.right) ? f.right : [f.right];
        const params = arr.map((v) => w.add(v)).join(", ");
        return `${left} ${f.op} (${params})`;
      }
      if (f.op === "BETWEEN") {
        const arr = Array.isArray(f.right) ? f.right : [f.right];
        if (arr.length === 2) {
          return `${left} BETWEEN ${w.add(arr[0])} AND ${w.add(arr[1])}`;
        }
        throw new Error(`BETWEEN operator requires exactly 2 values, got ${arr.length}`);
      }
      if (f.op === "IS" || f.op === "IS NOT") {
        if (f.right === null) return `${left} ${f.op} NULL`;
        if (f.right === true) return `${left} ${f.op} TRUE`;
        if (f.right === false) return `${left} ${f.op} FALSE`;
        throw new Error(`IS/IS NOT only supports null/boolean (got ${typeof f.right})`);
      }
      if (f.op === "ILIKE" || f.op === "LIKE") {
        return `${left} ${f.op} ${w.add(f.right)} ESCAPE '#'`;
      }
      if (f.op === "!=" || f.op === "<>") {
        return `(${left} IS NULL OR ${left} ${f.op} ${w.add(f.right)})`;
      }
      return `${left} ${f.op} ${w.add(f.right)}`;
    }
    case "field_field": {
      const leftOverride = tableNameOverride && f.left.entity === baseEntity ? tableNameOverride : undefined;
      const rightOverride = tableNameOverride && f.right.entity === baseEntity ? tableNameOverride : undefined;
      const left = qQualifiedField(f.left.entity, f.left.key, leftOverride);
      const right = qQualifiedField(f.right.entity, f.right.key, rightOverride);
      return `${left} ${f.op} ${right}`;
    }
    case "raw":
      return `${f.left} ${f.op} ${f.right}`;
    case "group": {
      const inner = f.filters.map((x) => renderFilterExpr(w, x, baseEntity, tableNameOverride)).join(` ${f.operand} `);
      return `(${inner})`;
    }
  }
}

function renderWhere(
  w: ParamWriter,
  entity: EntityClass,
  deletedRecords: WithDeletedRecords | undefined,
  filters?: FilterExpr[],
  tableNameOverride?: string
): string[] {
  const where: string[] = [];

  if (hasDeletedAtColumn(entity)) {
    const mode = deletedRecords ?? "EXCLUDED";
    const col = `${qTable(entity, tableNameOverride)}.${quoteIdent("deleted_at")}`;
    if (mode === "ONLY") where.push(`${col} IS NOT NULL`);
    if (mode === "EXCLUDED") where.push(`${col} IS NULL`);
  }

  if (filters && filters.length > 0) {
    let first = true;
    let expr = "";
    for (const f of filters) {
      const part = renderFilterExpr(w, f, entity, tableNameOverride);
      if (first) {
        expr = part;
        first = false;
      } else {
        expr = `${expr} ${f.operand} ${part}`;
      }
    }
    if (expr.trim() !== "") where.push(expr);
  }

  return where;
}

function renderOrderBy(entity: EntityClass, sorting?: SortingExpr[], tableNameOverride?: string): string | null {
  if (!sorting || sorting.length === 0) return null;
  const parts = sorting.map((s) => {
    const useOverride = tableNameOverride && s.field.entity === entity ? tableNameOverride : undefined;
    return `${qQualifiedField(s.field.entity, s.field.key, useOverride)} ${s.dir}`;
  });
  return parts.join(", ");
}

export type SelectQueryInput = {
  entity: EntityClass;
  fields?: FieldProjector[];
  joins?: JoinExpr[];
  filters?: FilterExpr[];
  sorting?: SortingExpr[];
  deletedRecords?: WithDeletedRecords;
  limit?: number;
  offset?: number;
  includeTotalRecordsWindow?: boolean;
  /** Override the table name (e.g., for audit trail tables: "customers_audit"). */
  tableName?: string;
};

export function buildSelectQuery(input: SelectQueryInput): SqlQuery {
  const w = new ParamWriter();
  const baseTable = qTable(input.entity, input.tableName);

  const projection = renderProjection(input.entity, input.fields, input.joins, input.tableName);
  if (input.includeTotalRecordsWindow) projection.push(`COUNT(*) OVER() AS ${quoteIdent("_total_records")}`);

  const renderedJoins = renderJoins(input.joins, input.entity, input.tableName);
  const where = renderWhere(w, input.entity, input.deletedRecords, input.filters, input.tableName);
  const orderBy = renderOrderBy(input.entity, input.sorting, input.tableName);

  const parts: string[] = [];
  parts.push(`SELECT ${projection.join(", ")} FROM ${baseTable}`);
  if (renderedJoins.length) parts.push(renderedJoins.join(" "));
  if (where.length) parts.push(`WHERE ${where.join(" AND ")}`);
  if (orderBy) parts.push(`ORDER BY ${orderBy}`);
  if (input.limit !== undefined) parts.push(`LIMIT ${w.add(input.limit)}::int`);
  if (input.offset !== undefined) parts.push(`OFFSET ${w.add(input.offset)}::int`);

  return { text: parts.join(" "), values: w.values };
}
