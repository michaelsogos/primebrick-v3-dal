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

import { parseSequencePattern, listColumnKeys, type EntityMeta, type MetaColumn } from "@primebrick/core";

import { DomainService } from "../entity/domain-service.js";
import { SequenceEntity } from "../entities/sequence-entity.js";
import { withColumnConstraints } from "../meta/column-constraints.js";
import { getSchemaDomain } from "../meta/schema-domain.js";
import { ValidationError } from "../errors/errors.js";

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

const SEQUENCE_DEFAULT_SORT = { key: "code", dir: "asc" as const };
const STICKY_KEYS = new Set<string>(["code"]);

function sequenceColumns(ns: string): MetaColumn[] {
  const F = (c: string) => `${ns}.entities.sequence.fields.${c}`;
  const raw: Array<Omit<MetaColumn, "sticky" | "audited">> = [
    { key: "code", label_key: F("code"), type: "text", order: 0, hideable: false, immutable: true },
    { key: "pattern", label_key: F("pattern"), type: "text", order: 1 },
    { key: "step", label_key: F("step"), type: "number", order: 2 },
    { key: "start", label_key: F("start"), type: "number", order: 3 },
    { key: "tz", label_key: F("tz"), type: "text", order: 4 },
    { key: "label_key", label_key: F("label_key"), type: "text", order: 5 },
    { key: "description_key", label_key: F("description_key"), type: "text", order: 6 },
  ];
  return raw.map((c) => ({ ...c, sticky: STICKY_KEYS.has(c.key), audited: true }));
}

function sequenceMeta(ns: string): EntityMeta {
  return withColumnConstraints(
    {
      entity: "sequence",
      translation_key: "sequence",
      entities_ns: ns,
      uid: "uuid",
      display_field: "code",
      columns: sequenceColumns(ns),
      table: {
        default_view: "table",
        default_sort: SEQUENCE_DEFAULT_SORT,
        default_page_size: 25,
        page_size_options: [10, 25, 50],
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

const SEQUENCE_WRITE_KEYS = new Set(["code", "pattern", "step", "start", "tz", "label_key", "description_key", "version"]);

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
  if (need("code")) out.code = vString(rec.code, "code", 100);
  if (need("pattern")) out.pattern = vPattern(rec.pattern);
  if (need("step")) {
    const s = vBigint(rec.step, "step");
    if (s === 0n) bad("step", "must be non-zero");
    out.step = s;
  }
  if (need("start")) out.start = vBigint(rec.start, "start");
  if (opt("tz")) out.tz = vIanaTz(rec.tz);
  if (opt("label_key")) out.label_key = vOptKey(rec.label_key, "label_key", 100);
  if (opt("description_key")) out.description_key = vOptKey(rec.description_key, "description_key", 200);
  if (partial) {
    if (typeof rec.version !== "number" || !Number.isInteger(rec.version) || rec.version < 0) {
      bad("version", "required non-negative integer");
    }
    out.version = rec.version;
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
