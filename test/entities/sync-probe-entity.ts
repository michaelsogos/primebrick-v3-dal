import "reflect-metadata";

import {
  Entity,
  Column,
  Key,
  Unique,
  SynchronizableField,
  SynchronizableFieldType,
  type UUID,
} from "../../src/index.js";

/**
 * Probe entity for the pin-only timestamp regression: `last_synced_at`
 * carries NO explicit `pgType` and NO `jsType` — its storage type exists
 * only through the `@SynchronizableField` semantic pin (the documented
 * runtime-cascade step 2, see column-types.mdx). This is the exact shape
 * of `user_profiles`/`organizations`/`role_mappings`.last_synced_at that
 * the DAL_NOW gate rejected (acceptsDalNow read explicit pgType only).
 */
@Entity("dal_test_sync_probe")
export class SyncProbeEntity {
  @Key()
  id!: bigint;

  @Unique()
  uuid!: UUID;

  @SynchronizableField(SynchronizableFieldType.LAST_SYNCED_AT)
  @Column({ nullable: true })
  last_synced_at?: Date;
}
