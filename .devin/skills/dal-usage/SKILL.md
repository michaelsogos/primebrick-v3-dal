# Skill: DAL Usage

## When to use

- When working with `@primebrick/dal-pg` Dal gateway, Repository, entity decorators, or query DSL
- When writing or modifying code that uses the DAL for database access
- When debugging DAL-related issues (type mapping, query generation, bulk ops, pool throttling)

## What it provides

- Dal gateway: `getDal()` singleton factory, pool ownership, type-parser registration, best-practice defaults
- Complete API reference for the Repository class (finders, writes, bulk ops, streaming)
- Entity decorator usage (`@Entity`, `@Column`, `@Key`, `@Unique`, `@AuditableField`, `@DeletableField`)
- Query DSL usage (field, Filter, Sort, Join, Project)
- Error handling patterns (`NotFoundError`, `MultipleRowsError`, `UnknownColumnError`, `ValidationError`)
- Type mapping rules (bigint, numeric, date/timestamp, jsonb)
- Per-call timeout override for bulk ops and long queries

## Key conventions

- snake_case everywhere (DB columns, TS properties, JSON)
- `RETURNING *` on all writes
- `throwIfNotFound: true` by default
- `deletedRecords: "EXCLUDED"` by default
- TEMP TABLE strategy for `updateMany` / `addMany` (`upsertMany` is disabled)
- `upsert`/`upsertMany` are removed — never reintroduce (no version guard)
- Transactions: `dal.transaction(txRepo => …)` only — `withClient` is private;
  consumers never see `PoolClient` or write raw SQL
- Health/version probe: `dal.serverVersion()` (no `ping()` — the call IS the probe)
- Physical reset: `dal.truncate(entity)` / `repo.truncate` (domain-guarded)
- bigint returned as native `bigint` via INT8_OID (registered by the Dal gateway)
- Audit is port-based and optional (fire-and-forget)
- The DAL never commits automatically — wait for explicit user instruction
- Errors are framework-agnostic with stable codes (no HTTP coupling)
- `statement_timeout` (default 30s) is the primary anti-throttling measure for high-async REST traffic

## Quick reference

### Bootstrap the Dal gateway (singleton)

```typescript
import { getDal } from "@primebrick/dal-pg";

// once at startup:
const dal = getDal({
  connectionString: process.env.DATABASE_URL!,
  schema: "myapp",
  max: 10,
  statementTimeoutMs: 30000,
  applicationName: "my-app",
});

// graceful shutdown:
process.on("SIGTERM", async () => { await dal.close(); process.exit(0); });
```

The Dal gateway owns the pool, registers type parsers (INT8 → bigint, NUMERIC → number/string), and sets `search_path`/`statement_timeout`/`application_name` on every connection. No per-request allocation — the singleton is reused.

### Define an entity

```typescript
import { Entity, Column, Key, Unique, AuditableField, DeletableField, AuditableFieldType, DeletableFieldType } from "@primebrick/dal-pg";

@Entity("user_account")
export class UserAccount {
  @Key() id!: number;

  @Unique() uuid!: string;

  @Column({ length: 255, nullable: false }) email!: string;

  @Column({ nullable: false }) display_name!: string;

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
const created = await dal.add(UserAccount, {
  email: "alice@example.com",
  display_name: "Alice",
}, { actor: "system" });
// created is the full row (RETURNING *)

const found = await dal.findByUUID(UserAccount, created.uuid);
// throws NotFoundError by default if no row matches
```

### Query with Filter, Sort

```typescript
import { Filter, field, Sort } from "@primebrick/dal-pg";

const rows = await dal.findAll(UserAccount, null, {
  filters: [
    Filter.fieldValue(field(UserAccount, "display_name"), "=", "Alice"),
  ],
  sorting: [Sort.by(field(UserAccount, "display_name"), "ASC")],
});
// deletedRecords: "EXCLUDED" by default
```

### Update and delete

```typescript
const updated = await dal.update(
  UserAccount,
  created.uuid,
  { display_name: "Alice 2" },
  { actor: "system" },
);
// returns the updated row (RETURNING *)

const deleted = await dal.delete(UserAccount, created.uuid, { actor: "system" });
// soft-deletes (sets deleted_at); returns the row
```

### Bulk ops with timeout override

```typescript
await dal.addMany(UserAccount, [
  { email: "a@x.com", display_name: "A" },
  { email: "b@x.com", display_name: "B" },
], { actor: "system", timeoutMs: 60000 });
// timeoutMs emits SET LOCAL statement_timeout inside the tx (no leakage)

// upsert / upsertMany are REMOVED by design — they bypassed optimistic
// locking (no version check on conflict). Never reintroduce them: the
// standard is find (uuid + version) then add / update.
```

### Streaming large result sets

```typescript
const stream = await dal.findAll(UserAccount, null, { stream: true }) as AsyncIterable<UserAccount>;
for await (const row of stream) {
  // row-by-row streaming via pg-query-stream (cursor FETCH per batch)
  // each FETCH is bounded by the session statement_timeout — safe for large sets
  console.log(row.id);
}
```

### Transactions with dal.transaction

```typescript
await dal.transaction(async (txRepo) => {
  // txRepo is a tx-scoped Repository — the raw PoolClient is never exposed
  await txRepo.add(UserAccount, { email: "tx@x.com", display_name: "TX" }, { actor: "tx" });
  // COMMIT on return, ROLLBACK on throw — never manual BEGIN/COMMIT.
});

// Timeout override (SET LOCAL — transaction-scoped, no leakage):
await dal.transaction(async (txRepo) => { /* ... */ }, { timeoutMs: 120000 });

// dal.withClient is PRIVATE to dal-pg internals — not a consumer API.
// No consumer ever holds a PoolClient or issues raw SQL.
```

### Error handling

```typescript
import { NotFoundError, MultipleRowsError, UnknownColumnError, ValidationError } from "@primebrick/dal-pg";

try {
  await dal.findByUUID(UserAccount, "nonexistent-uuid");
} catch (err) {
  if (err instanceof NotFoundError) {
    // err.code === "NOT_FOUND"
  }
}
```
