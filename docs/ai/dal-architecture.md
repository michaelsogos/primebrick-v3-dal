# DAL Architecture — @primebrick/dal

Internal architecture, design decisions, and data flow.

## Module structure

```
src/
  meta/               entity metadata + decorators + column PG<->JS coercion
    entity-decorators.ts   @Entity, @Column, @Key, @Unique, @AuditableField, @DeletableField, etc.
    entity-meta.ts         re-export barrel for stable import path
    entity-ts-to-pg.ts     TS design:type → PostgreSQL® type inference
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

The DAL uses **legacy TypeScript® decorators** with a `WeakMap` for metadata storage (not `reflect-metadata` keys, though `reflect-metadata` is imported for `design:type` access).

### Flow

1. **Class decoration**: `@Entity("table_name")` stores the table name in a `WeakMap<Function, ClassEntityMeta>`.
2. **Property decoration**: `@Column()`, `@Key()`, `@Unique()`, `@AuditableField()`, `@DeletableField()` register column metadata in the same `WeakMap`.
3. **Implicit discovery**: `syncImplicitEntityColumns()` instantiates the class (`new ctor()`) and discovers own enumerable properties. Each discovered property becomes a column with an inferred PG type.
4. **Persistence meta**: `getEntityPersistenceMeta()` produces a serializable `EntityPersistenceMeta` object — the canonical snapshot used by the Repository, query builder, and schema diff tools.

### Type inference (`entity-ts-to-pg.ts`)

When `emitDecoratorMetadata` is enabled, `Reflect.getMetadata("design:type")` returns the constructor function (e.g. `String`, `Number`, `Date`). The DAL uses this plus naming heuristics:

| TS design type | SQL name pattern | Inferred PG type |
|----------------|------------------|------------------|
| `Number` | `id` (key) | `bigint` |
| `Number` | `version` | `integer` |
| `Number` | other | `integer` |
| `Boolean` | any | `boolean` |
| `Date` | any | `timestamptz` |
| `String` | `uuid` | `uuid` |
| `String` | `*_at` | `timestamptz` |
| `String` | other | `text` |
| (none) | `uuid` | `uuid` |
| (none) | `id` (key) | `bigint` |
| (none) | `*_at` | `timestamptz` |
| (none) | `*_by` | `text` |

Explicit `@Column({ pgType })` always wins over inference.

### Type modifiers

`@Column({ length })` upgrades `text` → `varchar(n)`. `@Column({ precision, scale })` upgrades to `numeric(p,s)`.

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

```
JS value + ColumnPgPersistenceHints
    │
    ├── Date + pgType "date"        →  YYYY-MM-DD string
    ├── Date + pgType "timestamptz" →  Date (passed through to node-pg)
    ├── string + date-like column   →  parse to Date, then recurse
    └── other                       →  passed through
```

### PG → JS (incoming)

```
PG wire value + ColumnPgPersistenceHints
    │
    ├── date-like column + string   →  new Date(string)
    ├── date-like column + Date     →  Date (already)
    └── other                       →  passed through
```

### bigint handling

PostgreSQL® `bigint` columns return as native JS `bigint` (not strings) when the `pg` module is configured with the `INT8_OID` type parser. The DAL expects consumers to configure this in their pool setup:

```typescript
import pg from "pg";
pg.types.setTypeParser(pg.types.builtins.INT8, (val: string) => BigInt(val));
```

### numeric/decimal handling

- `numeric(15,2)` → returns as `number` (safe within `Number.MAX_SAFE_INTEGER`)
- `numeric(38,0)` → returns as `string` (overflows `Number.MAX_SAFE_INTEGER`)

The DAL does NOT auto-convert — it returns what `node-pg` gives it. Consumers should configure type parsers or handle the conversion at the entity level.

## Bulk operation strategies

### addMany — batched INSERT

```
rows[] → auto-batch (65535 / columnCount) → INSERT INTO ... VALUES (...), (...), ... RETURNING *
```

Multiple INSERT statements are issued if the batch exceeds the parameter limit. Results are concatenated.

### upsertMany — batched INSERT ... ON CONFLICT

Same as addMany but with `ON CONFLICT (conflictTarget) DO UPDATE SET ...`. Audit-aware: `created_at`/`created_by` preserved, `updated_at`/`updated_by` stamped, `version` incremented.

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
