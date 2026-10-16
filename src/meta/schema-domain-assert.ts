/**
 * Boot-time schema-domain check — kept separate from schema-domain.ts to
 * avoid an import cycle (entity-decorators imports schema-domain).
 */

import type { EntityClass } from "./entity-meta.js";
import { getEntityPersistenceMeta } from "./entity-decorators.js";
import { SchemaDomainViolationError } from "./schema-domain.js";

/**
 * Boot-time check: every registered entity must resolve inside `schemas`
 * (an explicit @Entity schema pin wins; bare entities resolve to the
 * primary schema `schemas[0]`). Throws with the full violation list — the
 * service must crash, not degrade.
 *
 * `sharedTables` mirrors `DalConfig.sharedTables`: an entity whose TABLE
 * NAME is in the shared set is exempt (the governed cross-schema contract
 * — e.g. the gateway's `<module>.translations` classes).
 */
export function assertEntitySchemaDomain(
  entities: readonly unknown[],
  schemas: readonly string[],
  sharedTables: readonly string[] = [],
): void {
  const allowed = new Set(schemas);
  const shared = new Set(sharedTables);
  const primary = schemas[0];
  const violations: string[] = [];
  for (const e of entities) {
    if (typeof e !== "function") continue;
    let meta: { tableSchema?: string; tableName?: string };
    try {
      meta = getEntityPersistenceMeta(e as EntityClass, primary);
    } catch {
      continue; // not an @Entity class — registry may contain other entries
    }
    const effective = meta.tableSchema ?? primary;
    if (!allowed.has(effective) && !(meta.tableName && shared.has(meta.tableName))) {
      violations.push(`${(e as EntityClass).name} → "${effective}"."${meta.tableName}"`);
    }
  }
  if (violations.length) {
    throw new SchemaDomainViolationError(
      `entities declared outside the service schema domain [${[...allowed].join(", ")}]:\n  - ${violations.join("\n  - ")}`,
      { allowed: [...allowed] },
    );
  }
}
