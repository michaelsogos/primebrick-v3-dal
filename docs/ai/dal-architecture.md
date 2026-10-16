# DAL Architecture — @primebrick/dal

Internal architecture, design decisions, and data flow.

## Module structure

```
src/
  meta/               entity metadata + decorators + column PG<->JS coercion
    entity-decorators.ts   @Entity, @Column, @Key, @Unique, @AuditableField, @DeletableField, etc.
    entity-meta.ts         re-export barrel for stable import path
    entity-ts-to-pg.ts     static TS-annotation → PostgreSQL® type resolution (no name rules)
    column-pg-io.ts        JS value ↔ PG parameter/wire value coercion
  query/              query DSL + SQL generation + streaming
    dsl.ts                 field, Filter, Sort, Join, Project (the query DSL)
    query-builder.ts       DSL → parameterized SQL (SELECT only)
    streaming.ts           pg-query-stream wrapper for AsyncIterable
  repository/         the Repository class
    repository.ts          type-driven CRUD, finders, bulk ops
  errors/             framework-agnostic error classes
    errors.ts              DalError, NotFoundError, MultipleRowsError, UnknownColumnError, ValidationError
  types/              public types + entity interfaces
    types.ts               FindOptions, WriteOptions, BulkOptions, AuditPort, LoggerPort, AuditAction
    entities.ts            IExposableEntity, IDeletableEntity, IAuditableEntity, IClonableEntity
  audit/              auditable field types + join helpers
    auditable-types.ts     WithAuditableDisplayNames, WithCreatorDisplayName, WithUpdaterDisplayName
    auditable-joins.ts     buildAuditableJoins, buildAuditableJoinsSelective
  index.ts            public barrel — re-exports everything
```

## Entity metadata system

The DAL uses **legacy TypeScript® decorators** with a `WeakMap` for metadata storage (`reflect-metadata` is still imported — `Entity`/`Key` expose `primebrick:tableName`/`primebrick:keyColumn` via `Reflect.defineMetadata` for external tooling, but nothing reads `design:type` anymore).

### Flow

1. **Class decoration**: `@Entity("table_name")` stores the table name in a `WeakMap<Function, ClassEntityMeta>`.
2. **Property decoration**: `@Column()`, `@Key()`, `@Unique()`, `@AuditableField()`, `@DeletableField()` register column metadata in the same `WeakMap`.
3. **Implicit discovery**: `syncImplicitEntityColumns()` instantiates the class (`new ctor()`) and discovers own enumerable properties. Each discovered property becomes a column (`NOT NULL` by default).
4. **Persistence meta**: `getEntityPersistenceMeta()` produces a serializable `EntityPersistenceMeta` object — the canonical snapshot used by the Repository, query builder, and schema diff tools.

### Type resolution (`entity-ts-to-pg.ts` + `entity-annotation-extract.ts`)

`design:type` runtime inference is **gone** (esbuild/tsx never emit it; Bun
collapses unions). Column types resolve **statically from the TS annotation**
via the TypeScript compiler API (`extractEntityAnnotations`), identical under
every runtime. Resolution order: explicit `pgType` → semantic decorator pin
(`@AuditableField(VERSION)`→int4, `*_AT`→timestamptz) → annotation → `throw`
(never a silent `text` fallback, never a name-based rule).

| TS annotation | PG type |
|---|---|
| `bigint` | `int8` (default for integers) |
| `number` | `float8` (default for reals) |
| `boolean` | `boolean` |
| `string` | `text` (`+length` → `varchar(n)`) |
| `Date` | `timestamptz` |
| `UUID` | `uuid` |
| `ISODate` / `ISOTime` | `date` / `time` |
| `Decimal` | `numeric` (`+precision/scale` → `numeric(p,s)`) |
| `Vector` | `vector` (`+length` → `vector(n)`) |
| `T[]` | `base[]` |
| object shapes | `jsonb` |

An explicit `pgType` must be a canonical `PgColumnType` literal allowed by the
annotation↔pgType whitelist (`primebrick-db check` hard-fails otherwise);
restating the inferred default is a `redundant-pgType` warning; a `*_uuid`
name resolving to non-uuid is a `uuid-name` warning. Unmappable annotations
(functions, tuples, enums) throw — explicit `pgType` is the escape hatch.
The canonical matrix lives in `test/entities/type-matrix-entity.ts` +
`test/type-matrix.test.ts`. New types are a **contract decision — discuss
with the project owner first** (`.devin/rules/entity-type-contract.md`).

