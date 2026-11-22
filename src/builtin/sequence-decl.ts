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
 *   - the schema/namespace is NEVER authored — it resolves to the
 *     module's `domain.primary` (or `DATABASE_SCHEMA` when the domain
 *     isn't configured yet — makeServiceRoutes runs at import time,
 *     before initDal);
 *   - permission strings derive as `<ns>.sequence.<op>.<scope>` — the
 *     decl type is readonly string[], no static enum is needed.
 */

import {
  parseSequencePattern,
  validateSequencePartitions,
  sequencePartitionKey,
  derivePeriodKey,
  renderSequenceValue,
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

/** The module's owned schema — domain when configured, else the
 *  `DATABASE_SCHEMA` env contract (same source initDal feeds). Throws
 *  when neither exists: a route surface without an owned schema cannot
 *  host builtins. */
function ownedNamespace(): string {
  const ns =
    getSchemaDomain()?.primary ??
    process.env.DATABASE_SCHEMA?.split(",")[0]?.trim();
  if (!ns) {
    throw new ValidationError(
      "builtin sequence decl: no schema domain and no DATABASE_SCHEMA — " +
        "the module's owned schema is required at construction",
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
    { key: "step", label_key: F("step"), type: "number", order: 1 },
    { key: "start", label_key: F("start"), type: "number", order: 2 },
    // Counter projection — machine state from `sequence_counters`
    // (default partition @ current period), attached post-query by
    // `attachCounterProjection`. `kind:"virtual"` forces sort/filter/
    // search off — the values are not SQL-addressable.
    { key: "value_actual", label_key: F("value_actual"), type: "number", order: 3, kind: "virtual" },
    { key: "value_next", label_key: F("value_next"), type: "number", order: 4, kind: "virtual" },
    { key: "pattern", label_key: F("pattern"), type: "text", order: 5 },
    { key: "emitted_actual", label_key: F("emitted_actual"), type: "text", order: 6, kind: "virtual" },
    { key: "emitted_next", label_key: F("emitted_next"), type: "text", order: 7, kind: "virtual" },
    { key: "tz", label_key: F("tz"), type: "text", order: 8 },
    // i18n keys are operator-managed pointers — hidden by default,
    // toggleable via the column picker.
    { key: "description_key", label_key: F("description_key"), type: "text", format: "i18n_key", order: 9, default_visible: false },
    // `audited` authored ONLY on the last_alloc_* virtuals: it places
    // them in the ELT audit band (the physical-writable exclusion the
    // flag implies on data columns is a no-op on enrichments). Same
    // anatomy as the standard audit stamps — `default_visible:false`,
    // toggleable via the column picker.
    { key: "last_alloc_at", label_key: F("last_alloc_at"), type: "datetime", order: 14, kind: "virtual", audited: true, default_visible: false },
    { key: "last_alloc_by", label_key: F("last_alloc_by"), type: "text", order: 15, kind: "virtual", audited: true, default_visible: false },
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
  constructor(actor: () => string) {
    super({
      entity: SequenceEntity,
      actor,
      list: { meta: sequenceMeta(ownedNamespace()), defaultSort: SEQUENCE_DEFAULT_SORT },
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
    uuid: string; pattern: string; start: bigint; tz: string | null;
  }, parts: SequencePartitions, at: Date): Promise<{
    period_key: string; partition_key: string; counter: bigint | null; next: string;
  }> {
    const pattern = parseSequencePattern(row.pattern);
    const partition_key = sequencePartitionKey(pattern, parts);
    const period_key = derivePeriodKey(pattern.period_kind, at, row.tz ?? undefined);
    const counter = await this.counterBy(row.uuid, period_key, partition_key);
    const n = counter ? counter.counter : row.start;
    return {
      period_key,
      partition_key,
      counter: counter?.counter ?? null,
      next: renderSequenceValue(pattern, n, at, { tz: row.tz ?? undefined, partitions: parts }),
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
      const tz = (row.tz as string | null) ?? undefined;
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
      { uuid: row.uuid as string, pattern: row.pattern as string, start: row.start as bigint, tz: row.tz as string | null },
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
    const period_key = derivePeriodKey(pattern.period_kind, spec.at ?? new Date(), (row.tz as string | null) ?? undefined);
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

const SEQUENCE_WRITE_KEYS = new Set(["name", "pattern", "step", "start", "tz", "description_key", "version"]);

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
  if (need("step")) {
    const s = vBigint(rec.step, "step");
    if (s === 0n) bad("step", "must be non-zero");
    out.step = s;
  }
  if (need("start")) out.start = vBigint(rec.start, "start");
  if (opt("tz")) out.tz = vIanaTz(rec.tz);
  if (opt("description_key")) out.description_key = vOptKey(rec.description_key, "description_key", 200);
  if (partial) {
    // `version` rides int8 on the wire — ext-json decodes it as `bigint`,
    // never `number`. Accept the full vBigint domain and down-cast
    // (audit versions fit in the safe-integer range by construction).
    const v = vBigint(rec.version, "version");
    if (v < 0n) bad("version", "required non-negative integer");
    out.version = Number(v);
  }
  return out;
}

// ─── the decl factory ────────────────────────────────────────────────────

export interface BuiltinDeclCtx {
  actor: () => string;
}

/** Nav contribution — the `sequences` leaf under the module's "settings"
 *  sibling, appended LAST by createMicroservice (arrays carry the order
 *  at every level). label keys derive from the module's own schema
 *  namespace — never authored. */
export function builtinSequenceNav() {
  const ns = ownedNamespace();
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
  const ns = ownedNamespace();
  const meta = sequenceMeta(ns);
  const P = (op: string, scope: string) => `${ns}.sequence.${op}.${scope}`;
  return {
    entityName: "sequence",
    spec: { tag: "sequences", label: "sequence" },
    service: new SequencesService(ctx.actor),
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
  const ns = ownedNamespace();
  const svc = new SequencesService(ctx.actor);
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
