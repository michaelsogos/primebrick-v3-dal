# DAL Usage Guide — @primebrick/dal-pg

Complete method-by-method reference for the Dal gateway and Repository API.

## Table of contents

0. [Dal gateway (getDal)](#dal-gateway-getdal)
1. [Finders](#finders)
2. [Write operations](#write-operations)
3. [Bulk operations](#bulk-operations)
4. [Streaming](#streaming)
5. [Query DSL](#query-dsl)
6. [Entity decorators](#entity-decorators)
7. [Errors](#errors)
8. [Audit ports](#audit-ports)

---

## Dal gateway (getDal)

The `Dal` class is the high-level gateway that owns the `pg.Pool`, registers type parsers, and enforces best-practice pool defaults. It delegates all CRUD/bulk/finder methods to an internal `Repository(pool)` instance. Consumers should use `getDal()` (singleton) as the primary entry point.

### `getDal(config?)` — singleton factory

Returns the process-wide singleton `Dal` instance. Creates it on first call.

```typescript
import { getDal } from "@primebrick/dal-pg";

// once at startup:
const dal = getDal({
  connectionString: process.env.DATABASE_URL!,
  schema: "emailsender",
  max: 10,
  statementTimeoutMs: 30000,
  applicationName: "primebrick-emailsender",
});

// per request — no allocation, reuse the singleton:
const config = await dal.find(EmailConfigEntity, null, { ... });

// graceful shutdown (consumer calls this from signal handlers — see below):
await dal.close(); // close(timeoutMs?) — default 10s timeout
```

**DalConfig options:**

| Option | Default | Description |
|--------|---------|-------------|
| `connectionString` | (required) | PostgreSQL® connection string |
| `schema` | undefined | Schema to set as `search_path` on every connection |
| `max` | `10` | Maximum pool size. Formula: `max ≤ (PG max_connections − reserved) / service_instances` |
| `statementTimeoutMs` | `30000` | Per-statement timeout (ms). The full wall-clock: command arrival → server completion → all rows transmitted. Set to `0` to disable. |
| `connectionTimeoutMillis` | `5000` | Time to wait when acquiring a connection before erroring (fail fast) |
| `idleTimeoutMillis` | `30000` | How long an idle connection is kept before closing |
| `maxUses` | undefined | Recycle connections after N uses (optional) |
| `applicationName` | `"primebrick-dal"` | PG-side observability — shows up in `pg_stat_activity` |

**Singleton rules:**
- First call: requires `config`, creates the singleton.
- Subsequent calls with no config: returns the existing instance.
- Subsequent calls with same `connectionString`: returns the existing instance.
- Subsequent calls with different `connectionString`: throws.
- For multi-DB: use `new Dal(config)` directly (bypasses the singleton).
- `resetDal()` closes and clears the singleton (for tests).

### `dal.withClient(fn, options?)` — transactions & per-call timeout

Acquires a dedicated client from the pool, optionally sets a per-connection `statement_timeout`, runs `fn(client)`, and releases the client (resetting the timeout).

```typescript
// Transaction:
await dal.withClient(async (client) => {
  await client.query("BEGIN");
  // ... operations ...
  await client.query("COMMIT");
});

// Repository backed by the client (for tx-participating DAL ops):
import { Repository } from "@primebrick/dal-pg";
await dal.withClient(async (client) => {
  const repo = new Repository(client);
  await client.query("BEGIN");
  await repo.add(MyEntity, { ... }, { actor: "tx" });
  await client.query("COMMIT");
});

// Per-call timeout override (for ad-hoc long queries):
await dal.withClient(
  async (client) => {
    await client.query("SELECT * FROM large_table");
  },
  { timeoutMs: 120000 }, // 2 minutes for this one query
);
```

### `dal.close(timeoutMs?)` — graceful shutdown

Drains the pool (`pool.end()`) with a timeout deadline.

- **Re-entrant**: concurrent calls return immediately (the first call wins).
- **Timeout**: if `pool.end()` doesn't complete within `timeoutMs`, the promise resolves anyway (default: 10000ms). The pool is left to be reaped by the OS/TCP stack.
- **Error containment**: if `pool.end()` throws, the error is logged and swallowed — the caller (typically a signal handler) cannot do anything useful with it.
- **No process handlers**: the library does NOT install `process.on(...)` handlers. Process lifecycle (signals, crash handlers, Sentry) is a consumer-side concern. The consumer closes ALL long-lived resources (DAL pool, NATS™, HTTP server) together.

```typescript
// consumer-side shutdown (NOT in the library — the consumer owns process lifecycle):
async function shutdown(reason: string, code: number) {
  await Promise.allSettled([
    dal.close(),               // drains pg.Pool (10s internal timeout)
    natsConnection?.close(),   // drains NATS™
  ]);
  process.exit(code);
}

process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGINT",  () => shutdown("SIGINT", 130));
```

### `dal.getPool()` — raw pool access

Exposes the underlying `pg.Pool` for tooling that needs raw access (e.g. schema snapshot/migration tools). Not for normal application code.

### `statement_timeout` semantics

`statement_timeout` measures the **full wall-clock** from command arrival to server completion, **including transmitting all result rows to the client** (verified from PostgreSQL® docs + pgsql-hackers). It is NOT preparation time only.

**Impact per operation:**
- Normal CRUD: 30s is plenty.
- Bulk ops (`addMany`, `upsertMany`, `updateMany`): use `options.timeoutMs` to override per-call (emits `SET LOCAL statement_timeout` inside the transaction).
- `findAll` non-streamed on large sets: **HIGH risk** — the entire result is one statement. Use `stream: true` instead.
- `findAll` streamed (`stream: true`): **safe** — cursor `FETCH` per batch, each bounded by the session default individually.

---

## Finders

### `findById(entity, id, options?)`

Returns a single row by primary key.

```typescript
const row = await repo.findById(MyEntity, 42);
// throws NotFoundError if not found (default)

const row = await repo.findById(MyEntity, 42, { throwIfNotFound: false });
// returns null if not found

const row = await repo.findById(MyEntity, 42, { deletedRecords: "ONLY" });
// returns only soft-deleted rows
```

**Options:**
- `throwIfNotFound` (default: `true`) — throw `NotFoundError` if zero rows
- `deletedRecords` (default: `"EXCLUDED"`) — `"EXCLUDED"` | `"ONLY"` | `"INCLUDED"`

**Throws:**
- `NotFoundError` — when `throwIfNotFound` is true and row doesn't exist
- `MultipleRowsError` — when more than 1 row matches (shouldn't happen with PK)

---

### `findByUUID(entity, uuid, options?)`

Returns a single row by UUID column.

```typescript
const row = await repo.findByUUID(MyEntity, "550e8400-e29b-41d4-a716-446655440000");
```

Same options and errors as `findById`.

---

### `find(entity, fields?, options?)`

Returns the first matching row based on filters.

```typescript
import { field, Filter } from "@primebrick/dal-pg";

const row = await repo.find(MyEntity, null, {
  filters: [Filter.fieldValue(field(MyEntity, "name"), "=", "Alice")],
  sorting: [Sort.by(field(MyEntity, "created_at"), "DESC")],
  deletedRecords: "EXCLUDED",
});
```

**Options:**
- `filters` — array of `FilterExpr` (see Query DSL)
- `sorting` — array of `SortingExpr`
- `joins` — array of `JoinExpr`
- `deletedRecords` — `"EXCLUDED"` | `"ONLY"` | `"INCLUDED"`
- `stream` — boolean (use streaming for findAll, not find)

**Throws:**
- `NotFoundError` — when no rows match (default behavior)

---

### `findAll(entity, fields?, options?)`

Returns all matching rows. Supports streaming.

```typescript
const rows = await repo.findAll(MyEntity);
// returns TEntity[]

const rows = await repo.findAll(MyEntity, null, {
  filters: [Filter.fieldValue(field(MyEntity, "status"), "=", "active")],
  sorting: [Sort.by(field(MyEntity, "name"), "ASC")],
});
```

With streaming:

```typescript
const stream = await repo.findAll(MyEntity, null, { stream: true });
for await (const row of stream) {
  console.log(row);
}
```

---

### `findByPage(entity, page, recordsPerPage, fields?, options?)`

Returns paginated results with total count.

```typescript
const result = await repo.findByPage(MyEntity, 1, 25);
// result.entities: TEntity[]
// result.total_records: number

const result = await repo.findByPage(MyEntity, 2, 25, null, {
  filters: [Filter.fieldValue(field(MyEntity, "status"), "=", "active")],
  sorting: [Sort.by(field(MyEntity, "name"), "ASC")],
});
```

**Throws:**
- `ValidationError` — when `page < 1` or `recordsPerPage < 1`

---

### `count(entity)`

Returns total row count (including soft-deleted).

```typescript
const total = await repo.count(MyEntity);
```

---

## Write operations

All write operations require `WriteOptions`:

```typescript
type WriteOptions = {
  actor: string;        // stamped into created_by/updated_by/deleted_by
  audit?: AuditPort;    // optional audit writer
  logger?: LoggerPort;  // optional logger
};
```

### `add(entity, row, options)`

Inserts a single row. Returns the full row via `RETURNING *`.

```typescript
const inserted = await repo.add(
  MyEntity,
  { name: "Alice", description: "Test user" },
  { actor: "admin" }
);
// inserted.id, inserted.uuid, inserted.created_at, etc. are populated
```

**Auto-stamping:** If the entity has auditable fields (`@AuditableField`), the DAL automatically stamps:
- `created_at` / `updated_at` → `now()`
- `created_by` / `updated_by` → `options.actor`
- `version` → `1`

**Throws:**
- `ValidationError` — when no columns to insert (all undefined)
- `UnknownColumnError` — when a property is not in entity metadata

---

### `upsert(entity, row, options)`

Insert or update on conflict. Returns the full row.

```typescript
const result = await repo.upsert(
  MyEntity,
  { uuid: existingUuid, name: "Updated Name" },
  { actor: "admin", conflictTarget: "uuid" }
);
```

**Conflict behavior (audit-aware):**
- `created_at` / `created_by` are **preserved** on conflict (not overwritten)
- `updated_at` / `updated_by` are stamped with `now()` / `options.actor`
- `version` is incremented by 1
- The conflict target column itself is not updated

---

### `update(entity, uuid, updates, options)`

Updates a single row by UUID. Returns the full updated row.

```typescript
const updated = await repo.update(
  MyEntity,
  uuid,
  { name: "New Name", description: "New desc" },
  { actor: "admin" }
);
```

**Auto-stamping:** `updated_at`, `updated_by`, and `version` are automatically updated.

**Throws:**
- `NotFoundError` — when uuid not found
- `ValidationError` — when no fields to update
- `UnknownColumnError` — when a property is not in entity metadata

---

### `delete(entity, uuid, options)` — soft delete

Soft-deletes a row by UUID. Sets `deleted_at`, `deleted_by`, increments `version`.

```typescript
const deleted = await repo.delete(MyEntity, uuid, { actor: "admin" });
// deleted.deleted_at is a Date, deleted.deleted_by is "admin"
```

**Throws:**
- `NotFoundError` — when uuid not found
- `Error` — when entity has no `@DeletableField`

---

### `restore(entity, uuid, options)`

Restores a soft-deleted row. Clears `deleted_at`, `deleted_by`, increments `version`.

```typescript
const restored = await repo.restore(MyEntity, uuid, { actor: "admin" });
// restored.deleted_at is null, restored.deleted_by is null
```

---

### `hardDelete(entity, uuid, options)`

Permanently removes the row from the database.

```typescript
await repo.hardDelete(MyEntity, uuid, { actor: "admin" });
```

**Throws:**
- `NotFoundError` — when uuid not found

---

## Bulk operations

### `addMany(entity, rows, options)`

Bulk insert with auto-batching. Returns all inserted rows.

```typescript
const rows = [
  { name: "Alice" },
  { name: "Bob" },
  { name: "Charlie" },
];
const inserted = await repo.addMany(MyEntity, rows, { actor: "admin" });
// inserted.length === 3
```

**Auto-batching:** The batch size is auto-calculated to stay under PostgreSQL®'s 65535 parameter limit. Override with `options.batchSize`.

**Empty input:** Returns `[]` silently (no error).

---

### `upsertMany(entity, rows, options)`

Bulk upsert with conflict handling. Returns all rows (inserted + updated).

```typescript
const result = await repo.upsertMany(
  MyEntity,
  rows,
  { actor: "admin", conflictTarget: "uuid" }
);
```

**Options:**
- `conflictTarget` (default: `"uuid"`) — column name for ON CONFLICT
- `batchSize` — override auto-batch size

**Audit-aware ON CONFLICT:** Same rules as single `upsert` — `created_at`/`created_by` preserved, `updated_at`/`updated_by` stamped, `version` incremented.

---

### `deleteMany(entity, uuids, options)`

Soft-deletes multiple rows by UUID array.

```typescript
const deleted = await repo.deleteMany(
  MyEntity,
  [uuid1, uuid2, uuid3],
  { actor: "admin" }
);
```

Uses `WHERE uuid = ANY($1::uuid[])` for a single UPDATE.

---

### `updateMany(entity, updates, options)` — TEMP TABLE strategy

Bulk update using a temporary table for performance and safety.

```typescript
const updates = [
  { uuid: uuid1, name: "New Name 1" },
  { uuid: uuid2, name: "New Name 2" },
];
const result = await repo.updateMany(MyEntity, updates, { actor: "admin" });
```

**Strategy:**
1. `BEGIN` transaction
2. `CREATE TEMP TABLE ... ON COMMIT DROP`
3. Batched `INSERT INTO temp_table`
4. Single `UPDATE target_table SET ... FROM temp_table WHERE ...`
5. `COMMIT` (temp table is automatically dropped)

This is atomic, SQL-injection safe, and scales to millions of rows.

**Throws:**
- `ValidationError` — when no columns to update (only uuid provided)

---

## Streaming

Use `findAll` with `{ stream: true }` for large result sets:

```typescript
const stream = await repo.findAll(MyEntity, null, { stream: true });

for await (const row of stream) {
  // Process one row at a time — no buffering
  console.log(row.uuid);
}
```

The stream uses `pg-query-stream` under the hood. The result is an `AsyncIterable`, not an array.

---

## Query DSL

### Fields

```typescript
import { field } from "@primebrick/dal-pg";

const nameField = field(MyEntity, "name");
```

### Filters

```typescript
import { Filter, field } from "@primebrick/dal-pg";

// Field = value
Filter.fieldValue(field(MyEntity, "name"), "=", "Alice")

// IN clause
Filter.fieldValue(field(MyEntity, "status"), "IN", ["active", "pending"])

// IS NULL
Filter.fieldValue(field(MyEntity, "deleted_at"), "IS", null)

// LIKE / ILIKE
Filter.fieldValue(field(MyEntity, "name"), "ILIKE", "%alice%")

// BETWEEN
Filter.fieldValue(field(MyEntity, "age"), "BETWEEN", [18, 65])

// Field = Field (compare two columns)
Filter.fieldField(field(MyEntity, "created_by"), "=", field(MyEntity, "updated_by"))

// Raw SQL (caller owns safety)
Filter.raw("EXTRACT(YEAR FROM created_at)", "=", "2024")

// Group with OR
Filter.group([
  Filter.fieldValue(field(MyEntity, "name"), "=", "Alice"),
  Filter.fieldValue(field(MyEntity, "name"), "=", "Bob"),
], "OR")
```

**Operators:** `=`, `!=`, `<>`, `<`, `<=`, `>`, `>=`, `ILIKE`, `LIKE`, `IN`, `NOT IN`, `BETWEEN`, `IS`, `IS NOT`

**Operands:** `AND` (default), `OR` — controls how consecutive filters are joined

### Sorting

```typescript
import { Sort, field } from "@primebrick/dal-pg";

Sort.by(field(MyEntity, "name"), "ASC")
Sort.by(field(MyEntity, "created_at"), "DESC")
```

### Joins

```typescript
import { Join, field } from "@primebrick/dal-pg";

Join.on(
  field(UserEntity, "uuid"),     // right side
  field(MyEntity, "created_by"), // left side
  "LEFT",                        // INNER | LEFT | RIGHT
  { castRightTo: "text", castLeftTo: "text", alias: "creator" }
)
```

### Projection

```typescript
import { Project, field } from "@primebrick/dal-pg";

Project.field(field(MyEntity, "name"))
Project.field(field(MyEntity, "name"), "display_name")
Project.expr("COUNT(*)", "total")
```

---

## Entity decorators

### `@Entity(tableName?)`

Maps a class to a DB table. If no name is given, the class name is used.

```typescript
@Entity("customers")
class CustomerEntity { ... }
```

### `@Key(options?)`

Marks the primary key column. Only one per entity.

```typescript
@Key()
id!: number;

@Key({ generated: "manual" })
custom_id!: number;
```

### `@Unique()`

Marks a column with a unique constraint.

```typescript
@Unique()
uuid!: string;
```

### `@Column(options)`

Overrides SQL name, PG type, nullability, length, precision, scale, default, or join cast.

```typescript
@Column({ pgType: "varchar", length: 255 })
name!: string;

@Column({ pgType: "numeric", precision: 15, scale: 2 })
price!: number;

@Column({ pgType: "date })
birth_date!: Date;

@Column({ sqlName: "short_name" })
displayName!: string;
```

### `@AuditableField(type)`

Marks a field as an audit column. Types: `CREATED_AT`, `CREATED_BY`, `UPDATED_AT`, `UPDATED_BY`, `VERSION`.

```typescript
@AuditableField(AuditableFieldType.CREATED_AT)
created_at!: Date;

@AuditableField(AuditableFieldType.VERSION)
version!: number;
```

### `@DeletableField(type)`

Marks a field as soft-delete. Types: `DELETED_AT`, `DELETED_BY`.

```typescript
@DeletableField(DeletableFieldType.DELETED_AT)
deleted_at?: Date;
```

### `@CloneField()`

Marks a field as clone tracking (stores source UUID on clone).

### `@AuditTrail()`

Class decorator — marks the entity as having an audit trail table.

### `@IsNotColumn()`

Excludes a property from persistence metadata and DAL queries.

---

## Errors

All DAL errors extend `DalError` with a stable `code` field:

| Error | Code | When |
|-------|------|------|
| `NotFoundError` | `NOT_FOUND` | Finder returns zero rows and `throwIfNotFound` is true |
| `MultipleRowsError` | `MULTIPLE_ROWS` | Single-row finder returns >1 row |
| `UnknownColumnError` | `UNKNOWN_COLUMN` | Write op receives a property not in entity metadata |
| `ValidationError` | `VALIDATION` | Invalid input (empty updates, page < 1, etc.) |

```typescript
import { NotFoundError, ValidationError } from "@primebrick/dal-pg";

try {
  await repo.findByUUID(MyEntity, uuid);
} catch (err) {
  if (err instanceof NotFoundError) {
    // handle not found
  }
}
```

---

## Audit ports

The DAL uses **ports** (interfaces) for audit and logging. If no port is injected, audit/logging is silently skipped.

```typescript
import { AuditPort, AuditAction, LoggerPort } from "@primebrick/dal-pg";

const myAudit: AuditPort = {
  async writeAudit(params) {
    // params: { entityClassName, tableName, entityId, entityUuid, action, changedAt, version, changedBy, delta }
    await myAuditStore.save(params);
  }
};

const myLogger: LoggerPort = {
  error(msg, ...args) { console.error(msg, ...args); },
  warn(msg, ...args) { console.warn(msg, ...args); },
  info(msg, ...args) { console.info(msg, ...args); },
};

await repo.add(MyEntity, { name: "test" }, {
  actor: "admin",
  audit: myAudit,
  logger: myLogger,
});
```

Audit calls are **fire-and-forget** — the DAL calls `.catch(logger?.error ?? noop)` on the audit promise, so audit failures never crash the main operation.
