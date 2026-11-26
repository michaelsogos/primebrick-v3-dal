/**
 * builtin/sequence-decl — the `sequence` entity's full route declaration,
 * built BY THE FRAMEWORK for every module. This file is dal-owned on
 * purpose: the decl needs a real `DomainService` + the entity classes +
 * the schema domain — the SDK (which consumes the decl) cannot import
 * dal-pg, and dal-pg does not import the SDK; the factory crosses the
 * boundary through the `Symbol.for` registry in `builtin-register.ts`.
 *
 * Ownership by construction:
 *   - the decl is produced ONLY here — a module that declares
 *     `entityName:"sequence"` itself is rejected at boot by
 *     makeServiceRoutes;
 *   - the schema/namespace is NEVER authored — it resolves from the
 *     decl-factory `ctx.schemas` (`ServiceRoutesInput.schemas` — the
 *     module's OWNED_SCHEMAS — or `--schema` in tooling);
 *   - permission strings derive as `<ns>.sequence.<op>.<scope>` — the
 *     decl type is readonly string[], no static enum is needed.
 */

import {
  parseSequencePattern,
  validateSequencePartitions,
  sequencePartitionKey,
  sequenceReviveShapeIssues,
  derivePeriodKey,
  parseReviveSpec,
  parseGraceSpec,
  reviveExpireAt,
  reviveAddInterval,
  renderSequenceValue,
  SEZ_VALUE_RE,
  listColumnKeys,
  type EntityMeta,
  type MetaColumn,
  type SequencePartitions,
} from "@primebrick/core";

import { DomainService } from "../entity/domain-service.js";
import type { EntityGetOptions, EntityListQuery, EntityListResult } from "../entity/entity-service.js";
import { SequenceEntity } from "../entities/sequence-entity.js";
import { SequenceCounterEntity } from "../entities/sequence-counter-entity.js";
import { withColumnConstraints } from "../meta/column-constraints.js";
import { getSchemaDomain } from "../meta/schema-domain.js";
import { ValidationError } from "../errors/errors.js";
import { Filter, field } from "../query/dsl.js";

/** The module's owned schema — the explicit decl-context schema wins,
 *  else the configured domain primary (post-initDal runtime paths).
 *  The schema is service identity declared as CODE — env is never a
 *  source. Throws when neither exists: a route surface without an owned
 *  schema cannot host builtins. */
function ownedNamespace(declSchema?: string): string {
  const ns = declSchema ?? getSchemaDomain()?.primary;
  if (!ns) {
    throw new ValidationError(
      "builtin sequence decl: no owned schema — the decl context must " +
        "carry the module's declared schemas (or a configured domain)",
    );
  }
  return ns;
}

// ─── list config + meta ──────────────────────────────────────────────────

const SEQUENCE_DEFAULT_SORT = { key: "name", dir: "asc" as const };
const STICKY_KEYS = new Set<string>(["name"]);

function sequenceColumns(ns: string): MetaColumn[] {
  const F = (c: string) => `${ns}.entities.sequence.fields.${c}`;
  const raw: Array<Omit<MetaColumn, "sticky">> = [
    { key: "name", label_key: F("name"), type: "text", order: 0, hideable: false },
    // Row-owned sezionale defaults — write at create, frozen afterwards:
    // the owned slots are the revive axis identity. They are primary list
    // data (visible by default, non-sticky) immediately after the sticky
    // display column.
    { key: "sez", label_key: F("sez"), type: "text", order: 1, immutable: true, tooltip: `${F("sez")}.tooltip` },
    { key: "sez2", label_key: F("sez2"), type: "text", order: 2, immutable: true, tooltip: `${F("sez")}.tooltip` },
    { key: "sez3", label_key: F("sez3"), type: "text", order: 3, immutable: true, tooltip: `${F("sez")}.tooltip` },
    { key: "step", label_key: F("step"), type: "number", order: 4 },
    { key: "start", label_key: F("start"), type: "number", order: 5 },
    // Counter projection — machine state from `sequence_counters`
    // (default partition @ current period), attached post-query by
    // `attachCounterProjection`. `kind:"virtual"` forces sort/filter/
    // search off — the values are not SQL-addressable.
    { key: "value_actual", label_key: F("value_actual"), type: "number", order: 6, kind: "virtual" },
    { key: "value_next", label_key: F("value_next"), type: "number", order: 7, kind: "virtual" },
    { key: "pattern", label_key: F("pattern"), type: "text", format: "sequence_pattern", order: 8 },
    { key: "emitted_actual", label_key: F("emitted_actual"), type: "text", order: 9, kind: "virtual" },
    { key: "emitted_next", label_key: F("emitted_next"), type: "text", order: 10, kind: "virtual" },
    { key: "tz", label_key: F("tz"), type: "text", order: 11, options_source: "iana.tzones", default_visible: false },
    // `immutable` — editable on the create sheet, disabled on update
    // and excluded from update payloads (the cadence is the row's
    // identity; the wire validator rejects them regardless).
    // `format:"revive_interval"` — the numeric+unit composite control
    // emitting the closed `'N unit'` varchar canonical.
    { key: "revive_every", label_key: F("revive_every"), type: "text", format: "revive_interval", order: 12, default_visible: false, tooltip: `${F("revive_every")}.tooltip` },
    // Everything past the cadence is secondary list data: present in the
    // column picker, absent from the default view.
    // When the row starts serving as the binding default — a create-only
    // anchor (the generation's identity), gated on `revive_every` via
    // `depends_on` (disabled while the cadence is unset). `expire_at`
    // derives server-side from it; the field is never edited afterwards.
    { key: "default_from", label_key: F("default_from"), type: "datetime", order: 14, immutable: true, default_visible: false, default: { kind: "next_day_start_local" }, depends_on: { field: "revive_every", disabled_when: { set: false } }, tooltip: `${F("default_from")}.tooltip` },
    // Which sez slot the period label advances at revive — closed-enum
    // badge select, gated like `default_from` on `revive_every`.
    { key: "revive_slot", label_key: F("revive_slot"), type: "badge", order: 15, immutable: true, default_visible: false, depends_on: { field: "revive_every", disabled_when: { set: false } }, badge: { values: {
      sez: { label_key: F("revive_slot_values.sez"), color: "sky-500" },
      sez2: { label_key: F("revive_slot_values.sez2"), color: "violet-500" },
      sez3: { label_key: F("revive_slot_values.sez3"), color: "teal-500" },
    } }, tooltip: `${F("revive_slot")}.tooltip` },
    // Overlap window — editable operational slack (moves only `switch_at`).
    { key: "revive_grace", label_key: F("revive_grace"), type: "text", format: "revive_offset", order: 16, default_visible: false, depends_on: { field: "revive_every", disabled_when: { set: false } }, tooltip: `${F("revive_grace")}.tooltip` },
    // `binding_key` — machine series identity written ONLY at binding
    // materialize; `name` on bound rows already displays `<table>.<field>`.
    { key: "binding_key", label_key: F("binding_key"), type: "text", order: 17, hidden: true },
    // Revive lifecycle facts — `audited` by decision: the audit band +
    // accordion own them and the form can never render them by
    // construction. `expire_at`/`switch_at` are computed anchors, never
    // write keys; `revived_*` stamp the last revive event.
    { key: "expire_at", label_key: F("expire_at"), type: "datetime", order: 18, audited: true, default_visible: false },
    { key: "switch_at", label_key: F("switch_at"), type: "datetime", order: 19, audited: true, default_visible: false },
    { key: "revived_from", label_key: F("revived_from"), type: "ref", ref: { entity: "sequence" }, order: 20, audited: true, default_visible: false },
    { key: "revived_at", label_key: F("revived_at"), type: "datetime", order: 21, audited: true, default_visible: false },
    { key: "revived_by", label_key: F("revived_by"), type: "text", order: 22, audited: true, default_visible: false, options_source: "audit.actors" },
    // i18n keys are operator-managed pointers — hidden by default,
    // toggleable via the column picker.
    { key: "description_key", label_key: F("description_key"), type: "text", format: "i18n_key", order: 13, default_visible: false },
    // `audited` authored ONLY on the last_alloc_* virtuals: it places
    // them in the ELT audit band (the physical-writable exclusion the
    // flag implies on data columns is a no-op on enrichments). Same
    // anatomy as the standard audit stamps — `default_visible:false`,
    // toggleable via the column picker.
    { key: "last_alloc_at", label_key: F("last_alloc_at"), type: "datetime", order: 23, kind: "virtual", audited: true, default_visible: false },
    { key: "last_alloc_by", label_key: F("last_alloc_by"), type: "text", order: 24, kind: "virtual", audited: true, default_visible: false },
  ];
  return raw.map((c) => ({ ...c, sticky: STICKY_KEYS.has(c.key) }));
}

