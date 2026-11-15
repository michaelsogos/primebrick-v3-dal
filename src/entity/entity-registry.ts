/**
 * Entity-service registry — the name→service map behind domain ref
 * display joins.
 *
 * `@Ref("entity_name")` stores the served entity NAME (the same string
 * the wire carries as `ref.entity`), so a ref join needs that name
 * resolved back to the target's `EntityServiceConfig` facts: its class
 * (schema/table/uid via `getEntityPersistenceMeta`) and its materialized
 * display template (`cfg.display` — the SAME `resolveDisplayTemplate`
 * rule the served meta applies).
 *
 * Registration happens inside `dal.entityService(cfg)` — every entity
 * service built through the gateway-owned path self-registers under the
 * derived api name. `makeServiceRoutes` warms every declared entity's
 * `svc` at boot so the map is complete before the first request; a name
 * that never resolves (cross-domain ref, headless entity, divergent
 * naming) simply isn't here and the ref degrades to its raw uuid —
 * never a wrong join, never a boot failure.
 *
 * The api-name convention is `PascalName` class minus the trailing
 * `Entity` suffix, camel→snake (`JobTriggerEntity` → `job_trigger`).
 * Authored api names follow it by convention; a divergent name degrades
 * to the uuid fallback by design.
 */

import type { EntityClass } from "../meta/entity-decorators.js";

export interface RegisteredEntityService {
  entity: EntityClass;
  /** Materialized display template (`"${name} (${code})"`) — the same
   *  string `cloned_from_name` projects. `null` → the ref join is
   *  skipped: no template, no display projection. */
  display: string | null;
}

const ENTITY_SERVICES = new Map<string, RegisteredEntityService>();

/** `JobTriggerEntity` → `job_trigger`, `AiCerebellumEntity` → `ai_cerebellum`. */
export function entityApiName(ctor: EntityClass): string {
  return ctor.name
    .replace(/Entity$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

export function registerEntityService(cfg: {
  entity: EntityClass;
  display?: string | null;
}): void {
  const key = entityApiName(cfg.entity);
  const prev = ENTITY_SERVICES.get(key);
  ENTITY_SERVICES.set(key, {
    entity: cfg.entity,
    // The route-decl registration carries the AUTHORED meta's display
    // template — the single source. A later `dal.entityService` build
    // must never downgrade it to null when the consumer's service cfg
    // omitted `display`.
    display: cfg.display ?? prev?.display ?? null,
  });
}

export function lookupEntityService(
  apiName: string,
): RegisteredEntityService | undefined {
  return ENTITY_SERVICES.get(apiName);
}
