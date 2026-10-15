/**
 * `PgColumnType` — the canonical PostgreSQL column type vocabulary for
 * `@Column({ pgType })` and the entity type contract.
 *
 * A closed union, not a free `string`: aliases like
 * `"timestamp with time zone"` (write `timestamptz`) or `"character varying"`
 * (write `varchar`) are compile errors, so the diff/snapshot pipeline never
 * sees spelling variants.
 *
 * Type modifiers are NEVER written inside `pgType`: `varchar(N)` comes from
 * `length`, `numeric(p,s)` from `precision`/`scale`, `vector(N)` from
 * `length` on a `Vector` prop. `pgType` carries the BASE name only
 * (`vector(N)` literal is allowed for readability but `length` wins).
 */
export type PgScalarType =
  // text family
  | "text" | "varchar" | "char" | "citext" | "uuid"
  // integer family (both spellings accepted, canonicalised internally)
  | "smallint" | "int2" | "integer" | "int" | "int4" | "bigint" | "int8"
  // float / exact numeric
  | "real" | "float4" | "double precision" | "float8" | "numeric" | "decimal"
  // boolean
  | "boolean" | "bool"
  // date & time
  | "date" | "time" | "timetz" | "timestamp" | "timestamptz" | "interval"
  // network
  | "inet" | "cidr" | "macaddr" | "macaddr8"
  // documents / binary / misc
  | "json" | "jsonb" | "bytea" | "xml" | "tsvector";

/** `pgType` values legal in `@Column({ pgType })`. */
export type PgColumnType = PgScalarType | `${PgScalarType}[]` | `vector(${number})` | "vector";