function sequenceMeta(ns: string): EntityMeta {
  return withColumnConstraints(
    {
      entity: "sequence",
      translation_key: "sequence",
      entities_ns: ns,
      uid: "uuid",
      display_field: "name",
      columns: sequenceColumns(ns),
      table: {
        default_view: "table",
        default_sort: SEQUENCE_DEFAULT_SORT,
        default_page_size: 25,
        page_size_options: [10, 25, 50],
      },
      // Create opens the record sheet in `mode:"create"` — no census
      // create route (a sheet is never a nav leaf). The list CTA
      // auto-wires from this declaration.
      create: { surface: "sheet" },
      // No route-level `page_props.form` exists for a builtin entity —
      // the entity-level axis carries the cross-field contract the
      // synthesized form attaches (wire validator runs the same core
      // predicate server-side).
      form: { validators: ["sequence_revive_shape"] },
      // Soft-delete reads as "disable" on sequences — same semantics as
      // job_trigger: exec-stop icon + destructive for the off-transition,
      // exec-start + success for the re-enable. Underlying mechanics stay
      // soft-delete/restore.
      actions_overrides: {
        "delete.single": { label_key: `${ns}.entities.sequence.actions.disable`, icon: "exec-stop", color: "destructive", confirm_key: `${ns}.entities.sequence.actions.disable_confirm`, busy_key: `${ns}.entities.sequence.actions.disabling` },
        "delete.bulk": { label_key: `${ns}.entities.sequence.actions.disable`, icon: "exec-stop", color: "destructive", confirm_key: `${ns}.entities.sequence.actions.disable_entities_confirm`, busy_key: `${ns}.entities.sequence.actions.disabling` },
        "restore.single": { label_key: `${ns}.entities.sequence.actions.enable`, icon: "exec-start", color: "success", confirm_key: `${ns}.entities.sequence.actions.enable_confirm`, busy_key: `${ns}.entities.sequence.actions.enabling` },
        "restore.bulk": { label_key: `${ns}.entities.sequence.actions.enable`, icon: "exec-start", color: "success", confirm_key: `${ns}.entities.sequence.actions.enable_entities_confirm`, busy_key: `${ns}.entities.sequence.actions.enabling` },
      },
    },
    SequenceEntity,
  );
}

// ─── the service (dal-owned — DomainService lives here) ─────────────────

export class SequencesService extends DomainService<SequenceEntity & Record<string, unknown>> {
  constructor(actor: () => string, ownedSchema?: string) {
    super({
      entity: SequenceEntity,
      actor,
      list: { meta: sequenceMeta(ownedNamespace(ownedSchema)), defaultSort: SEQUENCE_DEFAULT_SORT },
    });
  }

  /** Counter rows are machine state — reachable ONLY through the governed
   *  entity-service door (audit cols stamped from cfg.actor), never routed. */
  private counterSvc() {
    return this.svcFor(SequenceCounterEntity);
  }

