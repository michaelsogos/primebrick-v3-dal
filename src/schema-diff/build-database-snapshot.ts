import { type SchemaColumnMeta, type SchemaSnapshot, tableKey } from "./schema-types.js";

/** Minimal queryable shape — pg.Pool, pg.PoolClient, or any adapter. */
export interface SnapshotQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

type PgColRow = {
  column_name: string;
  ordinal_position: number;
  is_nullable: boolean;
  typname: string;
  type_oid: number;
  typcategory: string;
  format_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
};

/** Primary key columns (one query per schema batch). */
async function loadPrimaryKeyColumns(
  db: SnapshotQueryable,
  schema: string,
  tableNames: string[]
): Promise<Set<string>> {
  if (tableNames.length === 0) return new Set();
  const r = await db.query<{ schema: string; table: string; col: string }>(
    `SELECT n.nspname AS schema, c.relname AS "table", a.attname AS col
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
     WHERE i.indisprimary
       AND n.nspname = $1
       AND c.relname = ANY ($2::text[])`,
    [schema, tableNames]
  );
  const set = new Set<string>();
  for (const row of r.rows) {
    set.add(`${row.schema}.${row.table}.${row.col}`);
  }
  return set;
}

/**
 * Introspect given tables into the same {@link SchemaSnapshot} shape as entities.
 * Uses `pg_attribute` / `pg_type` / `format_type` (pg-diff-api CatalogApi style) so PostGIS
 * and other UDTs surface with real `typname` / `typcategory`, not only `information_schema.data_type`.
 *
 * The caller owns the connection: pass a Pool (read-only fan-out) or a reserved client.
 */
export async function buildDatabaseSnapshot(
  db: SnapshotQueryable,
  tables: { schema: string; name: string }[],
  generatedAt = new Date().toISOString()
): Promise<SchemaSnapshot> {
  const bySchema = new Map<string, string[]>();
  for (const t of tables) {
    const list = bySchema.get(t.schema) ?? [];
    list.push(t.name);
    bySchema.set(t.schema, list);
  }

  const pkQualified = new Set<string>();
  for (const [schema, names] of bySchema) {
    const uniq = [...new Set(names)];
    const pks = await loadPrimaryKeyColumns(db, schema, uniq);
    for (const pk of pks) pkQualified.add(pk);
  }

  const out: SchemaSnapshot["tables"] = {};
  for (const { schema, name } of tables) {
    const existsR = await db.query<{ oid: string }>(
      `SELECT c.oid::text AS oid
       FROM pg_catalog.pg_class c
       INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1::name
         AND c.relname = $2::name
         AND c.relkind IN ('r', 'p')
       LIMIT 1`,
      [schema, name]
    );
    if ((existsR.rowCount ?? existsR.rows.length) === 0) {
      continue;
    }

    const { rows } = await db.query<PgColRow>(
      `SELECT
         a.attname AS column_name,
         a.attnum AS ordinal_position,
         NOT a.attnotnull AS is_nullable,
         t.typname,
         t.oid AS type_oid,
         t.typcategory,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS format_type,
         CASE
           WHEN t.typname IN ('numeric', 'decimal') AND a.atttypmod > 0
             THEN ((a.atttypmod - 4) >> 16)::int
         END AS numeric_precision,
         CASE
           WHEN t.typname IN ('numeric', 'decimal') AND a.atttypmod > 0
             THEN ((a.atttypmod - 4) & 65535)::int
         END AS numeric_scale
       FROM pg_catalog.pg_attribute a
       INNER JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       INNER JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
       WHERE n.nspname = $1::name
         AND c.relname = $2::name
         AND c.relkind IN ('r', 'p')
         AND a.attnum > 0
         AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [schema, name]
    );
    const key = tableKey(schema, name);
    const columns: Record<string, SchemaColumnMeta> = {};
    for (const row of rows) {
      const isPk = pkQualified.has(`${schema}.${name}.${row.column_name}`);
      columns[row.column_name] = {
        name: row.column_name,
        ordinalPosition: row.ordinal_position,
        dataType: row.typname,
        typname: row.typname,
        typeOid: row.type_oid,
        typcategory: row.typcategory,
        formatType: row.format_type,
        numericPrecision: row.numeric_precision,
        numericScale: row.numeric_scale,
        isNullable: row.is_nullable,
        isPrimaryKey: isPk,
      };
    }
    // secondary indexes (non-PK) — matched by constraint/index name downstream
    const { rows: idxRows } = await db.query<{
      name: string; using: string; is_unique: boolean; def: string;
    }>(
      `SELECT c.relname AS name, am.amname AS using, i.indisunique AS is_unique,
              pg_get_indexdef(i.indexrelid) AS def
       FROM pg_index i
       JOIN pg_class c  ON c.oid  = i.indexrelid
       JOIN pg_am am    ON am.oid = c.relam
       JOIN pg_class t  ON t.oid  = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = $2 AND NOT i.indisprimary`,
      [schema, name]
    );
    const indexes = idxRows.map((r) => ({
      name: r.name,
      using: r.using,
      isUnique: r.is_unique,
      // column list parsed from pg_get_indexdef's "( ... )" section — best effort,
      // name-identity is the authoritative match anyway
      columns: parseIndexColumns(r.def),
      where: parseIndexPredicate(r.def),
      definition: r.def,
    }));

    // foreign keys
    const { rows: fkRows } = await db.query<{
      name: string; column: string; ref_schema: string; ref_table: string;
      ref_column: string; on_delete: string; on_update: string;
    }>(
      `SELECT con.conname AS name, a.attname AS column,
              rn.nspname AS ref_schema, rc.relname AS ref_table, ra.attname AS ref_column,
              con.confdeltype AS on_delete, con.confupdtype AS on_update
       FROM pg_constraint con
       JOIN pg_class c     ON c.oid  = con.conrelid
       JOIN pg_namespace n ON n.oid  = c.relnamespace
       JOIN pg_class rc    ON rc.oid = con.confrelid
       JOIN pg_namespace rn ON rn.oid = rc.relnamespace
       JOIN pg_attribute a  ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
       JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = con.confkey[1]
       WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2`,
      [schema, name]
    );
    const fkAction = (code: string) =>
      ({ a: "no_action", r: "restrict", c: "cascade", n: "set_null", d: "set_default" })[code] ?? code;
    const foreignKeys = fkRows.map((r) => ({
      name: r.name,
      column: r.column,
      refSchema: r.ref_schema,
      refTable: r.ref_table,
      refColumn: r.ref_column,
      onDelete: fkAction(r.on_delete),
      onUpdate: fkAction(r.on_update),
    }));

    out[key] = {
      kind: "table",
      schema,
      name,
      columns,
      ...(indexes.length ? { indexes } : {}),
      ...(foreignKeys.length ? { foreignKeys } : {}),
    };
  }

  return { version: 1, generatedAt, source: "database", tables: out };
}

/** Extract "(a, b)" column list from pg_get_indexdef output (best effort). */
function parseIndexColumns(def: string): string[] {
  const m = /\(([^)]*)\)/.exec(def);
  if (!m) return [];
  return m[1]!
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, "").replace(/\s+(asc|desc|nulls\s+\w+|opclass.*)$/i, ""))
    .filter(Boolean);
}

/** Extract WHERE predicate from a partial index definition. */
function parseIndexPredicate(def: string): string | undefined {
  const m = /\bWHERE\s+(.+)$/is.exec(def);
  return m?.[1]?.trim();
}
