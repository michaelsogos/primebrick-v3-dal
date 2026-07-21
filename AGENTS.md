# AI AGENT INSTRUCTIONS - @primebrick/dal

## ⚠️ CRITICAL: NEVER COMMIT AUTOMATICALLY

**AI agents MUST NEVER commit changes without explicit user instruction.**

- **WAIT for the user to explicitly tell you to commit** before running any `git commit` command
- This applies to ALL situations - no exceptions
- See [docs/gitflow.md](./docs/gitflow.md) for complete GitFlow rules including commit rules

## Repository overview

`@primebrick/dal-pg` is a shared Data Access Layer library for Primebrick v3. It provides a type-driven, metadata-based `Repository` for PostgreSQL®. Entities are plain TS classes with decorators (`@Entity`, `@Column`, `@Key`, `@Unique`, `@AuditableField`, `@DeletableField`). The Repository reads entity metadata at runtime to generate parameterized SQL.

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

## Package Versioning — FIXED versions only (MANDATORY)

All package versions in `package.json` MUST be pinned to exact versions (e.g.
`"typescript": "5.9.3"`). NO ranges (`^`, `~`, `>=`, `*`, `latest`) are allowed
for registry packages. This ensures every dev machine, CI build, and production
rebuild gets the exact same dependency tree that was tested during UAT.

See [.devin/rules/package-versioning.md](./.devin/rules/package-versioning.md)
for the full rule and upgrade procedure.

## Further documentation

- [docs/ai/README.md](./docs/ai/README.md) — AI docs index
- [docs/ai/dal-usage-guide.md](./docs/ai/dal-usage-guide.md) — complete method-by-method guide
- [.devin/rules/](./.devin/rules/) — always-on rules for Devin agents

## User-facing documentation

User-facing developer documentation lives in `docs/user-guide/` as MDX files.
These are synced to `docs.primebrick.dev` by the docs repo's CI pipeline.

- **Location**: `docs/user-guide/*.mdx` — one file per topic
- **Ordering**: `docs/user-guide/_order.json` defines the sidebar page order
- **Conventions**: see `.devin/rules/docs-user-guide.md` for editorial rules
- **Mermaid**: use `<Mermaid chart={...} />`, never ` ```Code ` or ` ```mermaid `
- **API extraction**: run `pnpm extract-docs` to generate
  `docs/user-guide/_extracted/api.json` from TypeDoc
- **Do NOT hand-edit** files in `docs/ai/` or `docs/skills/` — those are internal
- **Internal docs** (`docs/ai/`, `docs/skills/`, `docs/gitflow.md`) are NOT synced
  to the docs site — they stay in this repo for AI agents only