  /** `sez`-slot → partition context (absent slots are undefined, never ""). */
  private sezCtx(spec: { sez?: string; sez2?: string; sez3?: string }): SequencePartitions {
    return {
      ...(spec.sez !== undefined ? { sez: spec.sez } : {}),
      ...(spec.sez2 !== undefined ? { sez2: spec.sez2 } : {}),
      ...(spec.sez3 !== undefined ? { sez3: spec.sez3 } : {}),
    } as SequencePartitions;
  }

  private counterBy(
    sequence_uuid: string,
    period_key: string,
    partition_key: string,
  ): Promise<SequenceCounterEntity | null> {
    return this.counterSvc().find<SequenceCounterEntity>(null, {
      throwIfNotFound: false,
      filters: [
        Filter.fieldValue(field(SequenceCounterEntity, "sequence_uuid"), "=", sequence_uuid),
        Filter.fieldValue(field(SequenceCounterEntity, "period_key"), "=", period_key),
        Filter.fieldValue(field(SequenceCounterEntity, "partition_key"), "=", partition_key),
      ],
    });
  }

  /** Read-only forecast — the value the next claim WOULD emit. Never
   *  creates/updates the counter row, never allocates. */
  private async forecastRow(row: {
    uuid: string; pattern: string; start: bigint; tz: string;
  }, parts: SequencePartitions, at: Date): Promise<{
    period_key: string; partition_key: string; counter: bigint | null; next: string;
  }> {
    const pattern = parseSequencePattern(row.pattern);
    const partition_key = sequencePartitionKey(pattern, parts);
    const period_key = derivePeriodKey(pattern.period_kind, at, row.tz);
    const counter = await this.counterBy(row.uuid, period_key, partition_key);
    const n = counter ? counter.counter : row.start;
    return {
      period_key,
      partition_key,
      counter: counter?.counter ?? null,
      next: renderSequenceValue(pattern, n, at, { tz: row.tz, partitions: parts }),
    };
  }

  /** Batch counter projection for served rows — virtual columns the list
   *  renders as machine state. Semantics per row, evaluated on the
   *  DEFAULT partition ("") at the row's CURRENT period key:
   *    - `value_next`    — next-to-emit number: `counter ?? start`
   *    - `value_actual`  — last emitted number: `counter - step` (null
   *                        before the first claim in the current period)
   *    - `emitted_next`  — the pattern rendered with `value_next`
   *    - `emitted_actual`— the pattern rendered with `value_actual`
   *    - `last_alloc_at`/`last_alloc_by` — attribution of the last claim
   *  Multi-period/multi-partition counters project ONLY their default-
   *  context slice — the forecast RPC covers explicit sez contexts;
   *  `emitted_*` are `null` when the pattern needs sezionale context. */
  private async attachCounterProjection(rows: Array<Record<string, unknown>>): Promise<void> {
    if (rows.length === 0) return;
    const now = new Date();
    // Default-partition key: the sez tuple with all slots empty
    // (`\x1f`-joined — see sequencePartitionKey in @primebrick/core).
    const EMPTY_PARTITION = "\x1f\x1f";
    const counters = await this.counterSvc().query<SequenceCounterEntity>(null, {
      filters: [
        Filter.fieldValue(
          field(SequenceCounterEntity, "sequence_uuid"), "IN",
          rows.map((r) => r.uuid as string),
        ),
        Filter.fieldValue(field(SequenceCounterEntity, "partition_key"), "=", EMPTY_PARTITION),
      ],
    });
    const byKey = new Map(counters.map((c) => [`${c.sequence_uuid}|${c.period_key}`, c]));
    for (const row of rows) {
      const pattern = parseSequencePattern(row.pattern as string);
      const tz = row.tz as string;
      const counter = byKey.get(
        `${row.uuid}|${derivePeriodKey(pattern.period_kind, now, tz)}`,
      );
      const step = row.step as bigint;
      const next_n = counter?.counter ?? (row.start as bigint);
      const actual_n = counter ? counter.counter - step : null;
      row.value_next = next_n;
      row.value_actual = actual_n;
      row.last_alloc_at = counter?.last_alloc_at ?? null;
      row.last_alloc_by = counter?.last_alloc_by ?? null;
      const has_sez = pattern.sez_slots.length > 0;
      row.emitted_next = has_sez
        ? null
        : renderSequenceValue(pattern, next_n, now, { tz, partitions: {} });
      row.emitted_actual = has_sez || actual_n === null
        ? null
        : renderSequenceValue(pattern, actual_n, now, { tz, partitions: {} });
    }
  }

