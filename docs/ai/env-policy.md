# Environment Variable Policy

> `.devin/rules/env-policy.md` is a pointer to this page — canonical text.

## Golden Rule

**The ONLY allowed environment variables are the database bootstrap pair**
`DATABASE_URL` (connection string) + `DATABASE_SCHEMA` (declared schema
domain — CSV or JSON array; `[0]` is the service's owned schema, sent to
the BE as the registry schema claim). Everything else — URLs, ports,
secrets, keys, feature flags — is a **module config** read from the config
table (`config_entries` on the BE, `<schema>.config` via `ConfigLoader` in
microservices). `assertDbEnv()` validates the pair at boot — unknown,
missing, empty or malformed keys crash startup.

## Why

- Env vars are invisible, un-versioned, and un-audited — config entries are
  managed, audited and consistent across environments.
- Per-service secrets (e.g. `client_key` for the B11 service-identity
  layer) MUST be per-service config rows, so each service holds its own
  key and a leaked key compromises one caller only — never a shared secret
  via env.

## Enforcement

- ❌ NEVER introduce a new `process.env.X` read for a configurable value
  (secrets included — a secret is config, not env).
- ❌ NEVER use env vars for URLs, ports, credentials, client keys, feature
  flags, or anything the service could read from its config table.
- ✅ `DATABASE_URL` + `DATABASE_SCHEMA` are the sole exceptions — they
  must exist before the config table is readable, and `DATABASE_SCHEMA`
  declares which PG schemas the service may touch (entity guard +
  registry claim).
- ✅ When adding a config value: create a config entry (key, type, i18n
  label) in the module's config seed, document it, and read it via
  `ConfigLoader`/`ConfigEntriesService`.
- When reviewing code, flag any new `process.env.` read other than the DB
  connection as a violation.

## Platform variables (process env — never `.env`, never config)

A closed set of **platform** env vars is permitted. They are supplied at
process launch or via Docker `ENV` — never in `.env`, never hardcoded,
never in `config_entries`:

- `NODE_ENV` — `production` enables the security gates consumed by the
  SDK: `Secure` session-cookie flag (BE) and migration signature trust
  `allowedTrust: ["release"]` (the `db-migration` engine — non-production
  accepts `dev` + `release` signed patches). Set via
  `ENV NODE_ENV=production` in each service Dockerfile; local dev leaves
  it unset.
- `PB_<MODULE>_FORCE_EMPTY` / `PB_<MODULE>_FORCE_ERROR` — E2E debug
  toggles consumed by `DomainService.list` in the BE (dev/test only).
- `E2E_ADMIN_USERNAME` / `E2E_ADMIN_PASSWORD` — ephemeral E2E actor
  credentials minted per run by the test harness (deleted at teardown).
- Test-harness env reads (`dal_test_*` connection strings, per-name env
  overrides in test setup) — test infrastructure only, never runtime
  config.

The `.env` file itself may contain ONLY the DB pair — extra keys crash
`assertDbEnv()` at boot.
