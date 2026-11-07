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
 * Column `kind` contract (one source of truth — the entity class):
 *   - absent        → physical column (must exist on the class);
 *   - "calculated"  → `@Calculated` prop on the class — SQL projection:
 *                     sortable/filterable/searchable ON by default;
 *   - "virtual"     → post-query enrichment (decorate(), external
 *                     sources): sortable/filterable/searchable FORCED OFF.
 *
 * ENFORCEMENT, not verification — throws at boot on:
 *   1. an authored `nullable`/`max_length`/`pg_type` (derived props are
 *      class-owned; restating them duplicates the source of truth);
 *   2. a column `key` with no physical column on the class — unless the
 *      column declares `kind:"calculated"` (backed by `@Calculated`) or
 *      `kind:"virtual"` (backed by decoration);
 *   3. `kind:"calculated"` without a matching `@Calculated` prop on the
 *      entity class — the class owns the expression, meta can't invent it;
 *   4. `kind:"virtual"` with `sortable`/`filterable`/`searchable` set to
 *      `true` — a virtual column can never be queried; opting IN is a
 *      construction error (opting OUT is legal but redundant).
 */
import type { MetaColumn } from "@primebrick/core";
import { numericKindOf } from "@primebrick/core";
import { AuditableFieldType, DeletableFieldType, getEntityPersistenceMeta, type EntityClass } from "./entity-decorators.js";

/** Derived prop names owned by the entity class — authored values throw. */
const DERIVED_PROPS = ["nullable", "max_length", "pg_type"] as const;

/** Query flags a `kind:"virtual"` column can never enable. */
const QUERY_FLAGS = ["sortable", "filterable", "searchable"] as const;

/** Closed `options_source` vocabulary — mirrors `MetaColumnOptionsSource`
 *  (runtime guard for wire-shaped metas that never saw the TS type). */
