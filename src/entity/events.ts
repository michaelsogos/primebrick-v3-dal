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

/**
 * The event ENVELOPE — identical on every Primebrick domain event,
 * whatever the payload specialization (`entity`, `uuids`, domain
 * extras). `event.*` carries who/what/when/where; everything outside
 * `event` is the event's own domain content.
 */
export interface EntityEventEnvelope {
  /** Contract version — 2 (the `{event,entity}` shape; 1 was flat). */
  schema: 2;
  /** Publishing service code ("ai", "job", "be"). */
  service: string;
  /** The NATS subject the event was published on — self-describing
   *  payload, still truthful once detached from transport context. */
  subject: string;
  /** Epoch ms of the write that produced the event. */
  emitted_at: string;
  /** Resolved write actor — uuid or "system:<code>" token. */
  emitted_by: string;
  /** What happened — EntityWriteAction for lifecycle events, the
   *  semantic event name ("changed", "high_value") for `on.*` events. */
  action: string;
  /** API entity name (singular — the `/entities/:entity` segment). */
  entity: string;
  /** Affected row uuid. */
  uuid: string;
  /** Caller-observed version after the write — auditable entities only. */
  version?: number;
  /** Shared id correlating the per-item events of one bulk op. */
  batch?: string;
}

export interface EntityEvent {
  event: EntityEventEnvelope;
  /** Entity-state section — the single-row specialization. */
  entity: {
    /** Pre-write row — optimistic-lock oldRecord; null on create/bulk. */
    before: Record<string, unknown> | null;
    /** Post-write row — the RETURNING projection; null on bulk. */
    after: Record<string, unknown> | null;
    /** `{field:{old,new}}` change map — the audit delta; null on bulk. */
    delta: Record<string, { old: unknown; new: unknown }> | null;
  };
}

/** What the repo write path hands the port — the full event MINUS
 *  `service`/`subject` (the repo knows neither the service code nor
 *  the transport route; the port stamps both). */
export interface EntityEventDraft {
  event: Omit<EntityEventEnvelope, "service" | "subject">;
  entity: EntityEvent["entity"];
}

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

/** JSON Schema for `endpoints.events` payload_schema + wire docs —
 *  the `{event,entity}` contract (schema:2). `emitted_by` declares
 *  `format:"actor_token"` — actor tokens may be uuids OR `system:<code>`,
 *  so `uuid` would lie. */
export const ENTITY_EVENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["event"],
  properties: {
    event: {
      type: "object",
      required: ["schema", "service", "subject", "emitted_at", "emitted_by", "action", "entity", "uuid"],
      properties: {
        schema: { const: 2 },
        service: { type: "string", x_label_key: "app.entity_events.event.service" },
        subject: { type: "string", x_label_key: "app.entity_events.event.subject" },
        emitted_at: { type: "string", format: "date-time", x_label_key: "app.entity_events.event.emitted_at" },
        emitted_by: { type: "string", format: "actor_token", x_label_key: "app.entity_events.event.emitted_by" },
        action: {
          enum: ["create", "update", "delete", "restore", "purge", "duplicate"],
          x_label_key: "app.entity_events.event.action",
        },
        entity: { type: "string", x_label_key: "app.entity_events.event.entity" },
        uuid: { type: "string", format: "uuid", x_label_key: "app.entity_events.event.uuid" },
        version: { type: "integer", x_label_key: "app.entity_events.event.version" },
        batch: { type: "string", x_label_key: "app.entity_events.event.batch" },
      },
    },
    entity: {
      type: "object",
      x_label_key: "app.entity_events.entity",
      required: ["before", "after", "delta"],
      properties: {
        before: { type: ["object", "null"], x_label_key: "app.entity_events.entity.before" },
        after: { type: ["object", "null"], x_label_key: "app.entity_events.entity.after" },
        delta: { type: ["object", "null"], x_label_key: "app.entity_events.entity.delta" },
      },
    },
    uuids: {
      type: "array",
      items: { type: "string", format: "uuid" },
      x_label_key: "app.entity_events.uuids",
    },
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
