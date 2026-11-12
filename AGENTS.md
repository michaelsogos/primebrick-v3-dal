# AI AGENT INSTRUCTIONS - @primebrick/dal

## Documentation is the contract — code is the proof

- Docs (AGENTS.md, .devin/rules/, docs/ai/, docs/dev-guide/, docs/user-guide/)
  are the source of truth for HOW things work. Source code is NEVER
  documentation: pages are composed dynamically (mountPage, remote chunks,
  layout.sections, runtime wiring) — reading a +page.svelte alone tells you
  little about what actually renders.
- Need to know how to do something (tests, auth, dev servers, conventions)?
  Find it in the doc FIRST. Read code only as the "prova del 9" — to verify
  the code behaves as the doc says. Never the reverse.
- Doc and code disagree? Report the discrepancy — the doc is probably stale.
  Do NOT fix docs silently and do NOT create new files in .devin/rules/,
  docs/, or AGENTS.md on your own initiative: propose the text, write only
  after approval.
- Before claiming "a doc is missing", check the indexes:
  docs/ai/README.md, .devin/rules/, docs/dev-guide/_order.json.
  The missing doc is usually a doc you haven't read.

## ⚠️ COMMIT CADENCE — every change turn commits

**A turn that modifies source files ENDS with a commit** — the user has
authorized this cadence as a standing rule. Do not accumulate uncommitted
work and do not wait for per-commit permission.

- Before every commit run the relevant checks: **type check** AND
  **E2E / runtime verification** of the changed path.
- **A green type check alone is NEVER "verified"** — it only proves the
  code compiles. Empirical verification = run the thing and look at the
  output (screenshot for UI, HTTP response for endpoints, query for data).
- See [docs/ai/commit-verification.md](./docs/ai/commit-verification.md)
  for the full contract, and [docs/gitflow.md](./docs/gitflow.md) for
  GitFlow commit rules.


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
- **Static-annotation type contract** — column types resolve from the TS annotation (`bigint`→int8, `number`→float8, `string`→text, `Date`→timestamptz, `UUID`→uuid, `Decimal`→numeric, `Vector`→vector, `T[]`→base[]), never from the property name or `design:type`. `@Column({ pgType })` is a whitelist-checked override. The annotation is erased at transpile, so runtime re-resolves via a second cascade — `pgType` → semantic pins (audit/deletable/synchronizable/`@Key`-identity→int8) → `jsType` (`instant`/`decimal`/`vector`/`bigint` → `timestamptz`/`numeric`/`vector`/`int8`) → `"text"` fallback — and ONE declaration feeds schema patches, served meta (`pg_type`/`type`/widget+searchable defaults), ILIKE text-cast (a `"text"` lie skips the cast → 42883), ext-json hydration, and pg param conversion. `entity-type-declared` lint forces a runtime-visible declaration on every non-string annotation. See `docs/dev-guide/column-types.mdx` and `.devin/rules/entity-type-contract.md`.
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
