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
 *      the column is explicitly virtual (`virtual: true`, or
 *      `type:"sparkline"` — the documented no-DB-field renderer
 *      contract).
 */
import type { MetaColumn } from "@primebrick/core";
import { getEntityPersistenceMeta, type EntityClass } from "./entity-decorators.js";

/** Derived prop names owned by the entity class — authored values throw. */
const DERIVED_PROPS = ["nullable", "max_length", "pg_type"] as const;

/** Column types with no physical backing — exempt from the class lookup. */
const VIRTUAL_COLUMN_TYPES: readonly string[] = ["sparkline", "ref_count"];

export function withColumnConstraints<T extends { columns: MetaColumn[]; entity?: string; translation_key?: string; entities_ns?: string; uid?: string }>(
  meta: T,
  entityClass: EntityClass,
): T {
  const persistence = getEntityPersistenceMeta(entityClass);

  // `hidden: true` is the ONLY authored opt-out: the column is suppressed
  // entirely — never emitted in meta.columns, never auto-derived, never
  // reaches the FE (table, picker, filters, forms).
  const hiddenKeys = new Set(meta.columns.filter((c) => c.hidden === true).map((c) => c.key));

  const injectDerived = (col: MetaColumn): MetaColumn => {
    const phys = persistence.columns[col.key];
    if (!phys) return col;
    return {
      ...col,
      nullable: phys.nullable ?? false,
      ...(phys.length !== undefined ? { max_length: phys.length } : {}),
      pg_type: phys.inferredPgType,
    };
  };

  const columns = meta.columns
    .filter((col) => !hiddenKeys.has(col.key))
    .map((col) => {
      const phys = persistence.columns[col.key];
      if (!phys) {
        if (col.virtual === true || VIRTUAL_COLUMN_TYPES.includes(col.type))
          return col;
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
      return injectDerived(col);
    });

  // ── Class → meta completeness: every PHYSICAL column not declared and not
  //    hidden is auto-derived — system columns are never authored by hand.
  //    Derived columns are default_visible:false (available in the picker,
  //    zero visual impact) — an explicit authored entry is required to make
  //    one visible-by-default.                                                   */
  const declared = new Set(columns.map((c) => c.key));
  const ns = meta.entities_ns ?? "system";
  const entityKey = meta.translation_key ?? meta.entity ?? persistence.entityClassName;
  const labelFor = (key: string) => `${ns}.entities.${entityKey}.fields.${key}`;
  let derivedIdx = 0;
  for (const [key, phys] of Object.entries(persistence.columns)) {
    if (declared.has(key) || hiddenKeys.has(key)) continue;
    const isAudit = phys.isAuditable === true || phys.isDeletable === true;
    const isUid = key === meta.uid;
    const derived: MetaColumn = {
      key,
      label_key: labelFor(key),
      type: columnTypeForPg(phys.inferredPgType),
      order: isUid ? -1 : 1000 + derivedIdx++,
      sticky: isUid || undefined,
      default_visible: false,
      audited: isAudit || undefined,
    };
    columns.push(injectDerived(derived));
  }
  return { ...meta, columns };
}

/** Entity-class `inferredPgType` → MetaColumn `type` for auto-derived columns. */
function columnTypeForPg(pgType: string): MetaColumn["type"] {
  if (pgType === "timestamptz" || pgType === "timestamp") return "datetime";
  if (pgType === "date") return "date";
  if (pgType === "boolean" || pgType === "bool") return "boolean";
  if (pgType.startsWith("json")) return "text";
  if (/^(int2|int4|int8|float4|float8|numeric|decimal|money|bigint|smallint|integer|real|double)/.test(pgType))
    return "number";
  return "text";
}
