import type { EntityClass } from "../meta/entity-decorators.js";
import { SequenceEntity } from "./sequence-entity.js";
import { SequenceCounterEntity } from "./sequence-counter-entity.js";

/**
 * BUILTIN_ENTITIES — the platform-owned entity classes mounted BY
 * CONSTRUCTION in every module schema. These classes are never declared
 * in a module's `ENTITY_REGISTRY` (the framework knows them, the module
 * does not) and never subclassed (sealed constructors).
 *
 * One canonical list consumed by every surface that must know the
 * built-in set:
 *   - `primebrick-db compare/check` — merges them into the scan so the
 *     emitted patches cover `<module>.sequences` etc.
 *   - the sdk route facades — mount the governed management surface
 *     (sequence registry routes) at boot, like the health route.
 *
 * Schema resolution: the classes carry NO `@Entity` schema pin — the
 * effective schema is the consuming module's `OWNED_SCHEMAS[0]` (primary),
 * passed via `ctx.schemas` / `--schema` in tooling.
 */
export const BUILTIN_ENTITIES = [
  SequenceEntity,
  SequenceCounterEntity,
] as const satisfies readonly EntityClass[];
