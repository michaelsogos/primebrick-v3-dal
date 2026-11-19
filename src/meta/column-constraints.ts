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
 *   5. the uid column (`meta.uid`) authoring `sticky:false`,
 *      `hideable:false`, `default_visible:true`, `order` ≠ -1, or
 *      `hidden:true` — the uid contract is fixed: `order:-1`, sticky,
 *      hidden-by-default, always user-toggleable;
 *   6. a served meta with NO pinned column (`sticky:true +
 *      hideable:false` — always-visible, never-hideable identity) — when
 *      none is declared, the `display_field` column derives the pin;
 *      display_field absent, naming no served column, naming the uid, or
 *      explicitly un-pinned (`hideable:true`/`sticky:false`) → throw.
 *   ≥4 `sticky` columns emit a construction WARNING — allowed,
 *   discouraged: sticky chrome is for identity columns, not data columns.
 */
import type { MetaColumn, RelationFacet } from "@primebrick/core";
import { isTextlikePgType, numericKindOf, UNIT_CATEGORIES, type MetaColumnUomKind } from "@primebrick/core";
import { AuditableFieldType, CloneFieldType, DeletableFieldType, getEntityPersistenceMeta, getRelationFacet, type EntityClass } from "./entity-decorators.js";

/** Derived prop names owned by the entity class — authored values throw. */
const DERIVED_PROPS = ["nullable", "max_length", "pg_type"] as const;

/** Query flags a `kind:"virtual"` column can never enable. */
const QUERY_FLAGS = ["sortable", "filterable", "searchable"] as const;

/** Closed `options_source` vocabulary — mirrors `MetaColumnOptionsSource`
 *  (runtime guard for wire-shaped metas that never saw the TS type). */
const COLUMN_OPTIONS_SOURCES = new Set(["census.emits", "census.callables", "audit.actors", "system.roles"]);

/** Intl-sanctioned unit identifiers — the same vocabulary the cell
 *  formatter feeds `style:"unit"` (`Intl.supportedValuesOf("unit")`,
 *  ~45 entries: millisecond, kilogram, byte, …). `uom.unit` must be a
 *  member; arbitrary codes belong in `uom.symbol` (suffix fallback).
 *  Empty set when the runtime lacks the API — any `unit` declaration
 *  then fails membership loudly rather than drifting. */
const INTL_SANCTIONED_UNITS = new Set(Intl.supportedValuesOf?.("unit") ?? []);

