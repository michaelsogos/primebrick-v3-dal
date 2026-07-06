# AI AGENT INSTRUCTIONS - @primebrick/dal

## ⚠️ CRITICAL: NEVER COMMIT AUTOMATICALLY

**AI agents MUST NEVER commit changes without explicit user instruction.**

- **WAIT for the user to explicitly tell you to commit** before running any `git commit` command
- This applies to ALL situations - no exceptions
- See [docs/gitflow.md](./docs/gitflow.md) for complete GitFlow rules including commit rules

## Repository overview

`@primebrick/dal-pg` is a shared Data Access Layer library for Primebrick v3. It provides a type-driven, metadata-based `Repository` for PostgreSQL. Entities are plain TS classes with decorators (`@Entity`, `@Column`, `@Key`, `@Unique`, `@AuditableField`, `@DeletableField`). The Repository reads entity metadata at runtime to generate parameterized SQL.

**This is a leaf dependency** — it MUST NOT import from `primebrick-be-v3` or `primebrick-us-v3`. It only depends on `pg`, `pg-query-stream`, and `reflect-metadata`.

**Consumers (deferred):**
- `primebrick-us-v3` (microservices) — Phase 2, after DAL is released
- `primebrick-be-v3` (backend) — Phase 3, after US integration

**Documentation language:** All `*.md` files use **English**.

## Commands

| Action | Command |
|--------|---------|
| Install | `pnpm install` |
| Build | `pnpm run build` |
| Type check | `tsc --noEmit` |
| Test | `pnpm test` |
| Test (watch) | `pnpm test:watch` |
| Benchmarks | `pnpm test:benchmark` |

## Conventions

- **snake_case everywhere** — DB columns, TS properties, JSON responses. No DTO transformation.
- **RETURNING \*** on all writes — the DB returns the full row, hydrated into entity shape.
- **throwIfNotFound: true** by default on finders.
- **deletedRecords: "EXCLUDED"** by default — soft-deleted rows excluded.
- **TEMP TABLE strategy** for bulk update/upsert — atomic, SQL-injection safe.
- **bigint via INT8_OID** — native `bigint`, not strings.
- **Metadata-driven types** — `@Column({ dbType: ... })` controls PG<->JS type coercion.

## GitFlow

This repository follows GitFlow. AI agents MUST follow these rules.

**See [docs/gitflow.md](./docs/gitflow.md) for complete GitFlow rules.**

## Further documentation

- [docs/ai/README.md](./docs/ai/README.md) — AI docs index
- [docs/ai/dal-usage-guide.md](./docs/ai/dal-usage-guide.md) — complete method-by-method guide
- [.devin/rules/](./.devin/rules/) — always-on rules for Devin agents