### Type modifiers

`@Column({ length })` upgrades `text` → `varchar(n)` and `vector` → `vector(n)`. `@Column({ precision, scale })` upgrades `numeric` → `numeric(p,s)`. Modifiers are never spelled inside the `pgType` string.

## Query builder pipeline

```
DSL input (FilterExpr, SortingExpr, JoinExpr, FieldProjector)
    │
    ▼
buildSelectQuery()
    │
    ├── renderProjection()  →  "table"."col" AS "property_key"
    ├── renderJoins()       →  LEFT JOIN "other" ON ...
    ├── renderWhere()       →  WHERE deleted_at IS NULL AND ...
    ├── renderOrderBy()     →  ORDER BY "table"."col" ASC
    └── ParamWriter         →  $1, $2, ... (parameterized values)
    │
    ▼
SqlQuery { text: string, values: unknown[] }
```

### SQL injection safety

All identifiers (table names, column names, aliases) are validated with `assertValidIdentPart()` — a strict regex `^[A-Za-z_][A-Za-z0-9_]*$`. All values go through `ParamWriter` as `$1, $2, ...` placeholders. Raw filter expressions (`Filter.raw()`) are the only exception — the caller owns safety there.

## Type coercion pipeline (`column-pg-io.ts`)

### JS → PG (outgoing)

Runtime meta cannot see annotations — conversion is driven by explicit
`jsType` markers, semantic pins (`@AuditableField`), and value shape.

```
JS value + hints
    │
    ├── Date                        →  YYYY-MM-DD (ISODate-marked) | ISO string (timestamptz)
    ├── Decimal                     →  plain numeric string ("12.34")
    ├── Vector / number[]           →  "[1,2,3]" literal
    ├── Uint8Array / Buffer         →  \\x hex string
    ├── bigint                      →  "$n" tagged wire (entityToJsonValue)
    └── other                       →  passed through
```

### PG → JS (incoming)

```
PG wire value + hints
    │
    ├── INT8 OID (20)               →  bigint   (ensureTypeParsers)
    ├── NUMERIC OID (1700)          →  string — lossless; jsType:"decimal" hydrates Decimal
    ├── DATE OID (1082)             →  "YYYY-MM-DD" string — no timezone shift
    ├── vector literal              →  Vector (jsType:"vector")
    └── other                       →  passed through
```

### bigint handling

`INT8_OID` → `bigint` via `ensureTypeParsers()` (registered once per process by
the Dal gateway).

### numeric/decimal handling

`NUMERIC_OID` returns **string** — always lossless. `Decimal` entity columns
must declare `@Column({ jsType: "decimal" })` so the hydrator wraps the wire
string into `Decimal` (never `number` — a `number` prop on a `numeric` column
is a whitelist violation anyway).

## Bulk operation strategies

### addMany — batched INSERT

```
rows[] → auto-batch (65535 / columnCount) → INSERT INTO ... VALUES (...), (...), ... RETURNING *
```

Multiple INSERT statements are issued if the batch exceeds the parameter limit. Results are concatenated.

### upsertMany — DISABLED (commented out in source)

Was: `INSERT ... ON CONFLICT (conflictTarget) DO UPDATE` over a TEMP TABLE.
Disabled pending a guarded-vs-sync-import decision: the conflict branch
overwrote unconditionally (no `version` check) — same optimistic-lock
bypass that removed single `upsert`. Reintroduction requires a version
guard or an explicitly-documented unguarded sync mode.

### deleteMany — single UPDATE with ANY()

```
UPDATE table SET deleted_at = $1, deleted_by = $2 WHERE uuid = ANY($3::uuid[])
```

Single statement for all UUIDs — no batching needed.

### updateMany — TEMP TABLE strategy

