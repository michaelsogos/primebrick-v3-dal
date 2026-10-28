/**
 * `withColumnConstraints` — binds an authored `*.meta.ts` (`EntityMeta`)
 * to its entity class and injects the DERIVED physical constraint props
 * onto `meta.columns`:
 *
 *   - `nullable`   ← `@Column({ nullable })` (undefined ⇒ NOT NULL)
 *   - `max_length` ← `@Column({ length })`
 *   - `pg_type`    ← resolved `inferredPgType` of the column
 *
 * The entity class is the single source for physical facts — the helper
 * exists so the SERVED meta (and therefore every form renderer) carries
 * them without authors restating them by hand.
 *
 *   meta: withColumnConstraints(jobRuleMeta, JobRuleEntity)
 *
 * ENFORCEMENT, not verification — throws at boot on:
 *   1. an authored `nullable`/`max_length`/`pg_type` (derived props are
 *      class-owned; restating them duplicates the source of truth);
 *   2. a column `key` that has no physical column on the class — unless
 *      the column is explicitly virtual (`type:"sparkline"`, the only
 *      documented no-DB-field renderer contract today).
 */
import type { MetaColumn } from "@primebrick/core";
import { getEntityPersistenceMeta, type EntityClass } from "./entity-decorators.js";

/** Derived prop names owned by the entity class — authored values throw. */
const DERIVED_PROPS = ["nullable", "max_length", "pg_type"] as const;

/** Column types with no physical backing — exempt from the class lookup. */
const VIRTUAL_COLUMN_TYPES: readonly string[] = ["sparkline"];

export function withColumnConstraints<T extends { columns: MetaColumn[] }>(
  meta: T,
  entityClass: EntityClass,
): T {
  const persistence = getEntityPersistenceMeta(entityClass);
  const columns = meta.columns.map((col) => {
    const phys = persistence.columns[col.key];
    if (!phys) {
      if (VIRTUAL_COLUMN_TYPES.includes(col.type)) return col;
      throw new Error(
        `withColumnConstraints[${persistence.entityClassName}]: meta column "${col.key}" has no matching column on the entity class — ` +
          `declare it on the class or remove it from meta.columns (virtual columns must use a virtual type)`,
      );
    }
    const restated = DERIVED_PROPS.filter((p) => col[p] !== undefined);
    if (restated.length > 0) {
      throw new Error(
        `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" restates derived prop(s) ${restated.join(", ")} — ` +
          `the entity class is the source; remove the authored value(s)`,
      );
    }
    return {
      ...col,
      nullable: phys.nullable ?? false,
      ...(phys.length !== undefined ? { max_length: phys.length } : {}),
      pg_type: phys.inferredPgType,
    };
  });
  return { ...meta, columns };
}