export function withColumnConstraints<T extends { columns: MetaColumn[]; entity?: string; translation_key?: string; entities_ns?: string; uid?: string; display_field?: string }>(
  meta: T,
  entityClass: EntityClass,
): T {
  const persistence = getEntityPersistenceMeta(entityClass);
  /** `@Relation` facet — present when the entity class is a directed
   *  parent→child edge: reshapes the identity contract below (no
   *  display_field, no pinned column, ends served + immutable). */
  const relation = getRelationFacet(entityClass);

  // `hidden: true` is the ONLY authored opt-out: the column is suppressed
  // entirely — never emitted in meta.columns, never auto-derived, never
  // reaches the FE (table, picker, filters, forms).
  const hiddenKeys = new Set(meta.columns.filter((c) => c.hidden === true).map((c) => c.key));

  const injectDerived = (col: MetaColumn): MetaColumn => {
    const phys = persistence.columns[col.key];
    if (!phys) return col;
    const refEnt = servedRefEntity(phys, meta.entity);
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
      // `audited` is a class fact too (audit/deletion/sync decorators) —
      // inject even on authored columns so a mere relabel can't drop the
      // flag (it gates dict inline-editability and soft-delete detection).
      ...(phys.isAuditable === true || phys.isDeletable === true || phys.isSynchronizable === true
        ? { audited: true }
        : {}),
      // The ref contract is a class fact the same way: an authored column
      // entry may tune visibility/order but can never re-point or drop
      // the ref (`@Ref` target, or the `cloned_from` self-ref). Audit
      // actor columns serve the LAZY form — the static `user_profile`
      // @Ref is only the human-writer default; `system:<code>` writers
      // resolve per-row through the `<key>_ref_entity` / `<key>_ref_key`
      // verdict projections the audit joins emit (user_profile |
      // service_registry | NULL → plain text for `migration-*`).
      ...(refEnt !== undefined
        ? isAuditActorColumn(phys)
          ? { type: "ref" as const, ref: { entity_field: `${col.key}_ref_entity`, key_field: `${col.key}_ref_key` } }
          : { type: "ref" as const, ref: { entity: refEnt } }
        : {}),
    };
  };

  let extraAuditIdx = 0;
  /** Canonical audit-section sequence — emitted `order` bands so the record
   *  sheet's audit accordion reads extras → created pair → updated pair →
   *  deleted pair → clone triple → version-last by construction, regardless
   *  of mixin declaration order in the class. Authored `order` still wins:
   *  a declared column carrying one is the explicit escape hatch. */
  const auditOrderFor = (key: string): number => {
    const rank = STANDARD_AUDIT_RANK[key];
    if (rank !== undefined) return AUDIT_ORDER_BASE + rank;
    // Non-standard audited columns (sync/lifecycle stamps) rank FIRST of
    // the audit block, in emission order among themselves.
    return AUDIT_ORDER_BASE + extraAuditIdx++ * 10;
  };
  /** After injectDerived: an audited column WITHOUT an authored order gets
   *  its canonical band (uid is pinned separately and is never audited). */
  const withAuditOrder = (col: MetaColumn): MetaColumn =>
    col.audited === true && col.order === undefined && col.key !== meta.uid
      ? { ...col, order: auditOrderFor(col.key) }
      : col;

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
      // `@Ref` on the class owns the ref contract — authored `ref` is
      // always drift; authored `type` may only restate the required
      // "ref" literal (system columns must declare the derived type),
      // anything else contradicts the class.
      const physForRef = persistence.columns[col.key];
      const servedRef = physForRef ? servedRefEntity(physForRef, meta.entity) : undefined;
      if (servedRef !== undefined) {
        if (col.ref !== undefined || (col.type !== undefined && col.type !== "ref")) {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" authors ref/type — ` +
              `the ref contract derives from the entity class (@Ref / cloned_from self-ref → "${servedRef}"); never declared by hand`,
          );
        }
      }
      // `@Relation` end columns — `immutable` is a class fact (the facet
      // declares the edge ends create-set / frozen afterwards); authoring
      // it, in either direction, is drift.
      if (
        relation !== undefined &&
        (col.key === relation.parent_field || col.key === relation.child_field) &&
        col.immutable !== undefined
      ) {
        throw new Error(
          `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" authors immutable — ` +
            `the @Relation facet owns end mutability (ends are create-set, frozen afterwards); drop the authored value`,
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
        } else if (uom.kind === "currency") {
          if (!persistence.columns[uom.field] || hiddenKeys.has(uom.field)) {
            throw new Error(
              `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom.field "${uom.field}" must name a physical column on the entity class — ` +
                `the UoM code is persisted per row on that sibling column`,
            );
          }
          if (uom.source !== undefined && uom.source !== "currencies") {
            throw new Error(
              `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom:"currency" source "${String(uom.source)}" is not a declared vocabulary — ` +
                `only "currencies" (the ISO 4217 list) is valid`,
            );
          }
        } else if (uom.kind === "custom") {
          // ── custom XOR — genuinely non-standard UoM only:            */
          //    `field`+`source` (per-row code from a custom vocabulary, */
          //    `symbol` optional adornment override) OR standalone      */
          //    `symbol` (fixed arbitrary suffix). `unit` moved to the   */
          //    category kinds — a sanctioned unit on custom is a        */
          //    construction error, not a variant.                       */
          const hasField = "field" in uom;
          const hasUnit = "unit" in uom;
          const hasSymbol = "symbol" in uom;
          const hasSource = "source" in uom;
          if (hasUnit) {
            throw new Error(
              `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom:"custom" declares unit — ` +
                `Intl-sanctioned units belong on a category kind (time | length | digital | …), custom is for non-standard vocabularies only`,
            );
          }
          if (hasField !== hasSource) {
            throw new Error(
              `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom:"custom" declares field without source (or vice versa) — ` +
                `the per-row code path requires BOTH: the sibling column and the selector vocabulary`,
            );
          }
          if (!hasField && !hasSymbol) {
            throw new Error(
              `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom:"custom" declares no unit source — ` +
                `one of field+source | symbol is required`,
            );
          }
          if (hasField) {
            if (!persistence.columns[uom.field] || hiddenKeys.has(uom.field)) {
              throw new Error(
                `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom.field "${uom.field}" must name a physical column on the entity class — ` +
                  `the UoM code is persisted per row on that sibling column`,
              );
            }
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
        } else if (uom.kind in UNIT_CATEGORIES) {
          // ── category kind — Intl-sanctioned UoM grouped by           */
          //    UNIT_CATEGORIES (CLDR census, hardcoded in core).        */
          //    Exactly one of `unit` (fixed) | `field` (per-row code   */
          //    on a physical sibling — the category IS the picker      */
          //    vocabulary, no `source` prop exists here).              */
          const kind = uom.kind as MetaColumnUomKind;
          const hasField = "field" in uom;
          const hasUnit = "unit" in uom;
          if (hasField === hasUnit) {
            throw new Error(
              `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom:"${kind}" must declare exactly one of unit | field — ` +
                `got ${hasUnit && hasField ? "both" : "neither"}`,
            );
          }
          if (hasUnit) {
            if (!INTL_SANCTIONED_UNITS.has(uom.unit)) {
              throw new Error(
                `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom.unit "${uom.unit}" is not an Intl-sanctioned unit — ` +
                  `valid identifiers come from Intl.supportedValuesOf("unit"); free-text units belong in uom:"custom" symbol`,
              );
            }
            if (!UNIT_CATEGORIES[kind].includes(uom.unit)) {
              throw new Error(
                `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom:"${kind}" unit "${uom.unit}" is sanctioned but belongs to a different category — ` +
                  `one of ${UNIT_CATEGORIES[kind].join(", ")}`,
              );
            }
          }
          if (hasField && (!persistence.columns[uom.field] || hiddenKeys.has(uom.field))) {
            throw new Error(
              `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom.field "${uom.field}" must name a physical column on the entity class — ` +
                `the per-row UoM code is persisted on that sibling column (category "${kind}" values)`,
            );
          }
        } else {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" uom.kind "${String((uom as { kind?: unknown }).kind)}" is not a declared vocabulary — ` +
              `one of percent | currency | custom | ${Object.keys(UNIT_CATEGORIES).join(" | ")}`,
          );
        }
      }
      // ── avatar — `color_field` names the PHYSICAL sibling column that
      //    persists the per-row avatar color (same rule as `uom.field` —
      //    the companion datum lives on a stored sibling). The avatar
      //    column itself carries the initials; `avatar` is legal only on
      //    `type:"avatar"`.
      if (col.avatar !== undefined) {
        if (col.type !== "avatar") {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" declares avatar on type "${col.type}" — ` +
              `the avatar renderer applies to type:"avatar" columns only`,
          );
        }
        const colorField = col.avatar.color_field;
        if (!persistence.columns[colorField] || hiddenKeys.has(colorField)) {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" avatar.color_field "${colorField}" must name a physical column on the entity class — ` +
              `the per-row avatar color is persisted on that sibling column`,
          );
        }
        const initialsField = col.avatar.initials_field;
        if (initialsField !== undefined && (!persistence.columns[initialsField] || hiddenKeys.has(initialsField))) {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" avatar.initials_field "${initialsField}" must name a physical column on the entity class — ` +
              `the initials derive from that sibling's value`,
          );
        }
      }
      // ── depends_on — ONE declared edge to a PHYSICAL sibling column
      //    (the pivot is a stored value on the same record — same rule as
      //    `uom.field`). `filter_field` parametrizes the options `/list`
      //    of a `type:"ref"` column — meaningless elsewhere. The
      //    prop-reading facets (`disabled_when.prop`, `control_prop`)
      //    resolve the pivot's picked ROW — legal only when the pivot is
      //    itself declared `type:"ref"` (its options carry the row).   */
      if (col.depends_on !== undefined) {
        const dep = col.depends_on;
        // A `hidden` pivot stays legal for the record-reading facets —
        // `disabled_when` (`set`/`equals`/`not`/`values`) evaluates the
        // stored row value, which the served payload still carries even
        // when the column is suppressed from meta (e.g. an internal
        // reconcile anchor gating user-editable fields). The interactive
        // facets instead need a served pivot: `filter_field` is the
        // user's pick control, `control_prop`/`disabled_when.prop` fetch
        // the pivot's picked ROW through its ref options delegate.
        if (!persistence.columns[dep.field]) {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" depends_on.field "${dep.field}" must name a physical column on the entity class — ` +
              `the pivot is a stored sibling value on the same record`,
          );
        }
        if (
          hiddenKeys.has(dep.field) &&
          (dep.filter_field !== undefined ||
            dep.control_prop !== undefined ||
            dep.disabled_when?.prop !== undefined)
        ) {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" depends_on.field "${dep.field}" names a hidden column — ` +
              `interactive facets (filter_field / control_prop / disabled_when.prop) require a served pivot; only record-reading gates (set/equals/not/values) may use one`,
          );
        }
        if (dep.filter_field !== undefined && col.type !== "ref") {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" declares depends_on.filter_field on type "${col.type}" — ` +
              `filter_field parametrizes the options /list of a type:"ref" column only`,
          );
        }
        if (dep.control_prop !== undefined && col.type === "ref") {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" declares depends_on.control_prop on a type:"ref" column — ` +
              `a ref column's control is structurally entity_ref; a data-driven format is meaningless here`,
          );
        }
        if (dep.control_prop !== undefined || dep.disabled_when?.prop !== undefined) {
          const pivotCol = meta.columns.find((c) => c.key === dep.field && !c.hidden);
          if (pivotCol?.type !== "ref" || !pivotCol.ref?.entity) {
            throw new Error(
              `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" depends_on reads a prop of the pivot row (control_prop/disabled_when.prop) — ` +
                `pivot "${dep.field}" must be declared type:"ref" with ref.entity (the row is fetched from its options delegate)`,
            );
          }
        }
      }
      // ── ref target — exactly one source: `entity` (static) XOR
      //    `entity_field` (lazy per-row resolution). A ref with neither
      //    cannot be resolved; with both the static would silently win.
      if (col.ref !== undefined) {
        if (col.ref.entity !== undefined && col.ref.entity_field !== undefined) {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" declares both ref.entity and ref.entity_field — ` +
              `the target source is exclusive: static "entity" or lazy "entity_field" (per-row entity name), never both`,
          );
        }
        if (col.ref.entity === undefined && col.ref.entity_field === undefined) {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" declares a ref with no target — ` +
              `either ref.entity (static target) or ref.entity_field (row column naming the per-row entity) is required`,
          );
        }
      }
      // ── ref route/presentation — closed vocabularies validated at
      //    construction: malformed values must fail at meta assembly,
      //    never reach the wire as a silently-misparsed cell. */
      if (col.ref !== undefined) {
        const route = col.ref.route ?? "detail";
        if (route !== "detail" && route !== "list" && route !== "none") {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" declares ref.route "${route}" — ` +
              `closed vocabulary: "detail" | "list" | "none"`,
          );
        }
        const pres = col.ref.presentation;
        if (pres !== undefined && pres !== "link" && pres !== "badge") {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" declares ref.presentation "${pres}" — ` +
              `closed vocabulary: "link" | "badge" ("link" is the default; "badge" is the explicit opt-in legacy anatomy)`,
          );
        }
      }
      // ── ref.value_field — a non-uid stored value cannot feed a
      //    `[param]` detail route (params are uids). The author must
      //    pick the truthful alternative explicitly: route:"list" +
      //    filter_field (a real filtered link) or route:"none" (a
      //    declared label-only cell). route:"list" also needs an explicit
      //    filter_field — the 'uuid' default would filter the wrong
      //    column on a non-uid value.   */
      if (col.ref?.value_field !== undefined) {
        const route = col.ref.route ?? "detail";
        if (route === "detail") {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" declares ref.value_field "${col.ref.value_field}" with route:"detail" (explicit or default) — ` +
              `a non-uid stored value cannot feed a [param] detail route; declare route:"list" + filter_field or route:"none"`,
          );
        }
        if (route === "list" && col.ref.filter_field === undefined) {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" declares ref.value_field "${col.ref.value_field}" with route:"list" but no filter_field — ` +
              `the 'uuid' default would filter the wrong column on a non-uid value`,
          );
        }
      }
      const phys = persistence.columns[col.key];
      if (!phys) {
        if (col.kind === "virtual") return col;
        if (col.kind === "calculated") {
          const calc = persistence.calculated[col.key];
          if (!calc) {
            throw new Error(
              `withColumnConstraints[${persistence.entityClassName}]: calculated column "${col.key}" has no @Calculated property on the entity class — ` +
                `declare @Calculated("<expr>") on ${persistence.entityClassName}.${col.key} (the class owns the SQL expression)`,
            );
          }
          // `nullable`/`pg_type` are class facts like on physical columns —
          // inject them; authored restatement is drift. `type` stays authored
          // (it may refine the display format, e.g. "ref_count" over int4);
          // when absent the auto-derived path resolves it from pgType.
          const restated = DERIVED_PROPS.filter((p) => col[p] !== undefined);
          if (restated.length > 0) {
            throw new Error(
              `withColumnConstraints[${persistence.entityClassName}]: calculated column "${col.key}" authors ${restated.join(", ")} — ` +
                `declared via @Calculated(expr, { pgType, nullable }) on the entity class`,
            );
          }
          return withAuditOrder({
            ...col,
            nullable: calc.nullable ?? false,
            ...(calc.pgType !== undefined ? { pg_type: calc.pgType } : {}),
          });
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
      // ── The surrogate PK is join/fkey plumbing — never part of the wire
      //    contract (read projections already exclude isKey); authoring it
      //    re-exposes what the derivation deliberately omits. Checked
      //    BEFORE the system-field facets so the error is deterministic. */
      if (col.key === "id" && col.key !== meta.uid) {
        throw new Error(
          `withColumnConstraints[${persistence.entityClassName}]: system column "id" must never be authored — ` +
            `the surrogate PK is join/fkey plumbing only and stays out of the served contract`,
        );
      }
      // ── System columns are class-derived — the class owns their FACTS
      //    and their GOVERNED mechanisms (audit.actors vocab, ref links).
      //    `type` is a required field, so an authored value can't be absent:
      //    it must EQUAL the pg-derived type — a mismatch is a physical lie
      //    (the "version declared text" bug). Authored SEMANTICS stay legal
      //    (label_key relabels like job_run's started_at, format, query
      //    flags, visibility, tooltips); FORBIDDEN = structural/vocab
      //    facets + type payloads that only cohere with an authored type +
      //    the writable-validation contract (system cols never enter
      //    create/edit forms).                                         */
      if (COMMON_SYSTEM_FIELD_KEYS.has(col.key)) {
        // A served ref pins the type to "ref" — a class fact like
        // pg_type (@Ref target or the cloned_from self-ref).
        const derivedType = servedRefEntity(phys, meta.entity) !== undefined ? "ref" : columnTypeForPg(phys.inferredPgType);
        if (col.type !== derivedType) {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: system column "${col.key}" authors type:"${col.type}" but ` +
              `the entity class ${col.key} is ${phys.inferredPgType} (→ "${derivedType}") — drop the authored type or fix the declaration`,
          );
        }
        const SYSTEM_COL_FORBIDDEN = [
          "kind", "options_source", "allow_create", "ref", "reverse_ref",
          "uom", "unsigned", "depends_on", "audited", "managed", "widget",
          "pattern", "min_length", "min", "max", "json_schema", "badge", "sparkline",
        ] as const;
        const forged = SYSTEM_COL_FORBIDDEN.filter((p) => col[p] !== undefined);
        if (forged.length > 0) {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: system column "${col.key}" authors ${forged.join(", ")} — ` +
              `system columns derive their facts and governed vocabularies from the entity class; ` +
              `authored overrides are label_key/format/datetime_iana_toggle/null_label/query flags/visibility/tooltips only — drop the rest`,
          );
        }
      }
      // ── Anti-restatement + flag defaulting: the effective default for a
      //    query flag is TYPE-AWARE — absent resolves to the derived value,
      //    not blindly ON (a type:"date"/"datetime" column defaults
      //    searchable:false; `version` additionally sortable:false). An
      //    authored flag EQUAL to the derived default is dead weight — it
      //    reads as intent, survives review, and silently forks semantics
      //    the day the derivation changes: rejected. Flags exist to NARROW
      //    the default or to override a derived false. Absent flags then
      //    resolve to the derived value — explicit `false` is injected so
      //    the served meta states the real contract, not a misleading ON. */
      const physCol = persistence.columns[col.key];
      if (physCol && col.kind === undefined) {
        const physPgType = physCol.pgType ?? physCol.inferredPgType;
        const restated = QUERY_FLAGS.filter(
          (f) => col[f] !== undefined && col[f] === defaultQueryFlag(f, col.key, col.type, physPgType),
        );
        if (restated.length > 0) {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" authors ${restated.map((f) => `${f}:${String(col[f])}`).join(", ")} — ` +
              `${restated.length === 1 ? "that is" : "those are"} the derived default; drop the flag${restated.length === 1 ? "" : "s"} (author flags only to narrow or to override a derived false)`,
          );
        }
        const flagDefaults: Record<string, boolean> = {};
        for (const f of QUERY_FLAGS)
          if (col[f] === undefined && !defaultQueryFlag(f, col.key, col.type, physPgType)) flagDefaults[f] = false;
        // An authored `searchable:true` that escapes restatement survives
        // only because the derived default is FALSE — it declares scope
        // the wire allowlist can never admit. Intent contradicting
        // physics is authored drift, not a tunable: refuse the meta.
        if (col.searchable === true) {
          throw new Error(
            `withColumnConstraints[${persistence.entityClassName}]: column "${col.key}" authors searchable:true on a non-ILIKE-safe column (pg type "${physPgType}") — ` +
              `the wire search_in allowlist derives from the same physical types and would reject it; drop the flag`,
          );
        }
        return withAuditOrder(injectDerived({ ...col, ...flagDefaults }));
      }
      return withAuditOrder(injectDerived(col));
    });

  // ── Class → meta completeness: every PHYSICAL column not declared and not
  //    hidden is auto-derived — system columns are never authored by hand.
  //    Derived columns are default_visible:false (available in the picker,
  //    zero visual impact) — an explicit authored entry is required to make
  //    one visible-by-default. The same auto-derivation covers @Calculated
  //    props (kind:"calculated", no physical constraints injected).        */
  const declared = new Set(columns.map((c) => c.key));

  // ── Declared standard-audit columns — legal, usually fuffa ─────────────
  //    Auto-derivation already emits every standard audit stamp audited +
  //    canonical band order (2000+rank). A declaration is justified only when
  //    it carries semantics the derivation cannot express (hidden, relabel
  //    like job_run's finished_at, a widget). Since `order` is REQUIRED in
  //    the column type, declaring for visibility alone forces an authored
  //    order — and any order <2000 ejects the column from the audit band, so
  //    the record-sheet accordion misorders it. Warn at composition so the
  //    author consciously owns the exception instead of inheriting
  //    pre-refactoring cruft.
  for (const c of meta.columns) {
    const rank = STANDARD_AUDIT_RANK[c.key];
    if (rank === undefined || c.hidden === true) continue;
    const relabeled = c.label_key !== undefined && c.label_key !== `system.common.fields.${c.key}`;
    const outOfBand = c.order !== undefined && c.order < AUDIT_ORDER_BASE;
    console.warn(
      `withColumnConstraints[${persistence.entityClassName}]: standard audit column "${c.key}" is declared ` +
        `(order:${c.order === undefined ? "auto→canonical band" : c.order}` +
        `${outOfBand ? " — OUTSIDE the audit band 2000+, the record-sheet audit accordion will sort it away from its pair" : ""}` +
        `${relabeled ? `, relabeled via label_key "${c.label_key}"` : ""}` +
        `${c.default_visible === true ? ", default_visible:true" : ""}) — ` +
        `auto-derivation already emits it audited at order ${AUDIT_ORDER_BASE + rank}; ` +
        `keep the declaration only if it adds semantics the derivation cannot express (hidden, relabel, widget), otherwise drop it`,
    );
  }

  const ns = meta.entities_ns ?? "system";
  const entityKey = meta.translation_key ?? meta.entity ?? persistence.entityClassName;
  const labelFor = (key: string) => `${ns}.entities.${entityKey}.fields.${key}`;
  let derivedIdx = 0;
  for (const [key, phys] of Object.entries(persistence.columns)) {
    if (declared.has(key) || hiddenKeys.has(key)) continue;
    // The surrogate PK is join/fkey plumbing — it never enters the wire
    // contract (read projections already exclude isKey). Excluded unless it
    // IS the entity's public uid (legacy id-keyed tables).
    if (phys.isKey === true && key !== meta.uid) continue;
    const isAudit =
      phys.isAuditable === true ||
      phys.isDeletable === true ||
      phys.isClone === true ||
      phys.cloneType !== undefined;
    // The `audited` section flag also covers synchronization stamps
    // (@SynchronizableField e.g. last_synced_at) — non-standard audit
    // fields land in the extras group, ranked first of the block. Kept
    // out of `isAudit` itself: that flag also drives the shared
    // system.common.fields label_key which has no sync entry.
    const auditedField = isAudit || phys.isSynchronizable === true;
    const isUid = key === meta.uid;
    // `cloned_from` self-references the owning entity — the source record
    // lives in the same table, so the ref target is the entity itself.
    const refEntity = servedRefEntity(phys, meta.entity);
    const colType = refEntity !== undefined ? "ref" : columnTypeForPg(phys.inferredPgType);
    const derived: MetaColumn = {
      key,
      // System columns share ONE translation dict (`system.common.fields.*`)
      // — a per-entity key for `uuid`/`created_by`/… is dict duplication:
      // the label is identical for every entity by definition.
      label_key: isAudit || isUid || COMMON_SYSTEM_FIELD_KEYS.has(key) ? `system.common.fields.${key}` : labelFor(key),
      type: colType,
      order: isUid ? -1 : auditedField ? auditOrderFor(key) : 1000 + derivedIdx++,
      sticky: isUid || undefined,
      default_visible: false,
      audited: auditedField || undefined,
      // Every emitted column is filter criteria-eligible (the uid powers
      // ref/actor `IN` lookups; version supports "changed since" filters)
      // and sortable — audit actor uuids resolve `*_display_name` through
      // the DAL's automatic user_profile join, so they sort and text-search
      // like any label column. `version` is the optimistic-lock counter:
      // never sorted, never text-searched (a numeric LIKE is noise); the
      // same applies to every date/datetime column — a timestamp matched
      // as text is noise, range filters are the query contract.
      searchable: defaultQueryFlag("searchable", key, colType, phys.inferredPgType) ? undefined : false,
      sortable: defaultQueryFlag("sortable", key, colType) ? undefined : false,
      // Audit actor columns feed the governed multi-select: the
      // distinct vocab of THIS table's actors, label-resolved through
      // user_profile by the entity's /audit-actors route.
      options_source: isAuditActorColumn(phys) ? "audit.actors" : undefined,
      ...(refEntity !== undefined ? { ref: { entity: refEntity } } : {}),
    };
    columns.push(injectDerived(derived));
  }
  for (const [key, reg] of Object.entries(persistence.calculated)) {
    if (declared.has(key) || hiddenKeys.has(key)) continue;
    columns.push({
      key,
      label_key: labelFor(key),
      type: reg.pgType ? columnTypeForPg(reg.pgType) : "text",
      nullable: reg.nullable ?? false,
      ...(reg.pgType !== undefined ? { pg_type: reg.pgType } : {}),
      order: 1000 + derivedIdx++,
      default_visible: false,
      kind: "calculated",
    });
  }
  enforceIdentityColumnContract(columns, meta, persistence.entityClassName, relation);
  return { ...meta, columns };
}

