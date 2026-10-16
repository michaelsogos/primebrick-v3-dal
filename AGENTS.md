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
- **Explicit write ops** — `add` / `update` / `delete` (soft) / `restore` / `hardDelete`. `upsert` and `upsertMany` are removed/disabled (they bypassed optimistic locking); never reintroduce them — the standard is read (`uuid`+`version`) then `add`/`update`.
- **No consumer raw SQL** — `dal.transaction(txRepo => …)` hands out only a tx-scoped `Repository`; `withClient`/`getPool` are internal. `serverVersion()` is the health+version probe (no `ping()`); `truncate(entity)` is the domain-guarded physical reset.
- **Optimistic concurrency** — auditable writes (`update`, `delete`, `restore`) require the observed `version`; stale version fails the write.
- **RETURNING \*** on all writes — the DB returns the full row, hydrated into entity shape; callers consume it instead of re-reading.
- **throwIfNotFound: true** by default on finders.
- **deletedRecords: "EXCLUDED"** by default — soft-deleted rows excluded.
- **TEMP TABLE strategy** for bulk update/upsert/delete — atomic, SQL-injection safe.
- **bigint via INT8_OID** — native `bigint`, not strings.
- **Static-annotation type contract** — column types resolve from the TS annotation (`bigint`→int8, `number`→float8, `string`→text, `Date`→timestamptz, `UUID`→uuid, `Decimal`→numeric, `Vector`→vector, `T[]`→base[]), never from the property name or `design:type`. `@Column({ pgType })` is a whitelist-checked override; runtime io is driven by `jsType` markers + value shape. See `docs/dev-guide/column-types.mdx` and `.devin/rules/entity-type-contract.md`.
- **Naming convention** — PG table = snake_case **plural** (collection of rows, e.g. `customers`). Entity class = PascalCase **singular** (one row schema, e.g. `CustomerEntity`). This is enforced by the `@Entity` decorator — the table name is plural, the class name is singular.
- **Service layer** — `DomainService<TEntity>` (`src/entity/domain-service.ts`) is THE base class for consumer worker services: lazy `this.dal`/`this.svc` getters (ctor is I/O-free — `getDal()` fails fast at first use, never at construction), `buildConfig()` seam for consumer wiring (auditPort/actor/userEntity). Per-domain `*Dal`/`*Repo` wrapper classes are banned — custom queries live as methods on the owning service.
- **Bootstrap split (consumer-side)** — consumers wrap `getDal(config)` in their own `initDal()` (once, in `index.ts`, before migrations); `getDal()` is the accessor everywhere else.

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

## Documentation (3 tiers — see `.devin/rules/docs-audience.md`)

Developer documentation lives in `docs/dev-guide/` as MDX files.
These are synced to `docs.primebrick.dev` under the dev section — never ingested into the end-user AI KB.

- **Location**: `docs/dev-guide/*.mdx` — one file per topic
- **Ordering**: `docs/dev-guide/_order.json` defines the sidebar page order
- **Conventions**: see `.devin/rules/docs-dev-guide.md` for editorial rules
- **Mermaid**: use `<Mermaid chart={...} />`, never ` ```Code ` or ` ```mermaid `
- **API extraction**: run `pnpm extract-docs` to generate
  `docs/dev-guide/_extracted/api.json` from TypeDoc
- **Do NOT hand-edit** files in `docs/ai/` or `docs/skills/` — those are internal
- **Internal docs** (`docs/ai/`, `docs/skills/`, `docs/gitflow.md`) are NOT synced
  to the docs site — they stay in this repo for AI agents only