  /** Update path — revive axes are editable WHILE IN TEMPO: the persisted
   *  moments (`expire_at`/`switch_at`) recompute here, and the atomic
   *  guard lives in `sequenceReviveAxesUpdate`'s WHERE (the sweep locks
   *  the row `FOR UPDATE`, this UPDATE locks it back — whoever commits
   *  second sees the other through the guard predicates).
   *
   *  Recompute rules — anchored at NOW (mid-generation edits; the
   *  create-time `default_from` anchor is history):
   *   - `revive_every='N unit'` → `expire_at` = next calendar boundary;
   *   - `revive_every='at <ISO>'` → the literal pin (must stay future);
   *   - `revive_every→NULL`    → revive off — clears expire/switch/slot
   *     (permanent final generation);
   *   - `switch_at` always recomputes when an axis moves: `expire+grace`,
   *     an `'until'` literal verbatim, `expire_at` when grace is NULL.
   *
   *  `version` rides the optimistic-lock lane via `super.update` inside
   *  the SAME tx — a lost race rolls the guarded write back with it. */
  override async update(
    uuid: string,
    body: Record<string, unknown> & { version: bigint },
    tx?: import("../repository/repository.js").Repository,
  ): Promise<SequenceEntity & Record<string, unknown>> {
    const stored = await this.get(uuid, { throwIfNotFound: true });
    // An axis that arrives UNCHANGED is not an edit — the form write
    // contract ships the full editable surface on every save, so presence
    // alone cannot arm the in-tempo guard: editing the NAME of a
    // non-reviving (or already-expired) sequence must stay possible.
    const everyEdit =
      "revive_every" in body && (body.revive_every ?? null) !== (stored.revive_every ?? null);
    const graceEdit =
      "revive_grace" in body && (body.revive_grace ?? null) !== (stored.revive_grace ?? null);
    const pick = <T>(k: string): T | null | undefined =>
      k in body ? (body[k] as T | null) : (stored[k] as T | null | undefined);
    const mergedEvery = everyEdit
      ? (body.revive_every as string | null)
      : (stored.revive_every ?? null);
    // Revive-off clears the slot in the same write — the merged view the
    // coherence contract sees.
    const mergedSlot =
      everyEdit && body.revive_every === null ? null : (stored.revive_slot ?? null);
    assertReviveCoherence({
      pattern: (pick<string>("pattern") ?? stored.pattern) as string,
      sez: pick<string>("sez"),
      sez2: pick<string>("sez2"),
      sez3: pick<string>("sez3"),
      revive_every: mergedEvery,
      revive_slot: mergedSlot,
    });
    if (!everyEdit && !graceEdit) return super.update(uuid, body, tx);

    const tz = (stored.tz as string | null) ?? "UTC";
    const now = new Date();
    // Entity reads surface timestamptz as ISO strings — coerce before math.
    const asDate = (v: unknown): Date | null => (v ? new Date(v as string) : null);
    let expire_at = asDate(stored.expire_at);
    if (everyEdit) {
      const every = body.revive_every as string | null;
      if (every === null) {
        expire_at = null;
      } else {
        const spec = parseReviveSpec(every); // wire-validated upstream
        expire_at = spec?.kind === "at" ? spec.at : reviveExpireAt(now, every, tz);
        if (expire_at.getTime() <= now.getTime()) {
          const err = new ValidationError(
            `sequence: 'at' pin ${expire_at.toISOString()} is not in the future — the row would die on arrival`,
          ) as ValidationError & { issues?: unknown[] };
          err.issues = [{ path: "revive_every", code: "schema_mismatch", message: "app.common.validation.sequence_revive_pin_past" }];
          throw err;
        }
      }
    }
    const mergedGrace = graceEdit
      ? (body.revive_grace as string | null)
      : ((stored.revive_grace as string | null | undefined) ?? null);
    const switch_at =
      expire_at === null
        ? null
        : mergedGrace
          ? reviveAddInterval(expire_at, mergedGrace, tz)
          : expire_at;
    if (expire_at !== null && switch_at !== null && switch_at.getTime() < expire_at.getTime()) {
      const err = new ValidationError(
        `sequence: switch_at ${switch_at.toISOString()} cannot precede expire_at ${expire_at.toISOString()}`,
      ) as ValidationError & { issues?: unknown[] };
      err.issues = [{ path: "revive_grace", code: "schema_mismatch", message: "app.common.validation.sequence_switch_before_expire" }];
      throw err;
    }

    const run = async (t: import("../repository/repository.js").Repository) => {
      // The axes ride the guarded write; the rest (name, description_key,
      // version, audit) goes through the standard update in the same tx.
      const { revive_every: _e, revive_grace: _g, ...rest } = body;
      const otherFields = Object.keys(rest).some((k) => k !== "version");
      await t.sequenceReviveAxesUpdate({
        uuid,
        version: body.version,
        ...(everyEdit ? { every: body.revive_every as string | null } : {}),
        ...(graceEdit ? { grace: body.revive_grace as string | null } : {}),
        expire_at,
        switch_at,
        bumpVersion: !otherFields,
        actor: this.cfg.actor?.() ?? "system",
      });
      if (!otherFields) {
        // Axes-only — the guarded write already bumped the version; the
        // generic update has no user fields to set (it would throw
        // "no fields to update"). Re-read the row inside the tx.
        return this.get(uuid, { throwIfNotFound: true }) as Promise<SequenceEntity & Record<string, unknown>>;
      }
      return super.update(uuid, rest as typeof body, t);
    };
    return tx ? run(tx) : this.svc.transaction(run);
  }

  /** Create path — the wire validator already ran `assertReviveCoherence`
   *  on the full body; this override exists only to stamp the derived
   *  revive anchors (`expire_at`/`switch_at`/`default_from`) that the
   *  route surface never accepts as write keys. */
  override async create(
    body: Record<string, unknown>,
    tx?: import("../repository/repository.js").Repository,
  ): Promise<SequenceEntity & Record<string, unknown>> {
    return super.create({ ...body, ...reviveAnchors(body) }, tx);
  }

  override async list(query: EntityListQuery): Promise<EntityListResult<SequenceEntity & Record<string, unknown>>> {
    const res = await super.list(query);
    await this.attachCounterProjection(res.rows as unknown as Record<string, unknown>[]);
    return res;
  }

  override async get(uuid: string, options?: EntityGetOptions & { throwIfNotFound?: true }): Promise<SequenceEntity & Record<string, unknown>>;
  override async get(uuid: string, options: EntityGetOptions & { throwIfNotFound: false }): Promise<(SequenceEntity & Record<string, unknown>) | null>;
  override async get(uuid: string, options?: EntityGetOptions): Promise<(SequenceEntity & Record<string, unknown>) | null> {
    const row = await super.get(uuid, options as never);
    if (row) await this.attachCounterProjection([row as unknown as Record<string, unknown>]);
    return row;
  }

  /** `sequence-forecast` RPC — explicit-context (sez and at) forecast.
   *  READ-ONLY by construction: uuid resolution + counter SELECT +
   *  render. uuid is the ONLY sequence identity — `name` is display
   *  data and is never accepted as an address. */
  async forecast(spec: {
    uuid: string;
    sez?: string; sez2?: string; sez3?: string;
    at?: Date;
  }) {
    const row = await this.get(spec.uuid, { throwIfNotFound: true });
    const parts = validateSequencePartitions(parseSequencePattern(row.pattern as string), this.sezCtx(spec));
    const f = await this.forecastRow(
      { uuid: row.uuid as string, pattern: row.pattern as string, start: row.start as bigint, tz: row.tz as string },
      parts,
      spec.at ?? new Date(),
    );
    return { uuid: row.uuid, name: row.name, ...f };
  }

