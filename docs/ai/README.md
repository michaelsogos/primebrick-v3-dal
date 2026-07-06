# AI Documentation — @primebrick/dal-pg

This directory contains AI-first documentation for the Primebrick Data Access Layer library.

## Documents

- [dal-usage-guide.md](./dal-usage-guide.md) — Complete method-by-method guide to the Repository API
- [dal-architecture.md](./dal-architecture.md) — Internal architecture, design decisions, and data flow
- [dal-testing.md](./dal-testing.md) — How to write and run tests against the DAL

## Quick reference

The DAL provides a `Repository` class that reads entity metadata at runtime to generate parameterized SQL. Entities are plain TS classes decorated with `@Entity`, `@Column`, `@Key`, `@Unique`, `@AuditableField`, `@DeletableField`.

```typescript
import { Repository, Entity, Key, Unique, Column, AuditableField, DeletableField, AuditableFieldType, DeletableFieldType } from "@primebrick/dal-pg";

@Entity("my_table")
class MyEntity {
  @Key() id!: number;
  @Unique() uuid!: string;
  @Column({ pgType: "varchar", length: 255 }) name!: string;
  @AuditableField(AuditableFieldType.CREATED_AT) created_at!: Date;
  @DeletableField(DeletableFieldType.DELETED_AT) deleted_at?: Date;
}

const repo = new Repository(pool);
const row = await repo.add(MyEntity, { name: "test" }, { actor: "user1" });
```

## Key conventions

- **snake_case everywhere** — DB columns, TS properties, JSON responses
- **RETURNING \*** on all writes — the DB returns the full row
- **throwIfNotFound: true** by default on all finders
- **deletedRecords: "EXCLUDED"** by default — soft-deleted rows excluded
- **TEMP TABLE strategy** for updateMany / upsertMany
- **bigint via INT8_OID** — native bigint, not strings