```
BEGIN
  CREATE TEMP TABLE tmp_update_xxx (uuid uuid, col1 ..., col2 ...) ON COMMIT DROP
  INSERT INTO tmp_update_xxx VALUES (...), (...), ...  (batched)
  UPDATE target_table SET col1 = tmp.col1, col2 = tmp.col2, version = target.version + 1
    FROM tmp_update_xxx tmp
    WHERE target_table.uuid = tmp.uuid
  RETURNING *
COMMIT  (temp table auto-dropped)
```

This is atomic, SQL-injection safe, and scales to millions of rows. The transaction ensures the temp table is always cleaned up.

## Specialized verticals (the DAL is a query builder, not an ORM)

The DAL grows by **vertical query builders**, not by consumer-side raw
SQL. There is no `dal.query()` escape hatch — when a consumer needs an
SQL shape the DSL cannot express, the capability is built here once and
reused by every service.

- **`vectorSearch(entity, field, vec, opts)`** — canonical pgvector
  constructor. Minimal form: `ORDER BY emb <op> $n::vector LIMIT topK`.
  Optional `opts` switch CTE stages ON/OFF: `lexical` (full-text
  `to_tsvector @@ websearch_to_tsquery` candidate CTE + candidate UNION),
  `keywordBoost` (LATERAL `unnest` ILIKE hit counting), `scoreAdjust`
  (CASE-based score modifiers), `oversample`, `filters`, `joins`,
  `fields`, `distance` (`<=>` `<->` `<#>` `<+>` `<~>` `<%>`),
  `deletedRecords`, `tableName`. Everything off = plain nearest neighbor.
- **`Filter.expr(left, op, right)`** — expression operands in filters:
  `{ sql: "to_tsvector(?, d.content)", params: ["simple"] }`. `?`
  placeholders become bound `$n` params — SQL structure is code, values
  are never concatenated. `@@` is a `SqlOperator`.
- **`hardDeleteMany(entity, rows, opts)`** — physical bulk DELETE via the
  same TEMP TABLE strategy as `deleteMany` (`DELETE ... USING tmp`),
  for auditable-but-not-deletable and derived-index tables.
- **`touch` — REMOVED.** It stamped bookkeeping columns
  (`last_seen_at`-style watermarks) with `col = GREATEST(col, $n)`
  and deliberately skipped the `version` check/bump — an auditable
  entity cannot accept a write path that eludes the optimistic lock.
  Watermark writes now go through versioned `update` (find → update
  with the observed `version`, inside the same transaction).

## Audit integration

### Port-based design

The DAL does NOT include an `AuditService` implementation. Instead, it defines an `AuditPort` interface. Consumers inject their own implementation:

```typescript
interface AuditPort {
  writeAudit(params: AuditParams): Promise<void>;
}
```

### Fire-and-forget pattern

Audit calls are never awaited:

```typescript
options.audit?.writeAudit({ ... }).catch((err) => (options.logger ?? noopLogger).error("[DAL Audit Error]", err));
```

This means:
- Audit failures never crash the main operation
- The main operation completes before audit is written
- If no `AuditPort` is injected, audit is silently skipped

### Delta calculation

The DAL includes `calculateDelta()` and `calculateDeltaWithForcedFields()` for computing old→new field differences. The delta is passed to `AuditPort.writeAudit()` as a `Record<string, { old, new }>`.

## Error handling philosophy

### Framework-agnostic

DAL errors extend `DalError` (which extends `Error`) with a stable `code` field. They do NOT contain HTTP status codes, NATS™ error types, or any framework-specific data. Consumers map them at their own boundary:

```typescript
// In the BE router:
catch (err) {
  if (err instanceof NotFoundError) res.status(404).json({ error: err.message });
  if (err instanceof ValidationError) res.status(400).json({ error: err.message });
}
```

### Stable codes

| Error | Code |
|-------|------|
| NotFoundError | `NOT_FOUND` |
| MultipleRowsError | `MULTIPLE_ROWS` |
| UnknownColumnError | `UNKNOWN_COLUMN` |
| ValidationError | `VALIDATION` |

## Design decisions and trade-offs

