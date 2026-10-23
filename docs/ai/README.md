# AI Documentation — @primebrick/dal-pg

This directory contains AI-first documentation for the Primebrick Data Access Layer library.

## Documents

- [dev-server.md](./dev-server.md) — Dev-server lifecycle & process ownership (library variant — no dev server; owns its builds/tests)
- [env-policy.md](./env-policy.md) — Closed environment policy — no `.env`; DB config lives in `config_entries`
- [enforcement-over-verification.md](./enforcement-over-verification.md) — Enforcement-over-verification doctrine — behavior enforced by code/types/builders, tests prove it
- [dal-usage-guide.md](./dal-usage-guide.md) — Complete method-by-method guide to the Repository API
- [dal-architecture.md](./dal-architecture.md) — Internal architecture, design decisions, and data flow
- [dal-testing.md](./dal-testing.md) — How to write and run tests against the DAL

## Quick reference

The DAL provides a `Repository` class that reads entity metadata at runtime to generate parameterized SQL. Entities are plain TS classes decorated with `@Entity`, `@Column`, `@Key`, `@Unique`, `@AuditableField`, `@DeletableField`.

```typescript
import { Entity, Key, Unique, Column, EntityBase, Auditable, Deletable } from "@primebrick/dal-pg";

@Entity("my_table")
class MyEntity extends Deletable(Auditable(EntityBase)) {
  @Key() id!: bigint;
  @Unique() uuid!: UUID;
  @Column({ length: 255 }) name!: string;
}

const row = await dal.add(MyEntity, { name: "test" }, { actor: "user1" });
```

## Key conventions

- **snake_case everywhere** — DB columns, TS properties, JSON responses
- **RETURNING \*** on all writes — the DB returns the full row
- **throwIfNotFound: true** by default on all finders
- **deletedRecords: "EXCLUDED"** by default — soft-deleted rows excluded
- **TEMP TABLE strategy** for updateMany / upsertMany
- **bigint via INT8_OID** — native bigint, not strings

| File | Role |
|------|------|
| [`always-check-rules-first.md`](./always-check-rules-first.md) | Always Check Rules Before Action |
| [`code-guardrails.md`](./code-guardrails.md) | Code Execution Guardrails |
| [`cross-repo-release-order.md`](./cross-repo-release-order.md) | Cross-Repo Release Ordering |
| [`dal-conventions.md`](./dal-conventions.md) | DAL Conventions |
| [`data-model-conventions.md`](./data-model-conventions.md) | Data Model Conventions |
| [`docs-audience.md`](./docs-audience.md) | Documentation Audience (3 tiers) |
| [`docs-dev-guide.md`](./docs-dev-guide.md) | Developer Documentation |
| [`docs-order.md`](./docs-order.md) | Documentation Page Order |
| [`docs-pipeline.md`](./docs-pipeline.md) | Documentation Pipeline (trigger-based, end to end) |
| [`docs-sync-on-close.md`](./docs-sync-on-close.md) | Sync Docs on GitFlow Close |
| [`entity-type-contract.md`](./entity-type-contract.md) | Entity Type Contract |
| [`file-operations.md`](./file-operations.md) | File Operations |
| [`package-versioning.md`](./package-versioning.md) | Fixed Package Versions (No Ranges) |
| [`temp-files.md`](./temp-files.md) | Temporary Files Location |
| [`verify-file-creation.md`](./verify-file-creation.md) | Verify File Creation (Prevent Truncated Filename Bug) |
| [`workflow.md`](./workflow.md) | Devin Workflow Rule: Tic-Toc Planning |