const COLUMN_OPTIONS_SOURCES = new Set(["census.emits", "census.callables", "audit.actors"]);

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
      // Identity-generated @Key → server-managed on write: exempt from
      // create-required checks (`checkEntityFields`). Manual keys stay
      // client-writable — `usePostgresIdentity` already encodes both.
      ...(phys.usePostgresIdentity === true ? { managed: true } : {}),
      // Audit actor columns ALWAYS resolve the governed vocabulary —
      // derived, never authored (the vocab is the table's own writers
      // by definition; an authored options_source on `*_by` is drift).
      ...(isAuditActorColumn(phys) ? { options_source: "audit.actors" as const } : {}),
    };
  };

  const columns = meta.columns
    .filter((col) => !hiddenKeys.has(col.key))
    .map((col) => {
      if (col.kind === "virtual") {
        const forced = QUERY_FLAGS.filter((f) => col[f] === true);
        if (forced.length > 0) {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: virtual column "${col.key}" forces ${forced.join(", ")}:true — ` +
              `virtual columns are post-query enrichments and can never be queried; remove the flag(s)`,
          );
        }
      }
      if (col.options_source !== undefined && !COLUMN_OPTIONS_SOURCES.has(col.options_source)) {
        throw new Error(
          `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" options_source "${col.options_source}" is not a declared vocabulary — ` +
            `one of ${[...COLUMN_OPTIONS_SOURCES].join(", ")}`,
        );
      }
      if (typeof col.options_source === "string" && col.options_source.startsWith("census.") && col.allow_create === true) {
        throw new Error(
          `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" declares allow_create:true on a census options_source — ` +
            `census vocabularies are closed by definition; drop allow_create`,
        );
      }
      if (col.managed !== undefined) {
        throw new Error(
          `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" authors managed — ` +
            `the flag is derived from the entity class (@Key generation strategy); never declared by hand`,
        );
      }
      // ── uom / unsigned — the unit-of-measure and sign contract live only
      //    on NUMERIC columns. `percent` is a display transform (no sibling);
      //    `currency`/`custom` require `uom.field` naming a PHYSICAL sibling
      //    column on the class that persists the code per row.           */
      const physForKind = persistence.columns[col.key];
      if (col.uom !== undefined || col.unsigned === true) {
        const numeric =
          numericKindOf({ ...col, pg_type: col.pg_type ?? physForKind?.inferredPgType }) !== null;
        if (!numeric) {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" declares uom/unsigned on a non-numeric column — ` +
              `the unit/sign contract applies to number/money formats and numeric pg types only`,
          );
        }
      }
      if (col.uom !== undefined) {
        const uom = col.uom;
        if (uom.kind === "percent") {
          if ("field" in uom) {
            throw new Error(
              `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom:"percent" declares a sibling field — ` +
                `percent is a pure display transform (×100/÷100) and persists no code`,
            );
          }
        } else if (uom.kind === "currency" || uom.kind === "custom") {
          if (!persistence.columns[uom.field] || hiddenKeys.has(uom.field)) {
            throw new Error(
              `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom.field "${uom.field}" must name a physical column on the entity class — ` +
                `the UoM code is persisted per row on that sibling column`,
            );
          }
          if (uom.kind === "currency" && uom.source !== undefined && uom.source !== "currencies") {
            throw new Error(
              `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom:"currency" source "${String(uom.source)}" is not a declared vocabulary — ` +
                `only "currencies" (the ISO 4217 list) is valid`,
            );
          }
          if (uom.kind === "custom") {
            const src = uom.source;
            const ok =
              src === "currencies" ||
              (typeof src === "object" && src !== null && ("entity" in src || "api_url" in src));
            if (!ok) {
              throw new Error(
                `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom:"custom" has no valid source — ` +
                  `one of "currencies" | { entity } | { api_url }`,
              );
            }
          }
        } else {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom.kind "${String((uom as { kind?: unknown }).kind)}" is not a declared vocabulary — ` +
              `one of percent | currency | custom`,
          );
        }
      }
      const phys = persistence.columns[col.key];
      if (!phys) {
        if (col.kind === "virtual") return col;
        if (col.kind === "calculated") {
          if (persistence.calculated[col.key]) return col;
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: calculated column "${col.key}" has no @Calculated property on the entity class — ` +
              `declare @Calculated("<expr>") on ${persistence.entityClassName}.${col.key} (the class owns the SQL expression)`,
          );
        }
        throw new Error(
          `withColumnConstraints[${persistence.entityClassName}]: meta column "${col.key}" has no matching column on the entity class — ` +
            `declare it on the class, or mark the column kind:"calculated" (@Calculated prop) / kind:"virtual" (decorate)`,
        );
      }
      if (col.kind !== undefined) {
        throw new Error(
          `withColumnConstraints[${persistence.entityClassName}]: physical column "${col.key}" declares kind:"${col.kind}" — ` +
            `physical columns have no kind (drop it); the value already comes from SQL`,
        );
      }
      const restated = DERIVED_PROPS.filter((p) => col[p] !== undefined);
      if (restated.length > 0) {
        throw new Error(
          `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" restates derived prop(s) ${restated.join(", ")} — ` +
            `the entity class is the source; remove the authored value(s)`,
        );
      }
      if (isAuditActorColumn(phys) && col.options_source !== undefined && col.options_source !== "audit.actors") {
        throw new Error(
          `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" is an audit actor column — ` +
            `options_source:"audit.actors" is derived from the entity class; remove the authored value`,
        );
      }
      return injectDerived(col);
    });

  // ── Class → meta completeness: every PHYSICAL column not declared and not
  //    hidden is auto-derived — system columns are never authored by hand.
  //    Derived columns are default_visible:false (available in the picker,
  //    zero visual impact) — an explicit authored entry is required to make
  //    one visible-by-default. The same auto-derivation covers @Calculated
  //    props (kind:"calculated", no physical constraints injected).        */
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
      // System columns share ONE translation dict (`system.common.fields.*`)
      // — a per-entity key for `uuid`/`created_by`/… is dict duplication:
      // the label is identical for every entity by definition.
      label_key: isAudit || isUid || COMMON_SYSTEM_FIELD_KEYS.has(key) ? `system.common.fields.${key}` : labelFor(key),
      type: columnTypeForPg(phys.inferredPgType),
      order: isUid ? -1 : 1000 + derivedIdx++,
      sticky: isUid || undefined,
      default_visible: false,
      audited: isAudit || undefined,
      // uid/id/version are never filter criteria: a uuid/id text-filter
      // is debug noise (relationships use `ref`), version is the
      // optimistic-lock counter — meaningless as a matcher.
      filterable: isUid || key === "id" || key === "version" ? false : undefined,
      // Audit actor columns feed the governed multi-select: the
      // distinct vocab of THIS table's actors, label-resolved through
      // user_profile by the entity's /audit-actors route.
      options_source: isAuditActorColumn(phys) ? "audit.actors" : undefined,
    };
    columns.push(injectDerived(derived));
  }
  for (const [key] of Object.entries(persistence.calculated)) {
    if (declared.has(key) || hiddenKeys.has(key)) continue;
    columns.push({
      key,
      label_key: labelFor(key),
      type: "text",
      order: 1000 + derivedIdx++,
      default_visible: false,
      kind: "calculated",
    });
  }
  return { ...meta, columns };
}

/** System physical fields whose label is entity-independent — auto-derived
 *  columns for these always resolve `system.common.fields.<key>` (seeded once
 *  per language, shared by every entity). */
const COMMON_SYSTEM_FIELD_KEYS = new Set([
  "id", "uuid", "version",
  "created_at", "created_by", "updated_at", "updated_by",
  "deleted_at", "deleted_by",
]);

/** Audit actor physical columns — `@AuditableField(CREATED_BY|UPDATED_BY)`
 *  + `@DeletableField(DELETED_BY)`. They always resolve
 *  `options_source:"audit.actors"` — derived from the class, never authored. */
function isAuditActorColumn(phys: {
  auditableType?: AuditableFieldType;
  deletableType?: DeletableFieldType;
}): boolean {
  return (
    phys.auditableType === AuditableFieldType.CREATED_BY ||
    phys.auditableType === AuditableFieldType.UPDATED_BY ||
    phys.deletableType === DeletableFieldType.DELETED_BY
  );
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
