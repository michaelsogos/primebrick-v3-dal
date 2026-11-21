import "reflect-metadata";

import {
  AuditTrail,
  Column,
  Entity,
  Key,
  Unique,
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
 *   code    — the addressable identity on the wire (`{sequence:"customer_code"}`),
 *             unique per module, never a uuid in directives
 *   pattern — the authored template verbatim (`core/sequence.ts` grammar);
 *             validation happens at the service boundary via
 *             `parseSequencePattern`, the column is the verbatim store
 *   step    — signed increment (≠0; negative = countdown)
 *   start   — first next-to-emit counter for a fresh period/partition
 *   tz      — IANA zone for date tokens + period boundary (UTC when null)
 */
@Entity("sequences")
@AuditTrail()
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

  /** Module-unique addressable code — directives reference this, never uuid. */
  @Unique()
  @Column({ pgType: "varchar", length: 100, nullable: false })
  code!: string;

  /** Authored pattern verbatim — `{seq:W}`, date tokens, `{sez}`/`{sez2}`/`{sez3}`. */
  @Column({ pgType: "text", nullable: false })
  pattern!: string;

  /** Signed increment per emitted code — non-zero by service validation. */
  @Column({ nullable: false, jsType: "bigint" })
  step!: bigint;

  /** First next-to-emit value for a fresh (period, partition) counter. */
  @Column({ nullable: false, jsType: "bigint" })
  start!: bigint;

  /** IANA zone for date tokens + period_key boundary — null → UTC. */
  @Column({ pgType: "varchar", length: 100, nullable: true })
  tz?: string | null;

  /** i18n key for the registry label. */
  @Column({ pgType: "varchar", length: 100, nullable: true })
  label_key?: string | null;

  /** i18n key for the explanatory description. */
  @Column({ pgType: "varchar", length: 200, nullable: true })
  description_key?: string | null;
}
