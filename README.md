# @primebrick/dal-pg

Type-driven PostgreSQL® Data Access Layer for Primebrick v3 — a
metadata-based, type-safe `Repository`: entities are plain TS classes
decorated with `@Entity`, `@Column`, `@Key`, `@Unique`, `@AuditableField`,
`@DeletableField`; the Repository reads entity metadata at runtime to
generate parameterized SQL. No hand-written queries, no DTOs, snake_case
everywhere.

## Consumers

Every Primebrick service with a database: `primebrick-be-v3` and all
`primebrick-us-v3` microservices (via `@primebrick/sdk` port adapters).

## Documentation

- [AGENTS.md](./AGENTS.md) — agent entry point, repo conventions
- [docs/dev-guide/](./docs/dev-guide/) — architecture, connections/pool
  defaults, repository pattern, query DSL, migrations, column types,
  optimistic locking, audit trail, partitioning + generated API reference
- [docs/ai/](./docs/ai/) — AI-first documentation
- [docs/gitflow.md](./docs/gitflow.md) — release flow

## Commands

| Action | Command |
|--------|---------|
| Install | `pnpm install` |
| Build | `pnpm run build` |
| Test | `pnpm test` |

## License

MIT — see [LICENSE](./LICENSE)