/**
 * The identity-column contract — enforced at meta construction, never
 * verified downstream:
 *
 *   uid column (`meta.uid`): always served, always `sticky:true`,
 *   `order:-1` (first when visible), `default_visible:false`, and
 *   user-toggleable (`hideable !== false`). Authored contradictions
 *   throw; absent contract props are injected. `hidden:true` on the uid
 *   throws — the identity column is never suppressed.
 *
 *   pinned column (`sticky:true + hideable:false`): the always-visible,
 *   never-hideable identity column. Every served meta needs AT LEAST
 *   one. When none is declared, the `display_field` column derives it —
 *   display_field is the mandatory identity, so a pin always exists.
 *   Explicit pins elsewhere are the authored opt-out; an explicitly
 *   un-pinned display_field (`hideable:true`/`sticky:false`) with no
 *   other pin throws. The uid can NEVER carry the pin (it stays
 *   toggleable) — `display_field === uid` throws.
 *
 *   relation entities (`@Relation` — directed parent→child edges):
 *   reshape the contract — `display_field`/`display_name` FORBIDDEN (the
 *   display is viewpoint-dependent, owned by the `relation` facet), the
 *   pinned-column requirement is EXEMPT and an authored pin throws, and
 *   every facet field (parent/child/type) must resolve to a SERVED
 *   column carrying `@Ref` — `immutable:true` is injected on the two
 *   ends (repointing an edge is delete+create).
 *
 *   ≥4 sticky columns → construction warning (allowed, discouraged).
 */
