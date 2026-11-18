/**
 * entity-events — the canonical domain-event contract for entity writes.
 *
 * Every governed `svc` write emits ONE `EntityEvent` per affected row on
 * `events.<service_code>.<entity>.<uuid>` — the action lives in the
 * payload, never in the subject (consumers discriminate via
 * `job_trigger.filter` dot-paths). Emission is by-construction: the Dal
 * gateway injects the port into every `dal.entityService(cfg)` and the
 * entity-level `events` meta flag is the only switch.
 *
 * Payload density by path:
 *  - single-row writes (`create`/`update`/`delete`/`restore`/`purge`/
 *    `duplicate`) carry `before` (the optimistic-lock oldRecord, null on
 *    create), `after` (RETURNING) and `delta` — all three already
 *    computed by the repo write, zero extra queries.
 *  - TEMP-TABLE bulk ops (`addMany`/`updateMany`/`deleteMany`/
 *    `restoreMany`/`hardDeleteMany`) emit THIN events — `before`/`after`/
 *    `delta` are null by contract (no RETURNING on bulk paths); every
 *    item's `uuid` still gets its own event, correlated by `batch`, so
 *    per-uuid trigger bindings work inside a bulk. Consumers that need
 *    state re-read via `svc.get`.
 */

/** Write actions the event vocabulary maps (from the svc method, not the
 *  audit enum — `bulkUpdate` items are `update`, `svc.duplicate` is
 *  `duplicate` even though its audit row says INSERT). */
export type EntityWriteAction =
  | "create"
  | "update"
  | "delete"
  | "restore"
  | "purge"
  | "duplicate";

export interface EntityEvent {
  /** Contract version — always 1. */
  schema: 1;
  /** Publishing service code ("ai", "job", "be"). */
  service: string;
  /** API entity name (singular — the `/entities/:entity` segment). */
  entity: string;
  /** Physical table name. */
  table: string;
  /** Write action — see EntityWriteAction. */
  action: EntityWriteAction;
  /** Affected row uuid. */
  uuid: string;
  /** Caller-observed version after the write — auditable entities only. */
  version?: number;
  /** Resolved write actor (uuid or "system:<code>"). */
  actor: string;
  /** Epoch ms of the write. */
  changed_at: number;
  /** Pre-write row — optimistic-lock oldRecord; null on create/bulk. */
  before: Record<string, unknown> | null;
  /** Post-write row — the RETURNING projection; null on bulk. */
  after: Record<string, unknown> | null;
  /** `{field:{old,new}}` change map — the audit delta; null on bulk. */
  delta: Record<string, { old: unknown; new: unknown }> | null;
  /** Shared id correlating the per-item events of one bulk op. */
  batch?: string;
}

/** What the repo write path hands the port — the full event MINUS
 *  `service` (the repo doesn't know the service code; the transport port
 *  stamps it when building subject + payload). */
export type EntityEventDraft = Omit<EntityEvent, "service">;

/** Sink the repo write path calls — fire-and-forget by contract:
 *  callers do `void port.emit(e).catch(log)`; a failing emit NEVER fails
 *  the write. Implementations: SDK `makeNatsEntityEventPort` (JetStream),
 *  a buffering sink inside `dal.transaction` (drains post-COMMIT). */
export interface EntityEventPort {
  emit(event: EntityEventDraft): Promise<void>;
}

/** Opt-out contract on `@Entity` options — `false` silences the entity
 *  entirely; `{except:[...]}` silences only those actions. Absent =
 *  emitting (the default by design). */
export type EntityEventsConfig = false | { except?: readonly EntityWriteAction[] };

/** The entity-meta flag resolved from `@Entity` options — raw form on
 *  `EntityPersistenceMeta.events` (`EntityEventsConfig`). */

/** JSON Schema for `endpoints.events` payload_schema + wire docs. */
export const ENTITY_EVENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: [
    "schema",
    "service",
    "entity",
    "table",
    "action",
    "uuid",
    "actor",
    "changed_at",
    "before",
    "after",
    "delta",
  ],
  properties: {
    schema: { const: 1 },
    service: { type: "string" },
    entity: { type: "string" },
    table: { type: "string" },
    action: { enum: ["create", "update", "delete", "restore", "purge", "duplicate"] },
    uuid: { type: "string" },
    version: { type: "integer" },
    actor: { type: "string" },
    changed_at: { type: "integer" },
    before: { type: ["object", "null"] },
    after: { type: ["object", "null"] },
    delta: { type: ["object", "null"] },
    batch: { type: "string" },
  },
};

/** Resolve the meta flag into a runtime verdict: absent = emitting (the
 *  default by design); `false` silences; `{except}` silences actions. */
export function entityEventsEnabled(
  cfg: EntityEventsConfig | undefined,
  action: EntityWriteAction,
): boolean {
  if (cfg === false) return false;
  if (!cfg) return true;
  return !(cfg.except ?? []).includes(action);
}