  /** `sequence-set` RPC — governed counter re-seed: writes the explicit
   *  next-to-emit value for (uuid, period derived from `at`, partition
   *  from `sez*`). Never allocates, never emits a value. The counter row
   *  is created when the period/partition was never claimed. */
  async setCounter(spec: {
    uuid: string; next: bigint;
    sez?: string; sez2?: string; sez3?: string;
    at?: Date;
  }) {
    const row = await this.get(spec.uuid, { throwIfNotFound: true });
    const pattern = parseSequencePattern(row.pattern as string);
    const parts = validateSequencePartitions(pattern, this.sezCtx(spec));
    const partition_key = sequencePartitionKey(pattern, parts);
    const period_key = derivePeriodKey(pattern.period_kind, spec.at ?? new Date(), row.tz as string);
    const existing = await this.counterBy(spec.uuid, period_key, partition_key);
    const saved = existing
      ? await this.counterSvc().update(existing.uuid, { counter: spec.next, version: existing.version })
      : await this.counterSvc().create({
          sequence_uuid: spec.uuid,
          period_key,
          partition_key,
          counter: spec.next,
        });
    return { uuid: spec.uuid, period_key, partition_key, counter: saved.counter };
  }

  /** `sequence-revive` RPC — operator-triggered revive of ONE row: runs
   *  the same atomic primitive the JH job fires (`sequenceRevive` with
   *  `only_uuid`), under the caller's actor (`revived_by` attribution).
   *  A not-due row is a clean no-op report — the contract is "catch up
   *  if expired", never a forced generation skip. Phase B always sweeps
   *  the whole table. */
  async revive(spec: { uuid: string }) {
    const row = await this.get(spec.uuid, { throwIfNotFound: true });
    return this.svc.transaction((tx) =>
      tx.sequenceRevive({ actor: this.cfg.actor?.() ?? "system", only_uuid: row.uuid as string }),
    );
  }

  /** `sequence-analyze` RPC — read-only column-usage scan for the
   *  pattern (the operator's pre-check before `sequence-set` or a fresh
   *  bind). Delegates to the repository primitive inside a governed tx —
   *  pure SELECTs, nothing mutates. */
  async analyze(spec: {
    uuid: string;
    table?: string; column?: string;
    sez?: string; sez2?: string; sez3?: string;
    at?: Date;
  }) {
    return this.svc.transaction((tx) =>
      tx.sequenceAnalyze({
        seq: { uuid: spec.uuid },
        ...(spec.table !== undefined ? { table: spec.table } : {}),
        ...(spec.column !== undefined ? { column: spec.column } : {}),
        ...(spec.sez !== undefined ? { sez: spec.sez } : {}),
        ...(spec.sez2 !== undefined ? { sez2: spec.sez2 } : {}),
        ...(spec.sez3 !== undefined ? { sez3: spec.sez3 } : {}),
        ...(spec.at !== undefined ? { at: spec.at } : {}),
      }),
    );
  }
}

// ─── wire validators (zod-free — dal carries no zod) ─────────────────────

function bad(field: string, why: string): never {
  throw new ValidationError(`sequence.${field}: ${why}`);
}

function vString(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) bad(field, `must be a non-empty string ≤${max} chars`);
  return v;
}

function vBigint(v: unknown, field: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  bad(field, "must be an integer");
}

function vIanaTz(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const tz = vString(v, "tz", 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    bad("tz", "must be a valid IANA timezone");
  }
  return tz;
}

function vPattern(v: unknown): string {
  const p = vString(v, "pattern", 1000);
  try {
    parseSequencePattern(p);
  } catch (e) {
    bad("pattern", (e as Error).message);
  }
  return p;
}

function vOptKey(v: unknown, field: string, max: number): string | null {
  if (v === null || v === undefined || v === "") return null;
  return vString(v, field, max);
}

const SEQUENCE_WRITE_KEYS = new Set([
  "name", "pattern", "step", "start", "tz", "description_key",
  "sez", "sez2", "sez3", "revive_every", "revive_grace", "revive_slot",
  "default_from",
  "version",
]);

function vReviveSpec(v: unknown, field: "revive_every" | "revive_grace"): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = vString(v, field, 40);
  const ok = field === "revive_every" ? parseReviveSpec(s) : parseGraceSpec(s);
  if (!ok) {
    bad(
      field,
      field === "revive_every"
        ? `must be 'N (day|week|month|quarter|year)[s]' or 'at <RFC3339>' — got "${s}"`
        : `must be 'N (day|week|month|quarter|year)[s]' or 'until <RFC3339>' — got "${s}"`,
    );
  }
  return s;
}

function vReviveSlot(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = vString(v, "revive_slot", 10);
  if (!["sez", "sez2", "sez3"].includes(s)) {
    bad("revive_slot", "must be sez, sez2 or sez3");
  }
  return s;
}

function vInstant(v: unknown, field: string): Date {
  const d = new Date(v as string | number | Date);
  if (Number.isNaN(d.getTime())) bad(field, "must be a date");
  return d;
}

