import "reflect-metadata";

import { Entity, Column, Key, Unique } from "../../src/index.js";

/**
 * Composite-unique test entity — @Unique group (grp_a, grp_b) to verify that
 * conflict `keys` report the COMPLETE attempted combination (including
 * columns not touched by the payload, read from the target row).
 * Non-auditable: no version guard required on writes.
 */
@Entity("dal_test_composite")
export class CompositeUniqueEntity {
  @Key()
  id!: bigint;

  @Unique()
  uuid!: string;

  @Column({ pgType: "text", nullable: true })
  name?: string;

  @Unique("dal_test_composite_ab_uidx", 0)
  @Column({ pgType: "text", nullable: true })
  grp_a?: string;

  @Unique("dal_test_composite_ab_uidx", 1)
  @Column({ pgType: "text", nullable: true })
  grp_b?: string;
}
