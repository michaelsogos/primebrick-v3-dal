# DAL Usage Skill

## When to use

- When working with `@primebrick/dal-pg` Repository, entity decorators, or query DSL
- When writing or modifying code that uses the DAL for database access
- When debugging DAL-related issues (type mapping, query generation, bulk ops)
- When writing tests against the DAL

## What it provides

- Complete API reference for the Repository class (finders, writes, bulk ops, streaming)
- Entity decorator usage (`@Entity`, `@Column`, `@Key`, `@Unique`, `@AuditableField`, `@DeletableField`)
- Query DSL usage (`field`, `Filter`, `Sort`, `Join`, `Project`)
- Error handling patterns (`NotFoundError`, `MultipleRowsError`, `UnknownColumnError`, `ValidationError`)
- Type mapping rules (bigint, numeric, date/timestamp, jsonb)

## Key conventions

- **snake_case everywhere** — DB columns, TS properties, JSON responses
- **RETURNING \*** on all writes — the DB returns the full row
- **throwIfNotFound: true** by default on all finders
- **deletedRecords: "EXCLUDED"** by default — soft-deleted rows excluded
- **TEMP TABLE strategy** for `updateMany` / `addMany` (`upsert`/`upsertMany` REMOVED — no version guard; never reintroduce)
- **Transactions** via `dal.transaction(txRepo => …)` only — `withClient`/`PoolClient` are internal; no consumer raw SQL
- **Health probe** is `dal.serverVersion()` (no `ping()`); physical reset is `dal.truncate(entity)` (domain-guarded)
- **Audit is port-based and optional** — inject `AuditPort` only if needed
- **Errors are framework-agnostic** — stable `code` field, no HTTP coupling
- **LEAF dependency** — MUST NOT import from `primebrick-be-v3` or `primebrick-us-v3`

## Quick reference

### Define an entity

```typescript
import { Entity, Key, Unique, Column, AuditableField, DeletableField, AuditableFieldType, DeletableFieldType } from "@primebrick/dal-pg";

@Entity("my_table")
class MyEntity {
  @Key() id!: bigint;
  @Unique() uuid!: UUID;
  @Column({ length: 255 }) name!: string;
  @Column({ nullable: true }) description?: string | null;
  @AuditableField(AuditableFieldType.CREATED_AT) created_at!: Date;
  @AuditableField(AuditableFieldType.CREATED_BY) created_by!: string;
  @AuditableField(AuditableFieldType.UPDATED_AT) updated_at!: Date;
  @AuditableField(AuditableFieldType.UPDATED_BY) updated_by!: string;
  @AuditableField(AuditableFieldType.VERSION) version!: number;
  @DeletableField(DeletableFieldType.DELETED_AT) deleted_at?: Date;
  @DeletableField(DeletableFieldType.DELETED_BY) deleted_by?: string;
}
```

### Insert and find

```typescript
// Repository is sealed — use the Dal proxies directly:

// Insert
const row = await dal.add(MyEntity, { name: "test" }, { actor: "user1" });

// Find by PK
const byId = await dal.findById(MyEntity, row.id);

// Find by UUID
const byUuid = await dal.findByUUID(MyEntity, row.uuid);

// Find with filters (returns null with throwIfNotFound: false)
const found = await dal.find(MyEntity, null, {
  filters: [Filter.fieldValue(field(MyEntity, "name"), "=", "test")],
});
```

### Query with Filter, Sort, Project

```typescript
import { field, Filter, Sort, Project } from "@primebrick/dal-pg";

const rows = await dal.findAll(MyEntity,
  [Project.field(field(MyEntity, "name")), Project.field(field(MyEntity, "uuid"))],
  {
    filters: [
      Filter.fieldValue(field(MyEntity, "name"), "ILIKE", "%test%"),
      Filter.group([
        Filter.fieldValue(field(MyEntity, "status"), "=", "active"),
        Filter.fieldValue(field(MyEntity, "status"), "=", "pending"),
      ], "OR"),
    ],
    sorting: [Sort.by(field(MyEntity, "created_at"), "DESC")],
    deletedRecords: "EXCLUDED",
  }
);
```

### Update and delete

```typescript
// Update
const updated = await dal.update(MyEntity, uuid, { name: "new name" }, { actor: "user1" });

// Soft delete
const deleted = await dal.delete(MyEntity, uuid, { actor: "user1" });

// Restore
const restored = await dal.restore(MyEntity, uuid, { actor: "user1" });

// Hard delete
await dal.hardDelete(MyEntity, uuid, { actor: "user1" });
```

### Bulk insert (TEMP TABLE)

```typescript
const rows = [{ name: "a" }, { name: "b" }, { name: "c" }];
const result = await dal.addMany(MyEntity, rows, { actor: "user1" });
// upsert/upsertMany are removed — find (uuid+version) then add/update.
```

### Streaming

```typescript
const stream = await dal.findAll(MyEntity, null, { stream: true });
for await (const row of stream) {
  console.log(row.uuid);
}
```

### Error handling

```typescript
import { NotFoundError, ValidationError } from "@primebrick/dal-pg";

try {
  await dal.findByUUID(MyEntity, uuid);
} catch (err) {
  if (err instanceof NotFoundError) {
    // 404 in HTTP layer
  } else if (err instanceof ValidationError) {
    // 400 in HTTP layer
  }
}
```

## Anti-patterns to avoid

- ❌ Don't create DTO classes that rename fields between DB and TS — use snake_case everywhere
- ❌ Don't add `|| "default"` fallbacks on the read path — return what the DB has
- ❌ Don't lowercase/uppercase/trim on the read path — only at the write path
- ❌ Don't import from `primebrick-be-v3` or `primebrick-us-v3` — the DAL is a leaf dependency
- ❌ Don't use camelCase for entity properties — use snake_case
- ❌ Don't call `repo.add()` without `{ actor }` in options — actor is required for audit stamping