function enforceIdentityColumnContract(
  columns: MetaColumn[],
  meta: { uid?: string; display_field?: string; display_name?: string },
  entityClassName: string,
  relation?: RelationFacet,
): void {
  // ── uid contract ───────────────────────────────────────────────────
  if (meta.uid !== undefined) {
    const uidIdx = columns.findIndex((c) => c.key === meta.uid);
    if (uidIdx === -1) {
      throw new Error(
        `withColumnConstraints[${entityClassName}]: uid column "${meta.uid}" is not served — ` +
          `the identity column can never be hidden:true or absent (order:-1, sticky, hidden-by-default, toggleable)`,
      );
    }
    const uidCol = columns[uidIdx]!;
    const contradictions: string[] = [];
    if (uidCol.sticky === false) contradictions.push("sticky:false");
    if (uidCol.hideable === false) contradictions.push("hideable:false");
    if (uidCol.default_visible === true) contradictions.push("default_visible:true");
    if (uidCol.order !== undefined && uidCol.order !== -1) contradictions.push(`order:${uidCol.order}`);
    if (contradictions.length > 0) {
      throw new Error(
        `withColumnConstraints[${entityClassName}]: uid column "${meta.uid}" authors ${contradictions.join(", ")} — ` +
          `the uid contract is fixed (order:-1, sticky:true, default_visible:false, user-toggleable); drop the authored value(s)`,
      );
    }
    columns[uidIdx] = { ...uidCol, order: -1, sticky: true, default_visible: false };
  }

  // ── relation entities — directed edges have no single-column identity
  if (relation !== undefined) {
    if (meta.display_field !== undefined) {
      throw new Error(
        `withColumnConstraints[${entityClassName}]: relation entities never declare display_field — ` +
          `a directed parent→child edge has no single-column identity; the display is viewpoint-dependent (relation facet)`,
      );
    }
    if (meta.display_name !== undefined) {
      throw new Error(
        `withColumnConstraints[${entityClassName}]: relation entities never declare display_name — ` +
          `a static template would fork the viewpoint-dependent display contract owned by the relation facet`,
      );
    }
    for (const [role, key] of [
      ["parent_field", relation.parent_field],
      ["child_field", relation.child_field],
      ...(relation.type_field !== undefined ? [["type_field", relation.type_field] as const] : []),
    ] as const) {
      const idx = columns.findIndex((c) => c.key === key);
      if (idx === -1) {
        throw new Error(
          `withColumnConstraints[${entityClassName}]: @Relation ${role} "${key}" is not a served column — ` +
            `relation facet fields must resolve to served columns (never hidden:true, never absent)`,
        );
      }
      if (role !== "type_field") {
        const c = columns[idx]!;
        if (c.immutable !== undefined && c.immutable !== true) {
          throw new Error(
            `withColumnConstraints[${entityClassName}]: @Relation end column "${key}" authors immutable:${c.immutable} — ` +
              `the facet owns end mutability (ends are create-set, frozen afterwards)`,
          );
        }
        columns[idx] = { ...c, immutable: true };
      }
    }
    const pinned = columns.find((c) => c.sticky === true && c.hideable === false);
    if (pinned !== undefined) {
      throw new Error(
        `withColumnConstraints[${entityClassName}]: relation entities carry no pinned column — ` +
          `"${pinned.key}" authors sticky:true + hideable:false; the edge's identity is composite and viewpoint-dependent`,
      );
    }
  } else {
  // ── ≥1 pinned column — declared, or derived from display_field ─────
  const hasPin = columns.some((c) => c.sticky === true && c.hideable === false);
  if (!hasPin) {
    const dfIdx = meta.display_field === undefined ? -1 : columns.findIndex((c) => c.key === meta.display_field);
    if (dfIdx === -1) {
      throw new Error(
        `withColumnConstraints[${entityClassName}]: no pinned column (sticky:true + hideable:false) and ` +
          (meta.display_field === undefined
            ? `display_field is not declared — every entity needs at least one always-visible identity column`
            : `display_field "${meta.display_field}" names no served column — the pin cannot derive from a hidden/absent column`),
      );
    }
    const dfCol = columns[dfIdx]!;
    if (dfCol.key === meta.uid) {
      throw new Error(
        `withColumnConstraints[${entityClassName}]: display_field "${meta.display_field}" is the uid — ` +
          `the uid is always user-toggleable and can never carry the pinned-identity contract; ` +
          `name a different display_field or pin another column explicitly`,
      );
    }
    if (dfCol.hideable === true || dfCol.sticky === false) {
      throw new Error(
        `withColumnConstraints[${entityClassName}]: display_field "${meta.display_field}" is explicitly ` +
          `${dfCol.hideable === true ? "hideable:true" : "sticky:false"} — un-pinning the mandatory identity pin ` +
          `needs an explicit pinned column (sticky:true + hideable:false) declared elsewhere`,
      );
    }
    columns[dfIdx] = { ...dfCol, sticky: true, hideable: false };
  }

  // ── display_field write-contract convention ────────────────────────
  // The display name is the entity's user-authored identity — every
  // display_field inherits the write contract by being the display_field:
  // REQUIRED on the wire (served `nullable:false` — the physical column
  // may stay nullable; required is a write contract, not a DB fact —
  // `nullable` is NOT the override vote for it), `min_length` 5,
  // `max_length` 255. Authored `min_length`/`max_length` win; the
  // `@Column length` already fed `max_length` when declared. Non-writable
  // display_fields (calculated/virtual projections, server-managed keys,
  // the uid) are exempt — they never arrive on the wire.
  if (meta.display_field !== undefined) {
    const wIdx = columns.findIndex((c) => c.key === meta.display_field);
    if (wIdx !== -1) {
      const wCol = columns[wIdx]!;
      const writable =
        wCol.kind !== "calculated" &&
        wCol.kind !== "virtual" &&
        wCol.managed !== true &&
        wCol.audited !== true &&
        wCol.key !== meta.uid;
      if (writable) {
        columns[wIdx] = {
          ...wCol,
          nullable: false,
          min_length: wCol.min_length ?? 5,
          max_length: wCol.max_length ?? 255,
        };
      }
    }
  }
  }

  // ── ≥4 sticky — allowed, discouraged (construction warning) ────────
  const stickyCount = columns.filter((c) => c.sticky === true).length;
  if (stickyCount >= 4) {
    console.warn(
      `withColumnConstraints[${entityClassName}]: ${stickyCount} sticky columns — ≥4 sticky columns are allowed but discouraged ` +
        `(sticky chrome is for identity columns, not data columns)`,
    );
  }
}

