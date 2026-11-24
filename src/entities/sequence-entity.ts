import "reflect-metadata";

import {
  AuditTrail,
  Column,
  Entity,
  Index,
  Key,
} from "../meta/entity-decorators.js";
import { Auditable, Deletable, EntityBase } from "./entity-base.js";
import { ValidationError } from "../errors/errors.js";

/**
 * SequenceEntity — the governed DEFINITION row of a persisted sequence
 * (`sequences` table). Shared CONCRETE class: every module that owns
 * sequences declares the same class — the schema resolves to the
 * service's `domain.primary` (never declared here, so one class serves
 * every owner schema).
 *
 * SEALED by construction: subclassing would fork the counter namespace
 * and break the one-registry-per-module ownership contract — `new.target`
 * throws on any descendant instantiation (hydration bypasses ctors, but
 * a subclass is useless the moment anything instantiates it).
 *
 *   uuid    — the ONLY identity: directives, counter FKs, RPC params and
 *             the deterministic bound-row provisioning key all chain uuid
 *   name    — the operator-facing display name, plain text, NOT unique
 *             (bound rows carry `<table>.<field>` as their name value;
 *             ambiguity between operator rows is the operator's business)
 *   pattern — the authored template verbatim (`core/sequence.ts` grammar);
 *             validation happens at the service boundary via
 *             `parseSequencePattern`, the column is the verbatim store
 *   step    — signed increment (≠0; negative = countdown)
 *   start   — first next-to-emit counter for a fresh period/partition
 *   tz      — IANA zone for date tokens + period boundary —
 *             `NOT NULL DEFAULT 'UTC'` (physical + served default)
 */
@Entity("sequences")
@AuditTrail()
@Index({
  name: "sequences_binding_key_default_from_idx",
  // "current default row per binding": WHERE binding_key=? ORDER BY
  // default_from DESC NULLS LAST — NULLS LAST is semantically required
  // (PG renders DESC NULLS FIRST by default; a backward asc scan cannot
  // serve nulls-last ordering).
  columns: ["binding_key", { name: "default_from", sort: "desc", nulls: "last" }],
  where: "deleted_at IS NULL",
})
export class SequenceEntity extends Deletable(Auditable(EntityBase)) {
  constructor() {
    if (new.target !== SequenceEntity) {
      throw new ValidationError(
        "SequenceEntity is sealed — one registry per module, subclassed tables are forbidden",
      );
    }
    super();
  }

  @Key()
  @Column({ pgType: "uuid" })
  uuid!: string;

  /** Operator-facing name — display data, never an identity (uuid is the
   *  only chain). Bound rows carry `<table>.<field>` as their name value. */
  @Column({ pgType: "varchar", length: 100, nullable: false })
  name!: string;

  /** Authored pattern verbatim — `{seq:W}`, date tokens, `{sez}`/`{sez2}`/`{sez3}`. */
  @Column({ pgType: "text", nullable: false })
  pattern!: string;

  /** Signed increment per emitted code — non-zero by service validation.
   *  `DEFAULT 1` is the physical + served default: the create surface
   *  prefills it and an omitted value resolves in the DB. */
  @Column({ nullable: false, jsType: "bigint", defaultSql: "1" })
  step!: bigint;

  /** First next-to-emit value for a fresh (period, partition) counter —
   *  `DEFAULT 1`, same contract as `step`. */
  @Column({ nullable: false, jsType: "bigint", defaultSql: "1" })
  start!: bigint;

  /** IANA zone for date tokens + period_key boundary — `DEFAULT 'UTC'`,
   *  same physical+served contract as `step`/`start` (constant literal →
   *  the create surface prefills it, an omitted value resolves in DB). */
  @Column({ pgType: "varchar", length: 100, nullable: false, defaultSql: "'UTC'" })
  tz!: string;

  /** i18n key for the explanatory description — doubles as the option
   *  tooltip on sequence pickers. */
  @Column({ pgType: "varchar", length: 200, nullable: true })
  description_key?: string | null;

  /** Row-owned sezionale defaults — the pattern's `{sez}`/`{sez2}`/`{sez3}`
   *  slots take the row value when the directive doesn't supply them;
   *  owned slots are immutable at claim time (revive axis). */
  @Column({ pgType: "varchar", length: 200, nullable: true })
  sez?: string | null;
  @Column({ pgType: "varchar", length: 200, nullable: true })
  sez2?: string | null;
  @Column({ pgType: "varchar", length: 200, nullable: true })
  sez3?: string | null;

  /** Series identity for declared bindings — `<table>.<field>` (or
   *  `…@expr_<hash>`); written ONLY by the system at binding
   *  materialize, never a write key. Operator rows keep NULL. */
  @Column({ pgType: "varchar", length: 130, nullable: true })
  binding_key?: string | null;

  /** Revive cadence `'N (day|week|month|quarter|year)[s]'` — the row is
   *  cloned on a chained calendar; NULL = never revives. Stored as
   *  varchar to keep the closed wire format verbatim (PG `interval`
   *  output normalizes '3 months'→'3 mons'/'1 week'→'7 days', breaking
   *  round-trip). IMMUTABLE post-create — the period contract is the
   *  row's identity. */
  @Column({ pgType: "varchar", length: 30, nullable: true })
  revive_every?: string | null;

  /** Overlap window `'N unit'` — how long the retired row survives
   *  `expire_at` so backdated `at` still resolves it. Editable — moves
   *  only `switch_at`. */
  @Column({ pgType: "varchar", length: 30, nullable: true })
  revive_grace?: string | null;

  /** Which sez slot the period label advances at revive — must be a
   *  slot the pattern uses whose value parses under `derivePeriodLabel`.
   *  IMMUTABLE post-create. */
  @Column({ pgType: "varchar", length: 10, nullable: true })
  revive_slot?: string | null;

  /** Period boundary on the `at` axis — computed at create (calendar-
   *  anchored), immutable; the successor's `default_from`. */
  @Column({ pgType: "timestamptz", nullable: true })
  expire_at?: Date | null;

  /** Physical retirement instant — `expire_at + revive_grace`; phase-B
   *  soft-deletes the row here. Recomputed on `revive_grace` edits. */
  @Column({ pgType: "timestamptz", nullable: true })
  switch_at?: Date | null;

  /** When the row starts serving as the binding default — `created_at`
   *  for first rows, predecessor's `expire_at` for successors. */
  @Column({ pgType: "timestamptz", nullable: true })
  default_from?: Date | null;

  /** Chain link to the retired predecessor — job idempotency, audit
   *  navigation. */
  @Column({ pgType: "uuid", nullable: true })
  revived_from?: string | null;

  /** When the revive actually ran — may lag `expire_at` (late jobs
   *  resume, never halt). */
  @Column({ pgType: "timestamptz", nullable: true })
  revived_at?: Date | null;

  /** Who fired the revive — `system`/job actor today; the column exists
   *  so a user-triggered revive later is data, not schema. */
  @Column({ pgType: "varchar", length: 100, nullable: true })
  revived_by?: string | null;
}