1. **WeakMap over reflect-metadata keys** — avoids global metadata pollution; each decorator call touches only its own class.
2. **snake_case everywhere** — eliminates DTO transformation between DB and TS. The DB row IS the TS model.
3. **RETURNING \*** — all writes return the full row, so the caller always has the authoritative state (including DB-generated defaults, triggers, sequences).
4. **throwIfNotFound: true by default** — fail-fast is safer than silent null returns. Callers who want null must opt in.
5. **deletedRecords: "EXCLUDED" by default** — soft-deleted rows are invisible unless explicitly requested.
6. **TEMP TABLE for updateMany** — simpler than CASE/WHEN, safer than raw SQL, and scales better than row-by-row updates.
7. **Port-based audit** — the DAL doesn't know about your audit table schema. You inject the writer.
8. **No schema migration tools in the DAL** — migration/diff tools remain in consumer repos (BE, US). The DAL only provides the Repository.

## Partitioning & retention (pg_partman)

### What exists (verified against the live DB)

Every `{table}_audit` trail table is created as a **pg_partman native
RANGE partition parent** on `changed_at`, monthly, `premake = 4`:

```sql
PRIMARY KEY ("id", "changed_at")
) PARTITION BY RANGE ("changed_at");
SELECT partman.create_parent('<schema>.<table>_audit', 'changed_at', 'native', 'monthly');
```

- Emitted by `database-patch-to-sql.ts` (BE + emailsender) for every
  `@AuditTrail()` entity, and hand-written in patch files
  (`0005_create_ai_entity_tables.sql`, `create_ai_cerebellum.sql`).
- `pg_partman` itself is created idempotently by `init_database.sql`.
- `partman.part_config` rows live: `customers_audit`, `role_mappings_audit`,
  `config_entries_audit`, `ai_cerebellum_audit`, `ai_models_audit`
  (~11 partitions each, parent + monthly children + default).
- Reads go through the partition **parent** transparently —
  `audit-query.ts` pages `findByPage` over `{table}_audit` and sees all
  partitions as one table. That is the architecture's intended model:
  the main table serves ~95% of reads; the parent unifies the rest.

### Entity model on partitioned tables

`AuditLogEntity` declares a single logical `@Key() id` even though the
DDL PK is composite `(id, changed_at)` — the composite key is a **DDL
concern only**. The DAL never inspects physical PK arity; `@Key` is the
logical identity used by matchBy/RETURNING. The same trick applies to
any future partitioned main table: entity `@Key() id`, DDL
`PRIMARY KEY (id, <partition_col>)`.

Constraints when partitioning a MAIN table (PG-enforced):

- Every UNIQUE/PK constraint **must include the partition key** →
  `UNIQUE (uuid)` becomes `UNIQUE (uuid, created_at)`; logical
  uniqueness of uuid holds (it is generated), but the constraint no
  longer enforces it DB-side.
- The partition key should be immutable (`created_at`, never
  `updated_at`): UPDATEs that move a row across partitions are legal but
  expensive.
- Filters not involving the partition key don't prune — all partitions
  scan. Fine at append-only-log volumes; reconsider at scale.

### Gaps (verified, all absent today)

- `partman.part_config.retention` is **NULL on every parent** — no
  retention is configured anywhere, and `retention_keep_table = true`
  (default) means retention would DETACH rather than DROP partitions.
- **No maintenance runner**: nothing calls `partman.run_maintenance_proc()`
  — no `pg_cron` (not installed), no service-side scheduled job. Beyond
  `premake`, new partitions are only created on-demand/by default.
- **No row-count axis**: the "keep N rows in the main table, move the
  rest" model has no code anywhere. pg_partman only does time/serial
  intervals — row-count archiving would be a custom mover job, not
  declarative partitioning.
- **No decorators/meta** for partitioning — it is purely DDL-level.
- Partitioning is applied ONLY to `_audit` tables today; no domain/main
  table is partitioned.

### Retention activation path

1. `UPDATE partman.part_config SET retention = '<interval>',
   retention_keep_table = false WHERE parent_table = '<t>';` — partitions
   older than the window are dropped (not detached).
2. Schedule `partman.run_maintenance_proc()` — either `pg_cron`
   (requires `shared_preload_libraries`, unavailable on managed PG) or a
   service-side scheduled job calling `dal.partitionMaintenance(entities)`
   — the sanctioned channel (owns the dedicated client internally;
   consumers never touch `PoolClient`).
3. `pg_partman` must exist in every environment — already created
   idempotently by `init_database.sql`.
