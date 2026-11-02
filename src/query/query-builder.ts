import type { EntityClass } from "../meta/entity-meta.js";
import { getColumnName, getEntityPersistenceMeta, getTableName, getQualifiedTableName } from "../meta/entity-meta.js";

import type { FieldProjector, FieldRef, FilterExpr, GroupByOperand, JoinExpr, SortingExpr } from "./dsl.js";
import type { WithDeletedRecords } from "../types/types.js";

export type SqlQuery = { text: string; values: unknown[] };

function assertValidIdentPart(s: string, what: string): void {
  // Keep it strict to avoid SQL injection through identifiers.
  // Allow: letters, digits, underscore; must start with letter or underscore.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) {
    // standards-exempt: ext-json — error-message quoting of an identifier (no @primebrick/sdk dep)
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

const VECTOR_OPS = new Set(["<=>", "<->", "<#>", "<+>", "<~>", "<%>"]);

function toVectorLiteral(v: unknown): string {
  if (Array.isArray(v)) return `[${v.join(",")}]`;
  return String(v);
}

/**
 * Renders a parameterized `ExprOperand` — `?` markers become `$n` bound
 * params in order of appearance. The `sql` template is a trusted literal;
 * only `params` carry data.
 */
function renderExprOperand(w: ParamWriter, o: { sql: string; params?: unknown[] }): string {
  let i = 0;
  return o.sql.replace(/\?/g, () => {
    if (i >= (o.params?.length ?? 0)) {
      throw new Error(`expr operand has more '?' markers than params: ${o.sql}`);
    }
    return w.add(o.params![i++]);
  });
}

function renderProjection(entity: EntityClass, fields: FieldProjector[] | undefined, joins: JoinExpr[] | undefined, tableNameOverride: string | undefined, w: ParamWriter): string[] {
  const projections: string[] = [];

  if (fields && fields.length > 0) {
    projections.push(...fields.map((f) => {
      if (f.kind === "expr") {
        return `${renderExprOperand(w, { sql: f.expr, params: f.params })} AS ${quoteIdent(f.alias)}`;
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
  // COALESCE falls back to the raw actor column so "system" / orphan uuids
  // still render instead of NULL.
  if (joins) {
    for (const j of joins) {
      if (j.alias) {
        let fieldName = '';
        if (j.alias === 'creator') fieldName = 'created_by_name';
        else if (j.alias === 'updater') fieldName = 'updated_by_name';
        else if (j.alias === 'deleter') fieldName = 'deleted_by_name';

        if (fieldName) {
          const actorCol = getColumnName(j.right.entity, j.right.key);
          const actorRef = `${qTable(j.right.entity, j.right.entity === entity ? tableNameOverride : undefined)}.${quoteIdent(actorCol)}`;
          projections.push(
            `COALESCE(${quoteIdent(j.alias)}.display_name, ${actorRef}) AS ${quoteIdent(fieldName)}`
          );
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
      if (VECTOR_OPS.has(f.op)) {
        // Vector distance predicate — the operand is serialized to the
        // '[v1,v2,…]' literal and bound with an explicit ::vector cast.
        return `${left} ${f.op} ${w.add(toVectorLiteral(f.right))}::vector`;
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
    case "expr": {
      const left = renderExprOperand(w, f.left);
      const right = renderExprOperand(w, f.right);
      return `${left} ${f.op} ${right}`;
    }
    case "group": {
      const inner = f.filters.map((x) => renderFilterExpr(w, x, baseEntity, tableNameOverride)).join(` ${f.connector ?? f.operand} `);
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

function renderOrderBy(entity: EntityClass, sorting: SortingExpr[] | undefined, tableNameOverride: string | undefined, w: ParamWriter): string | null {
  if (!sorting || sorting.length === 0) return null;
  const parts = sorting.map((s) => {
    if ("kind" in s && s.kind === "alias") {
      assertValidIdentPart(s.alias, "sortAlias");
      return `${quoteIdent(s.alias)} ${s.dir}`;
    }
    if ("kind" in s && s.kind === "expr") {
      return `${renderExprOperand(w, { sql: s.sql, params: s.params })} ${s.dir}`;
    }
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
  /**
   * GROUP BY columns. When set, every non-aggregate projected field is
   * automatically added to the GROUP BY (base-entity columns via the
   * provided/default projection, and joined `*_by_name` display columns) —
   * correctness-by-construction: PostgreSQL requires projected non-aggregate
   * columns to appear in GROUP BY, and grouping the PK already covers the
   * whole base row via functional dependency.
   */
  groupBy?: GroupByOperand[];
  /**
   * pgvector nearest-neighbour ordering. When set, the query ends with
   * `ORDER BY <field> <op> $n::vector` (the query vector is always a bound
   * parameter — required for HNSW/ivfflat index usage) and, when
   * `scoreAlias` is set, projects a score column:
   * `<=>` (cosine) → `1 - (<field> <=> $n) AS <scoreAlias>`;
   * other ops → `(<field> <op> $n) AS <scoreAlias>` (raw distance, lower =
   * closer).
   */
  vectorOrder?: {
    field: FieldRef<any, any>;
    op: "<=>" | "<->" | "<#>" | "<+>";
    /** pgvector literal, e.g. `'[0.1,0.2,…]'` — bound as a parameter. */
    vectorLiteral: string;
    scoreAlias?: string;
  };
  /**
   * HAVING conditions on aggregates. Rendered through the same FilterExpr
   * machinery as WHERE — use `Filter.raw("COUNT(u.id)", ">", "0")` or
   * `Filter.group([...], "AND")` for aggregate predicates. Joined with the
   * per-expression operand, same as filters.
   */
  having?: FilterExpr[];
};

/**
 * Render the GROUP BY column list. Correctness-by-construction: every
 * non-aggregate projected field is auto-added — explicit `groupBy` refs,
 * `field` projectors, the default all-columns projection (when `fields` is
 * omitted), and the `*_by_name` display columns emitted by auditable joins.
 * Aggregate projectors (`Project.expr`) are never grouped.
 */
function renderGroupBy(input: SelectQueryInput, w: ParamWriter): string[] {
  if (!input.groupBy || input.groupBy.length === 0) return [];
  const cols = new Set<string>();

  for (const g of input.groupBy) {
    if ("kind" in g && g.kind === "expr") {
      cols.add(renderExprOperand(w, { sql: g.sql, params: g.params }));
      continue;
    }
    const f = g as FieldRef<any, any>;
    const override = f.entity === input.entity ? input.tableName : undefined;
    cols.add(qQualifiedField(f.entity, f.key, override));
  }

  if (input.fields && input.fields.length > 0) {
    for (const f of input.fields) {
      if (f.kind !== "field") continue;
      const override = f.field.entity === input.entity ? input.tableName : undefined;
      cols.add(qQualifiedField(f.field.entity, f.field.key, override));
    }
  } else {
    const meta = getEntityPersistenceMeta(input.entity);
    for (const c of Object.values(meta.columns)) {
      cols.add(`${qTable(input.entity, input.tableName)}.${quoteIdent(c.sqlName)}`);
    }
  }

  // Auditable-join display columns are projected as `<alias>.display_name`
  // (see renderProjection) — they must be grouped too.
  if (input.joins) {
    for (const j of input.joins) {
      if (j.alias === "creator" || j.alias === "updater" || j.alias === "deleter") {
        cols.add(`${quoteIdent(j.alias)}.display_name`);
      }
    }
  }

  return [...cols];
}

function renderHaving(w: ParamWriter, input: SelectQueryInput): string | null {
  if (!input.having || input.having.length === 0) return null;
  let first = true;
  let expr = "";
  for (const f of input.having) {
    const part = renderFilterExpr(w, f, input.entity, input.tableName);
    if (first) {
      expr = part;
      first = false;
    } else {
      expr = `${expr} ${f.operand} ${part}`;
    }
  }
  return expr.trim() !== "" ? expr : null;
}

export function buildSelectQuery(input: SelectQueryInput): SqlQuery {
  const w = new ParamWriter();
  const baseTable = qTable(input.entity, input.tableName);

  // The vector param is bound first so the score projection and the ORDER
  // BY share the same `$n::vector` placeholder.
  const vecParam = input.vectorOrder ? w.add(input.vectorOrder.vectorLiteral) : null;

  const projection = renderProjection(input.entity, input.fields, input.joins, input.tableName, w);
  if (input.vectorOrder?.scoreAlias) {
    const vf = qQualifiedField(input.vectorOrder.field.entity, input.vectorOrder.field.key, input.tableName);
    const score =
      input.vectorOrder.op === "<=>"
        ? `1 - (${vf} <=> ${vecParam}::vector)`
        : `(${vf} ${input.vectorOrder.op} ${vecParam}::vector)`;
    projection.push(`${score} AS ${quoteIdent(input.vectorOrder.scoreAlias)}`);
  }
  if (input.includeTotalRecordsWindow) projection.push(`COUNT(*) OVER() AS ${quoteIdent("_total_records")}`);

  const renderedJoins = renderJoins(input.joins, input.entity, input.tableName);
  const where = renderWhere(w, input.entity, input.deletedRecords, input.filters, input.tableName);
  const groupBy = renderGroupBy(input, w);
  const having = renderHaving(w, input);
  const orderBy = input.vectorOrder
    ? `${qQualifiedField(input.vectorOrder.field.entity, input.vectorOrder.field.key, input.tableName)} ${input.vectorOrder.op} ${vecParam}::vector`
    : renderOrderBy(input.entity, input.sorting, input.tableName, w);

  const parts: string[] = [];
  parts.push(`SELECT ${projection.join(", ")} FROM ${baseTable}`);
  if (renderedJoins.length) parts.push(renderedJoins.join(" "));
  if (where.length) parts.push(`WHERE ${where.join(" AND ")}`);
  if (groupBy.length) parts.push(`GROUP BY ${groupBy.join(", ")}`);
  if (having) parts.push(`HAVING ${having}`);
  if (orderBy) parts.push(`ORDER BY ${orderBy}`);
  if (input.limit !== undefined) parts.push(`LIMIT ${w.add(input.limit)}::int`);
  if (input.offset !== undefined) parts.push(`OFFSET ${w.add(input.offset)}::int`);

  return { text: parts.join(" "), values: w.values };
}

// ── Hybrid vector search builder ────────────────────────────────────────────
//
// `buildVectorSearchQuery` is the DAL's vertical "perfect query" builder for
// pgvector retrieval: one canonical SQL shape whose optional channels each
// turn a CTE/projection on or off. With every channel off it degenerates to
// the plain `vectorOrder` path (`buildSelectQuery`); the channels are:
//
//   lexical      → `lex` CTE (to_tsvector @@ websearch_to_tsquery) UNIONed
//                  into the candidate set + `lexical_score`/`lexical_match`
//   keywordBoost → `CROSS JOIN LATERAL unnest($terms)` counting ILIKE hits
//                  over the given fields → `keyword_hits`
//   scoreAdjust  → CASE expression added to the final score
//   oversample   → inner-channel LIMIT = topK * oversample
//
// Final ordering is always `score = similarity + Σ boosts DESC` — re-ranking
// after candidate collection, so lexical-only hits can surface.
export type VectorHybridInput = {
  entity: EntityClass;
  /** Vector field + distance op + bound literal — always required. */
  field: FieldRef<any, any>;
  op: "<=>" | "<->" | "<#>" | "<+>";
  vectorLiteral: string;
  topK: number;
  /** Inner-channel row budget = topK * oversample (default 1). */
  oversample?: number;
  filters?: FilterExpr[];
  fields?: FieldProjector[];
  deletedRecords?: WithDeletedRecords;
  /** Override the table name (e.g., for audit trail tables). */
  tableName?: string;
  /** Full-text lexical channel — OFF by default. */
  lexical?: {
    /** Column to index with `to_tsvector` (e.g. `field(E,"content")`). */
    field: FieldRef<any, any>;
    /** Search string — bound param, fed to `websearch_to_tsquery`. */
    query: string;
    /** Text-search configuration — default `"simple"` (no stemming). */
    config?: string;
    /** Weight of `lexical_score` in the final score — default 0. */
    boost?: number;
    /** Threshold for the `lexical_match` flag — default 0.05. */
    minScore?: number;
  };
  /** Keyword-hit lateral count — OFF by default. */
  keywordBoost?: {
    terms: string[];
    /** Fields ILIKE-matched against every term. */
    fields: FieldRef<any, any>[];
    /** Weight of `keyword_hits` in the final score — default 0. */
    boost?: number;
  };
  /** CASE-based score adjustment on an expression (e.g.
   *  `{ expr: "d.metadata->>'content_type'", map: { tutorial: 0.08 } }`). */
  scoreAdjust?: { expr: string; map: Record<string, number>; fallback?: number };
};

export function buildVectorSearchQuery(input: VectorHybridInput): SqlQuery {
  const w = new ParamWriter();
  const meta = getEntityPersistenceMeta(input.entity);
  const pkCol = Object.values(meta.columns).find((c) => c.isKey);
  if (!pkCol) throw new Error(`vectorSearch hybrid: entity has no @Key column`);
  const pk = pkCol.sqlName;
  const baseTable = qTable(input.entity, input.tableName);
  const vf = qQualifiedField(input.field.entity, input.field.key, input.tableName);
  const op = input.op;
  const over = Math.max(1, input.oversample ?? 1);

  // Bound params — the query vector is bound once and shared by the vec CTE,
  // the ORDER BY, and the COALESCE similarity fallback for lex-only rows.
  const vecParam = w.add(input.vectorLiteral);
  const topKParam = w.add(input.topK);
  const overParam = w.add(over);
  const simExpr = op === "<=>"
    ? `1 - (${vf} <=> ${vecParam}::vector)`
    : `(${vf} ${op} ${vecParam}::vector)`;

  const whereParts = renderWhere(w, input.entity, input.deletedRecords, input.filters, input.tableName);
  const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  const ctes: string[] = [];
  ctes.push(
    `vec AS (SELECT ${baseTable}.${quoteIdent(pk)}, ${simExpr} AS similarity FROM ${baseTable} ${whereSql} ORDER BY ${vf} ${op} ${vecParam}::vector LIMIT ${topKParam}::int * ${overParam}::int)`
  );

  const lex = input.lexical;
  if (lex) {
    const cfg = w.add(lex.config ?? "simple");
    const lq = w.add(lex.query);
    const lexCol = qQualifiedField(lex.field.entity, lex.field.key, input.tableName);
    ctes.push(
      `lex AS (SELECT ${baseTable}.${quoteIdent(pk)}, ts_rank_cd(to_tsvector(${cfg}, ${lexCol}), websearch_to_tsquery(${cfg}, ${lq})) AS lexical_score FROM ${baseTable} ${whereSql ? `${whereSql} AND` : "WHERE"} to_tsvector(${cfg}, ${lexCol}) @@ websearch_to_tsquery(${cfg}, ${lq}) ORDER BY lexical_score DESC LIMIT ${topKParam}::int * ${overParam}::int)`
    );
    ctes.push(`candidates AS (SELECT ${quoteIdent(pk)} FROM vec UNION SELECT ${quoteIdent(pk)} FROM lex)`);
  }

  // FROM/JOIN shape: with a lexical channel candidates come from the UNION;
  // without it they are exactly the vec rows.
  const fromSql = lex
    ? `FROM candidates c JOIN ${baseTable} ON ${baseTable}.${quoteIdent(pk)} = c.${quoteIdent(pk)} LEFT JOIN vec v ON v.${quoteIdent(pk)} = ${baseTable}.${quoteIdent(pk)} LEFT JOIN lex l ON l.${quoteIdent(pk)} = ${baseTable}.${quoteIdent(pk)}`
    : `FROM vec v JOIN ${baseTable} ON ${baseTable}.${quoteIdent(pk)} = v.${quoteIdent(pk)}`;

  // Projection: default all entity columns (or the provided projectors),
  // then the channel-specific score columns.
  const projection: string[] = [];
  if (input.fields && input.fields.length > 0) {
    for (const f of input.fields) {
      if (f.kind === "expr") {
        projection.push(`${renderExprOperand(w, { sql: f.expr, params: f.params })} AS ${quoteIdent(f.alias)}`);
      } else {
        const t = qTable(f.field.entity, f.field.entity === input.entity ? input.tableName : undefined);
        const alias = f.alias ?? getColumnName(f.field.entity, f.field.key);
        assertValidIdentPart(alias, "projectionAlias");
        projection.push(`${t}.${qCol(f.field.entity, f.field.key)} AS ${quoteIdent(alias)}`);
      }
    }
  } else {
    for (const c of Object.values(meta.columns)) {
      projection.push(`${baseTable}.${quoteIdent(c.sqlName)} AS ${quoteIdent(c.propertyKey)}`);
    }
  }

  const simSelect = lex ? `COALESCE(v.similarity, ${simExpr})` : `v.similarity`;
  const simAlias = input.op === "<=>" ? "similarity" : "distance";
  projection.push(`${simSelect} AS ${quoteIdent(simAlias)}`);

  const scoreTerms = [simSelect];
  if (lex) {
    const minScore = w.add(lex.minScore ?? 0.05);
    projection.push(`COALESCE(l.lexical_score, 0)::float8 AS ${quoteIdent("lexical_score")}`);
    projection.push(`(v.${quoteIdent(pk)} IS NULL AND COALESCE(l.lexical_score, 0) >= ${minScore}) AS ${quoteIdent("lexical_match")}`);
    if (lex.boost && lex.boost !== 0) {
      scoreTerms.push(`${w.add(lex.boost)}::float8 * COALESCE(l.lexical_score, 0)`);
    }
  }

  const kw = input.keywordBoost;
  let fromSqlKw = "";
  if (kw && kw.terms.length > 0) {
    const termsParam = w.add(kw.terms);
    const ilikes = kw.fields.map((f) => {
      const t = qTable(f.entity, f.entity === input.entity ? input.tableName : undefined);
      return `${t}.${qCol(f.entity, f.key)} ILIKE '%' || kw || '%'`;
    });
    projection.push(`k.keyword_hits`);
    if (kw.boost && kw.boost !== 0) {
      scoreTerms.push(`${w.add(kw.boost)}::float8 * COALESCE(k.keyword_hits, 0)`);
    }
    fromSqlKw = `CROSS JOIN LATERAL (SELECT COUNT(*)::int AS keyword_hits FROM unnest(${termsParam}::text[]) AS kw WHERE ${ilikes.join(" OR ")}) k`;
  }
  const fromSqlFull = `${fromSql}${fromSqlKw ? ` ${fromSqlKw}` : ""}`;

  const adj = input.scoreAdjust;
  if (adj && Object.keys(adj.map).length > 0) {
    const whens = Object.entries(adj.map)
      .map(([k, v]) => `WHEN ${w.add(k)}::text THEN ${w.add(v)}::float8`)
      .join(" ");
    scoreTerms.push(`(CASE ${adj.expr} ${whens} ELSE ${w.add(adj.fallback ?? 0)}::float8 END)::float8`);
  }

  projection.push(`${scoreTerms.join(" + ")} AS ${quoteIdent("score")}`);

  const text = [
    `WITH ${ctes.join(", ")}`,
    `SELECT ${projection.join(", ")}`,
    fromSqlFull,
    `ORDER BY ${quoteIdent("score")} DESC`,
    `LIMIT ${topKParam}::int`,
  ].join(" ");

  return { text, values: w.values };
}