function vWriteEntity(body: unknown, partial: boolean): Record<string, unknown> {
  const e = (body as { entity?: unknown })?.entity;
  if (typeof e !== "object" || e === null || Array.isArray(e)) bad("entity", "missing entity body");
  const rec = e as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (!SEQUENCE_WRITE_KEYS.has(k)) bad("entity", `unknown field "${k}"`);
  }
  const out: Record<string, unknown> = {};
  const need = (k: string) => {
    if (rec[k] === undefined) {
      if (!partial) bad(k, "required");
      return false;
    }
    return true;
  };
  const opt = (k: string) => rec[k] !== undefined;
  if (need("name")) out.name = vString(rec.name, "name", 100);
  if (need("pattern")) out.pattern = vPattern(rec.pattern);
  // step/start carry `defaultSql:"1"` — OPTIONAL on the wire: an omitted
  // value stays out of the payload and the DB applies its DEFAULT; a
  // PROVIDED value is still validated strictly (0n rejected — the
  // validator enforces the perimeter, the default only fills gaps).
  if (opt("step")) {
    const s = vBigint(rec.step, "step");
    if (s === 0n) bad("step", "must be non-zero");
    out.step = s;
  }
  if (opt("start")) out.start = vBigint(rec.start, "start");
  // tz carries `defaultSql:"'UTC'"` — same OPTIONAL contract as
  // step/start: an omitted/empty value stays out of the payload and the
  // DB applies its DEFAULT; a provided value is IANA-validated strictly.
  if (opt("tz")) {
    const tz = vIanaTz(rec.tz);
    if (tz !== null) out.tz = tz;
  }
  if (opt("description_key")) out.description_key = vOptKey(rec.description_key, "description_key", 200);
  // Row-owned sezionale defaults — charset-gated at the wire; the
  // pattern-slot coherence check runs against the merged row in
  // `assertReviveCoherence` (service-level, sees the stored pattern on
  // update too).
  for (const k of ["sez", "sez2", "sez3"] as const) {
    if (partial) {
      // Row-owned sezionale defaults are the revive axis identity —
      // frozen post-create like the cadence that advances them.
      if (rec[k] !== undefined) bad(k, "immutable after create");
    } else if (opt(k)) {
      out[k] = vSezValue(rec[k], k);
    }
  }
  // `revive_slot`/`default_from` are IMMUTABLE post-create — the slot
  // choice and the serve anchor are the row's identity. The revive
  // AXES (`revive_every`/`revive_grace`) are editable while in tempo —
  // the service's guarded write owns the moment contract (`FOR UPDATE`
  // serialization vs the sweep); `revive_every→NULL` is "revive off".
  if (partial) {
    if (rec.revive_slot !== undefined) bad("revive_slot", "immutable after create");
    if (rec.default_from !== undefined) bad("default_from", "immutable after create");
  } else {
    if (opt("revive_slot")) out.revive_slot = vReviveSlot(rec.revive_slot);
    if (opt("default_from")) out.default_from = vInstant(rec.default_from, "default_from");
  }
  if (opt("revive_every")) out.revive_every = vReviveSpec(rec.revive_every, "revive_every");
  if (opt("revive_grace")) out.revive_grace = vReviveSpec(rec.revive_grace, "revive_grace");
  if (!partial) {
    assertReviveCoherence(out as Parameters<typeof assertReviveCoherence>[0]);
  }
  if (partial) {
    // `version` rides int8 on the wire — ext-json decodes it as `bigint`.
    // Accept the full vBigint input domain (wire bigint, legacy number,
    // SQL-text) and keep the domain type — no down-cast.
    const v = vBigint(rec.version, "version");
    if (v < 0n) bad("version", "required non-negative integer");
    out.version = v;
  }
  return out;
}

/** Derived revive anchors stamped at create — never write keys:
 *   `expire_at`   = first calendar boundary after `default_from` (row tz)
 *   `switch_at`   = expire_at + revive_grace (grace absent → expire_at)
 *   `default_from`= the authored anchor instant (omitted → create instant,
 *                   the row serves immediately)
 * Non-reviving rows get no anchors (all NULL). */
function reviveAnchors(body: Record<string, unknown>): Record<string, unknown> {
  const every = body.revive_every as string | null | undefined;
  if (!every) return {};
  const tz = (body.tz as string | null | undefined) ?? "UTC";
  const anchor = (body.default_from as Date | undefined) ?? new Date();
  const expire_at = reviveExpireAt(anchor, every, tz);
  // An interval always lands strictly after the anchor by construction;
  // an `'at'` pin can die on arrival (past instant, or before the row
  // even starts serving) — that's a contract error, not an anchor.
  if (expire_at <= anchor) {
    const err = new ValidationError(
      `sequence: expire_at ${expire_at.toISOString()} must fall after default_from ${anchor.toISOString()} — an 'at' pin before the row starts serving is dead on arrival`,
    ) as ValidationError & { issues?: unknown[] };
    err.issues = [{ path: "revive_every", code: "schema_mismatch", message: "app.common.validation.sequence_expire_before_default_from" }];
    throw err;
  }
  const grace = body.revive_grace as string | null | undefined;
  const switch_at = grace ? reviveAddInterval(expire_at, grace, tz) : expire_at;
  if (switch_at < expire_at) {
    const err = new ValidationError(
      `sequence: switch_at ${switch_at.toISOString()} cannot precede expire_at ${expire_at.toISOString()} — an 'until' pin before the revive has no window`,
    ) as ValidationError & { issues?: unknown[] };
    err.issues = [{ path: "revive_grace", code: "schema_mismatch", message: "app.common.validation.sequence_switch_before_expire" }];
    throw err;
  }
  return { expire_at, switch_at, default_from: anchor };
}

function vSezValue(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = vString(v, field, 200);
  if (!SEZ_VALUE_RE.test(s)) {
    bad(field, "must match charset [A-Za-z0-9_./-]");
  }
  return s;
}

/** Cross-field revive contract on the merged row — the wire validator
 *  owns shape; this owns coherence. Runs on create (full body) and on
 *  update (stored row merged with the accepted patch), so pattern/sez
 *  edits can never leave a reviving row inconsistent. The contract lives
 *  in core's `sequenceReviveShapeIssues` — the SAME predicate the form's
 *  cross-field registry runs; issues ride the `err.issues` channel
 *  `toValidationError` lifts into `extra.issues` (RFC 7807 error viewer). */
