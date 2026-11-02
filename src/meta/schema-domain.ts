/**
 * Schema sovereignty domain — the set of PostgreSQL schemas a service is
 * allowed to touch, declared via `DATABASE_SCHEMA` and pushed here by the
 * `Dal` constructor (`getDal({ schemas })`).
 *
 * Enforcement points:
 * - boot: `assertEntitySchemaDomain` (schema-domain-assert.ts) — every
 *   registered @Entity must resolve to a declared schema, else the service
 *   crashes before serving traffic;
 * - runtime: `resolveEntitySchema` is consulted by getQualifiedTableName /
 *   persistence-meta so ANY entity operation whose schema is outside the
 *   declared domain throws `SchemaDomainViolationError` before SQL is built.
 *
 * What this does NOT cover: raw `db.query("SELECT … FROM other_schema.x")`
 * — SQL text is not inspected. Physical enforcement against raw SQL is the
 * per-schema PG role layer (svc_<schema>), a separate hardening task.
 *
 * NOTE: this module must not import entity-meta/entity-decorators — they
 * import this file (one direction only, no cycle).
 */

export class SchemaDomainViolationError extends Error {
  readonly code = "SCHEMA_DOMAIN_VIOLATION";
  constructor(
    message: string,
    readonly details?: { entity?: string; schema?: string; allowed?: string[] },
  ) {
    super(message);
    this.name = "SchemaDomainViolationError";
  }
}

export type SchemaDomain = {
  /** All schemas this service may touch (declaration order). */
  allowed: ReadonlySet<string>;
  /** schemas[0] — the service-owned schema (patch registry, config_entries). */
  primary: string;
  /**
   * Table names exempt from the domain check in ANY schema — governed
   * cross-schema contracts. The built-in `PLATFORM_SHARED_TABLES` set is
   * always unioned in: `public`/`custom` are cross-app platform domains,
   * not module domains — `user_profiles` (platform identity, auditable
   * display-name joins) and `translations` (every module schema carries
   * one; the BE i18n gateway manages them all) are platform infrastructure.
   */
  sharedTables: ReadonlySet<string>;
};

let domain: SchemaDomain | null = null;

const SCHEMA_IDENT = /^[a-z_][a-z0-9_]*$/;
const TABLE_IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Platform-owned tables always exempt from the domain check — hardcoded
 * because they are platform invariants, not configuration: `public`/`custom`
 * are cross-app domains, and every service may legally reach these tables
 * (`user_profiles` for auditable display-name joins, `translations` for the
 * governed i18n contract).
 */
const PLATFORM_SHARED_TABLES = new Set(["user_profiles", "translations"]);

/** Called once by the Dal constructor. Re-calls replace the domain (tests). */
export function configureSchemaDomain(schemas: string[], sharedTables: string[] = []): SchemaDomain {
  if (!Array.isArray(schemas) || schemas.length === 0) {
    throw new SchemaDomainViolationError("DalConfig.schemas must be a non-empty array of schema names");
  }
  const bad = schemas.filter((s) => typeof s !== "string" || !SCHEMA_IDENT.test(s));
  if (bad.length) {
    throw new SchemaDomainViolationError(
      `DalConfig.schemas contains invalid name(s) [${bad.join(", ")}] — must match ${SCHEMA_IDENT}`,
    );
  }
  const badTables = sharedTables.filter((t) => typeof t !== "string" || !TABLE_IDENT.test(t));
  if (badTables.length) {
    throw new SchemaDomainViolationError(
      `DalConfig.sharedTables contains invalid name(s) [${badTables.join(", ")}] — must match ${TABLE_IDENT}`,
    );
  }
  domain = {
    allowed: new Set(schemas),
    primary: schemas[0]!,
    sharedTables: new Set([...PLATFORM_SHARED_TABLES, ...sharedTables]),
  };
  return domain;
}

/** Test hook — clears the configured domain. */
export function resetSchemaDomain(): void {
  domain = null;
}

export function getSchemaDomain(): SchemaDomain | null {
  return domain;
}

/**
 * Resolve the effective schema of an entity: the explicit @Entity schema pin
 * wins, otherwise the domain primary (search_path head). When a domain is
 * configured, any schema outside the declared set throws.
 *
 * Without a configured domain the caller's `fallback` (legacy `public`)
 * applies — the guard is inert so standalone tooling/tests keep working.
 */
export function resolveEntitySchema(meta: { tableSchema?: string; tableName?: string }, fallback = "public"): string {
  const effective = meta.tableSchema ?? domain?.primary ?? fallback;
  if (domain && !domain.allowed.has(effective)) {
    if (!meta.tableName || !domain.sharedTables.has(meta.tableName)) {
      throw new SchemaDomainViolationError(
        `entity targets schema "${effective}" which is outside the declared domain [${[...domain.allowed].join(", ")}]`,
        { schema: effective, allowed: [...domain.allowed] },
      );
    }
  }
  return effective;
}