/** Canonical audit-section order — the record sheet sorts `audited` columns
 *  by `order`; these bands make the sequence a construction fact instead of
 *  mixin-declaration luck. extras (non-standard audited cols) fill 2000-2090
 *  by emission order; standard stamps follow by pair; `version` is pinned
 *  unconditional last. */
const AUDIT_ORDER_BASE = 2000;
const STANDARD_AUDIT_RANK: Record<string, number> = {
  created_by: 100,
  created_at: 110,
  updated_by: 120,
  updated_at: 130,
  deleted_by: 140,
  deleted_at: 150,
  cloned_from: 160,
  cloned_at: 170,
  cloned_by: 180,
  version: 900,
};

/** System physical fields whose label is entity-independent — auto-derived
 *  columns for these always resolve `system.common.fields.<key>` (seeded once
 *  per language, shared by every entity). */
const COMMON_SYSTEM_FIELD_KEYS = new Set([
  "id", "uuid", "version",
  "created_at", "created_by", "updated_at", "updated_by",
  "deleted_at", "deleted_by",
  "cloned_from", "cloned_at", "cloned_by",
]);

/** Audit actor physical columns — `@AuditableField(CREATED_BY|UPDATED_BY)`
 *  + `@DeletableField(DELETED_BY)`. They always resolve
 *  `options_source:"audit.actors"` — derived from the class, never authored. */
