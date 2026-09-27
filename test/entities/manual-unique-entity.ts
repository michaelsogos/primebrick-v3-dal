import "reflect-metadata";

import { Entity, Column, Key, Unique } from "../../src/index.js";

/**
 * Manual-unique test entity — `email` is a PLAIN column (no @Unique) but the
 * table carries a hand-created UNIQUE INDEX on it. Any duplicate write hits a
 * raw PG 23505 that bypasses the DAL conflict CTEs entirely — the ERR08 path.
 */
@Entity("dal_test_manual")
export class ManualUniqueEntity {
  @Key()
  id!: bigint;

  @Unique()
  uuid!: string;

  @Column({ pgType: "text", nullable: true })
  name?: string;

  @Column({ pgType: "text", nullable: true })
  email?: string;
}