function assertReviveCoherence(row: {
  pattern: string;
  sez?: string | null; sez2?: string | null; sez3?: string | null;
  revive_every?: string | null;
  revive_slot?: string | null;
}): void {
  const issues = sequenceReviveShapeIssues(row);
  if (issues.length === 0) return;
  const err = new ValidationError(
    `sequence: revive contract failed — ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
  ) as ValidationError & { issues?: unknown[] };
  err.issues = issues.map((i) => ({ path: i.path, code: i.code, message: i.message }));
  throw err;
}

// ─── the decl factory ────────────────────────────────────────────────────

export interface BuiltinDeclCtx {
  actor: () => string;
  /** The module's declared schema list (code const, [0] = owned). Carried
   *  through the cross-package ctx so builtin decls resolve their i18n
   *  namespace without env and without waiting for the dal domain. */
  schemas?: readonly string[];
}

/** Nav contribution — the `sequences` leaf under the module's "settings"
 *  sibling, appended LAST by createMicroservice (arrays carry the order
 *  at every level). label keys derive from the module's own schema
 *  namespace — never authored. */
export function builtinSequenceNav(ctx: BuiltinDeclCtx) {
  const ns = ownedNamespace(ctx.schemas?.[0]);
  return {
    sibling_id: "settings",
    sibling_label_key: `${ns}.settings.nav.label`,
    sibling_icon: "settings",
    leaf_id: "sequences",
    label_key: `${ns}.settings.nav.sequences`,
    icon: "sequence-numeric-right",
    entity: "sequence",
  };
}

/** Build the `sequence` EntityRouteDecl for the calling module. The
 *  return type is structural — dal cannot import the SDK's
 *  EntityRouteDecl; makeServiceRoutes consumes the shape. */
export function builtinSequenceEntityDecl(ctx: BuiltinDeclCtx): Record<string, unknown> {
  const ns = ownedNamespace(ctx.schemas?.[0]);
  const meta = sequenceMeta(ns);
  const P = (op: string, scope: string) => `${ns}.sequence.${op}.${scope}`;
  return {
    entityName: "sequence",
    spec: { tag: "sequences", label: "sequence" },
    service: new SequencesService(ctx.actor, ns),
    meta,
    permissions: {
      meta: [P("read", "all"), P("read", "single")],
      list: [P("read", "all")],
      get: [P("read", "single")],
      create: [P("create", "single")],
      update: [P("update", "single")],
      delete: [P("delete", "single")],
      restore: [P("restore", "single")],
      export: [P("export", "all")],
      audit: [P("read", "audit")],
      bulkDelete: [P("delete", "bulk")],
      bulkRestore: [P("restore", "bulk")],
    },
    schemas: {
      listQuery: (q: Record<string, unknown>) => {
        const { sortable } = listColumnKeys(meta.columns);
        if (q?.sort_key !== undefined && !sortable.includes(q.sort_key as string)) {
          bad("sort_key", `must be one of [${sortable.join(", ")}]`);
        }
        return q;
      },
      createBody: (b: unknown) => ({ entity: vWriteEntity(b, false) }),
      updateBody: (b: unknown) => ({ entity: vWriteEntity(b, true) }),
      auditQuery: (q: Record<string, unknown>) => {
        const page = Number(q?.page ?? 1);
        const limit = Number(q?.limit ?? 50);
        if (!Number.isInteger(page) || page < 1) bad("page", "must be a positive integer");
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) bad("limit", "must be 1..50");
        return { page, limit };
      },
    },
  };
}

// ─── governed RPC routes (sequence.set / sequence.forecast) ──────────────

/** sez/at wire context shared by the two RPC bodies. */
function vSezCtx(rec: Record<string, unknown>): {
  sez?: string; sez2?: string; sez3?: string; at?: Date;
} {
  const out: { sez?: string; sez2?: string; sez3?: string; at?: Date } = {};
  for (const k of ["sez", "sez2", "sez3"] as const) {
    if (rec[k] !== undefined && rec[k] !== null && rec[k] !== "") {
      out[k] = vString(rec[k], k, 200);
    }
  }
  if (rec.at !== undefined && rec.at !== null) {
    const d = new Date(rec.at as string | number);
    if (Number.isNaN(d.getTime())) bad("at", "must be a date");
    out.at = d;
  }
  return out;
}

function vObjectBody(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad("body", "object required");
  return raw as Record<string, unknown>;
}

function vSetBody(raw: unknown): {
  uuid: string; next: bigint;
  sez?: string; sez2?: string; sez3?: string; at?: Date;
} {
  const rec = vObjectBody(raw);
  return {
    uuid: vString(rec.uuid, "uuid", 40),
    next: vBigint(rec.next, "next"),
    ...vSezCtx(rec),
  };
}

function vForecastBody(raw: unknown): {
  uuid: string;
  sez?: string; sez2?: string; sez3?: string; at?: Date;
} {
  const rec = vObjectBody(raw);
  // uuid is the ONLY sequence identity — `name` is display data and is
  // never accepted on the wire.
  return { uuid: vString(rec.uuid, "uuid", 40), ...vSezCtx(rec) };
}

function vAnalyzeBody(raw: unknown): {
  uuid: string;
  table?: string; column?: string;
  sez?: string; sez2?: string; sez3?: string; at?: Date;
} {
  const rec = vObjectBody(raw);
  const uuid = vString(rec.uuid, "uuid", 40);
  const table = rec.table === undefined || rec.table === null ? undefined : vString(rec.table, "table", 63);
  const column = rec.column === undefined || rec.column === null ? undefined : vString(rec.column, "column", 63);
  if ((table === undefined) !== (column === undefined)) bad("target", "table and column must come together");
  return {
    uuid,
    ...(table !== undefined ? { table } : {}),
    ...(column !== undefined ? { column } : {}),
    ...vSezCtx(rec),
  };
}

/** Builtin RPC routes for the `sequence` entity — mounted by
 *  makeServiceRoutes from the same globalThis factory registry as the
 *  entity decl (a module-authored `/api/v1/actions/sequence-*` route is
 *  the module's own name, but `entity_op:"sequence"` outside this
 *  factory is the module reaching builtin governance — the decl already
 *  rejects a module-authored `sequence` entity at boot).
 *
 *  `sequence-set` — governed counter re-seed: explicit permission
 *  (`<ns>.sequence.set.single`), pre-dispatch confirm CTA on the sequence
 *  row, MFA step-up. Never allocates — `next` is the next-to-emit value.
 *  `sequence-forecast` — read-only `next` probe for explicit sez/at
 *  context (the combobox/widget "what comes next" call).
 *
 *  The return type is structural — dal cannot import the SDK's RpcRoute;
 *  makeServiceRoutes consumes the shape. */
export function builtinSequenceRpc(ctx: BuiltinDeclCtx): Record<string, unknown>[] {
  const ns = ownedNamespace(ctx.schemas?.[0]);
  const svc = new SequencesService(ctx.actor, ns);
  const P = (op: string, scope: string) => `${ns}.sequence.${op}.${scope}`;
  return [
    {
      method: "POST",
      path: "/api/v1/actions/sequence-set",
      permissions: [P("set", "single")],
      auth: "user",
      mfa: { action: "sequence.set", target_resource: "sequence" },
      entity_op: {
        entity: "sequence",
        op: "sequence_set",
        cta: {
          icon: "sequence-numeric-right",
          confirm_key: `${ns}.actions.sequence_set_confirm`,
        },
      },
      openapi: {
        summary: "Set a sequence counter",
        description:
          "Governed counter re-seed: writes the explicit next-to-emit value for a sequence " +
          "period/partition (derived from `at`/`sez*`). Requires MFA step-up and " +
          "pre-dispatch confirmation. Never allocates — allocation is write-path only.",
        tags: ["sequences"],
        requestSchema: {
          type: "object",
          required: ["uuid", "next"],
          properties: {
            uuid: { type: "string" },
            next: { type: "integer", description: "bigint — ext-json encodes it natively" },
            sez: { type: "string" }, sez2: { type: "string" }, sez3: { type: "string" },
            at: { type: "string", format: "date-time" },
          },
        },
        responseSchema: {
          type: "object",
          properties: {
            uuid: { type: "string" },
            period_key: { type: "string" },
            partition_key: { type: "string" },
            counter: { type: "integer" },
          },
        },
      },
      body: vSetBody,
      handler: async (c: { body: Parameters<SequencesService["setCounter"]>[0] }) => svc.setCounter(c.body),
    },
    {
      method: "POST",
      path: "/api/v1/actions/sequence-revive",
      permissions: [P("revive", "single")],
      auth: "user",
      mfa: { action: "sequence.revive", target_resource: "sequence" },
      entity_op: {
        entity: "sequence",
        op: "sequence_revive",
        cta: {
          icon: "rotate-cw-square",
          confirm_key: `${ns}.actions.sequence_revive_confirm`,
        },
      },
      openapi: {
        summary: "Revive a sequence generation",
        description:
          "Operator-triggered revive of one sequence row: runs the same atomic " +
          "primitive the job fires (successor clone + chained catch-up + " +
          "grace-windowed switch). A not-due row is a clean no-op report — " +
          "never a forced generation skip. `revived_by` carries the caller.",
        tags: ["sequences"],
        requestSchema: {
          type: "object",
          required: ["uuid"],
          properties: { uuid: { type: "string" } },
        },
        responseSchema: {
          type: "object",
          properties: {
            revived: { type: "array", items: { type: "object" } },
            switched: { type: "array", items: { type: "string" } },
          },
        },
      },
      body: (raw: unknown) => ({ uuid: vString(vObjectBody(raw).uuid, "uuid", 40) }),
      handler: async (c: { body: { uuid: string } }) => svc.revive(c.body),
    },
    {
      method: "POST",
      path: "/api/v1/actions/sequence-forecast",
      permissions: [P("read", "single")],
      auth: "user",
      openapi: {
        summary: "Forecast a sequence's next value",
        description:
          "Read-only probe: renders the value the next claim would emit for the given " +
          "sequence and sez*/at context. Never creates or mutates the counter.",
        tags: ["sequences"],
        requestSchema: {
          type: "object",
          required: ["uuid"],
          properties: {
            uuid: { type: "string" },
            sez: { type: "string" }, sez2: { type: "string" }, sez3: { type: "string" },
            at: { type: "string", format: "date-time" },
          },
        },
        responseSchema: {
          type: "object",
          properties: {
            uuid: { type: "string" },
            name: { type: "string" },
            period_key: { type: "string" },
            partition_key: { type: "string" },
            counter: { type: ["integer", "null"] },
            next: { type: "string" },
          },
        },
      },
      body: vForecastBody,
      handler: async (c: { body: Parameters<SequencesService["forecast"]>[0] }) => svc.forecast(c.body),
    },
    {
      method: "POST",
      path: "/api/v1/actions/sequence-analyze",
      permissions: [P("read", "single")],
      auth: "user",
      openapi: {
        summary: "Analyze column usage for a sequence",
        description:
          "Read-only pre-check: scans a text column in the module's schema with the " +
          "pattern-exact regex and reports in-use count, max numeric value, proposed " +
          "next, collisions and ambiguous sibling sequences. Target derives from a " +
          "<table>.<field> bound name or explicit table/column. Never mutates state.",
        tags: ["sequences"],
        requestSchema: {
          type: "object",
          required: ["uuid"],
          properties: {
            uuid: { type: "string" },
            table: { type: "string" },
            column: { type: "string" },
            sez: { type: "string" }, sez2: { type: "string" }, sez3: { type: "string" },
            at: { type: "string", format: "date-time" },
          },
        },
        responseSchema: {
          type: "object",
          properties: {
            table: { type: "string" },
            column: { type: "string" },
            in_use: { type: "integer" },
            max_value: { type: ["integer", "null"] },
            suggested_start: { type: "integer" },
            next_proposed: { type: "string" },
            next_in_use: { type: "boolean" },
            conflicts_above: { type: "integer" },
            partitions: { type: "array", items: { type: "object" } },
            ambiguous: { type: "array", items: { type: "string" } },
          },
        },
      },
      body: vAnalyzeBody,
      handler: async (c: { body: Parameters<SequencesService["analyze"]>[0] }) => svc.analyze(c.body),
    },
  ];
}
