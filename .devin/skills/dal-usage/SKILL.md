# Skill: DAL Usage

## When to use

- When working with `@primebrick/dal-pg` Repository, entity decorators, or query DSL
- When writing or modifying code that uses the DAL for database access
- When debugging DAL-related issues (type mapping, query generation, bulk ops)

## What it provides

- Complete API reference for the Repository class (finders, writes, bulk ops, streaming)
- Entity decorator usage (`@Entity`, `@Column`, `@Key`, `@Unique`, `@AuditableField`, `@DeletableField`)
- Query DSL usage (field, Filter, Sort, Join, Project)
- Error handling patterns (`NotFoundError`, `MultipleRowsError`, `UnknownColumnError`, `ValidationError`)
- Type mapping rules (bigint, numeric, date/timestamp, jsonb)

## Key conventions

- snake_case everywhere (DB columns, TS properties, JSON)
- `RETURNING *` on all writes
- `throwIfNotFound: true` by default
- `deletedRecords: "EXCLUDED"` by default
- TEMP TABLE strategy for `updateMany` / `upsertMany`
- bigint returned as native `bigint` via `INT8_OID`
- Audit is port-based and optional (fire-and-forget)
- The DAL never commits automatically — wait for explicit user instruction
- Errors are framework-agnostic with stable codes (no HTTP coupling)

## Quick reference

### Define an entity

```typescript
import { Entity, Column, Key, Unique, AuditableField, DeletableField } from "@primebrick/dal-pg";

@Entity("user_account")
export class UserAccount {
  @Key
  @Column({ type: "bigint" })
  id: bigint;

  @Unique("user_account_email_unique")
  @Column({ type: "varchar", length: 255 })
  email: string;

  @Column({ type: "boolean", default: true })
  is_active: boolean;

  @AuditableField
  @Column({ type: "varchar", length: 100 })
  display_name: string;

  @DeletableField
  @Column({ type: "timestamp", nullable: true })
  deleted_at: Date | null;
}
```

### Insert and find

```typescript
const repo = dal.getRepository(UserAccount);

const created = await repo.insert({
  email: "alice@example.com",
  is_active: true,
  display_name: "Alice",
});
// created is the full row (RETURNING *)

const found = await repo.findOne({ email: "alice@example.com" });
// throws NotFoundError by default if no row matches
```

### Query with Filter, Sort, Project

```typescript
const rows = await repo.findMany({
  filter: { is_active: true, deleted_at: null }, // deletedRecords: "EXCLUDED" by default
  sort: { display_name: "asc" },
  project: { id: true, email: true }, // only select these columns
  limit: 50,
  offset: 0,
});
```

### Update and delete

```typescript
const updated = await repo.update(
  { id: created.id },
  { display_name: "Alice 2" },
);
// returns the updated row (RETURNING *)

const deleted = await repo.softDelete({ id: created.id });
// sets deleted_at; returns the row
```

### Bulk upsert via TEMP TABLE

```typescript
const upserted = await repo.upsertMany([
  { email: "a@x.com", display_name: "A" },
  { email: "b@x.com", display_name: "B" },
]);
// uses a temp table + set-based upsert; returns all rows
```

### Streaming large result sets

```typescript
for await (const row of repo.stream({ filter: { is_active: true } })) {
  // row-by-row streaming via pg-query-stream
  console.log(row.id);
}
```

### Error handling

```typescript
import { NotFoundError, MultipleRowsError, UnknownColumnError, ValidationError } from "@primebrick/dal-pg";

try {
  await repo.findOne({ id: 999n });
} catch (err) {
  if (err instanceof NotFoundError) {
    // err.code is a stable string identifier
  }
}
```
