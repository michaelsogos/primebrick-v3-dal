import "reflect-metadata";

import {
  Column,
  Entity,
  Key,
  Unique,
} from "../meta/entity-decorators.js";
import { Auditable, EntityBase } from "./entity-base.js";
import { ValidationError } from "../errors/errors.js";

/**
 * SequenceCounterEntity — the machine state of a persisted sequence
 * (`sequence_counters` table). NOT a domain entity: never routed, never
 * listed — rows exist only to be claimed atomically inside a consumer's
 * transaction (`Repository.sequenceAllocate`).
 *
 * Identity = (sequence_uuid, period_key, partition_key):
 *   - `period_key` derives from the pattern's finest date token at the
 *     allocation business date (`''` for period-free patterns). Rows are
 *     append-only: an old period's row IS the immutable record of where
 *     that period ended — nothing is ever closed or deleted, the next
 *     period simply keys differently.
 *   - `partition_key` is the fixed 3-slot sezionale tuple
 *     (`sez\x1fsez2\x1fsez3` — `core/sequence.ts sequencePartitionKey`).
 *   - `counter` is NEXT-TO-EMIT (not last-emitted): the row answers
 *     "where did it get to" at a glance; the claim bumps it by count*step
 *     and RETURNS the emitted range in one atomic statement.
 *
 * `last_alloc_*` = attribution without a trail — who/when/how many took
 * the last claim, overwritten each time.
 *
 * SEALED: same `new.target` construction guard as SequenceEntity.
 */
@Entity("sequence_counters", { events: false })
export class SequenceCounterEntity extends Auditable(EntityBase) {
  constructor() {
    if (new.target !== SequenceCounterEntity) {
      throw new ValidationError(
        "SequenceCounterEntity is sealed — the counter table is per-module machine state, not a subclassable shape",
      );
    }
    super();
  }

  @Key()
  @Column({ pgType: "uuid" })
  uuid!: string;

  /** → `sequences.uuid` of the owning definition (same module schema). */
  @Unique("sequence_counters_identity", 0)
  @Column({ pgType: "uuid", nullable: false })
  sequence_uuid!: string;

  /** Period identity from `derivePeriodKey` — `''` for period-free patterns. */
  @Unique("sequence_counters_identity", 1)
  @Column({ pgType: "varchar", length: 64, nullable: false, defaultSql: "''" })
  period_key!: string;

  /** Sezionale tuple `sez\x1fsez2\x1fsez3` — `''`…`''` when partition-free. */
  @Unique("sequence_counters_identity", 2)
  @Column({ pgType: "varchar", length: 255, nullable: false, defaultSql: "''" })
  partition_key!: string;

  /** NEXT-TO-EMIT counter — claimed ranges bump it atomically. */
  @Column({ nullable: false, jsType: "bigint" })
  counter!: bigint;

  /** Instant of the last claim (attribution, overwritten). */
  @Column({ nullable: true, jsType: "instant" })
  last_alloc_at?: Date | null;

  /** Actor of the last claim (attribution, overwritten). */
  @Column({ pgType: "varchar", length: 100, nullable: true })
  last_alloc_by?: string | null;

  /** Codes taken by the last claim (attribution, overwritten). */
  @Column({ nullable: true, jsType: "bigint" })
  last_alloc_count?: bigint | null;
}