function isAuditActorColumn(phys: {
  auditableType?: AuditableFieldType;
  deletableType?: DeletableFieldType;
  cloneType?: CloneFieldType;
}): boolean {
  return (
    phys.auditableType === AuditableFieldType.CREATED_BY ||
    phys.auditableType === AuditableFieldType.UPDATED_BY ||
    phys.deletableType === DeletableFieldType.DELETED_BY ||
    phys.cloneType === CloneFieldType.CLONED_BY
  );
}

/** The derived default for a query flag — driven by the column's META `type`
 *  (authored for declared columns, `columnTypeForPg`-resolved for auto-derived
 *  ones; never by pg-type alone: un-pinned business `Date` props infer "text"
 *  at runtime, but their authored type is the contract). An authored flag
 *  equal to this value is a restatement (rejected); a different value is a
 *  real override (allowed). `filterable` is ON for every column; `sortable`
 *  is OFF only on `version`; `searchable` is OFF on `version`, every
 *  date/datetime column, and every column whose PHYSICAL pg type is not
 *  ILIKE-safe (`TEXTLIKE_PG_TYPES` — the same set the wire `search_in`
 *  allowlist derives from). Serving `searchable` on a non-textlike
 *  column would advertise scope the backend then rejects — the derived
 *  default resolves intent against physics so the two cannot diverge. */
function defaultQueryFlag(
  flag: (typeof QUERY_FLAGS)[number],
  key: string,
  metaType: MetaColumn["type"],
  physPgType?: string,
): boolean {
  if (flag === "filterable") return true;
  if (flag === "sortable") return key !== "version";
  if (key === "version" || metaType === "date" || metaType === "datetime") return false;
  if (physPgType === undefined) return true;
  return isTextlikePgType(physPgType);
}

/** Served-meta ref target for a physical column: `@Ref` wins; a
 *  `cloned_from` column (`isClone`) self-references the OWNING entity —
 *  the source record lives in the same table. The target is the entity
 *  NAME, never a class thunk or inlined meta, so a self-ref can never
 *  recurse (the FE resolves it lazily through the route census). */
function servedRefEntity(
  phys: { refEntity?: string; isClone?: boolean },
  entityName: string | undefined,
): string | undefined {
  return phys.refEntity ?? (phys.isClone === true ? entityName : undefined);
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
