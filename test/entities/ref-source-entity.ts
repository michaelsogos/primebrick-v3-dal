import "reflect-metadata";

import {
  Entity,
  Column,
  Key,
  Unique,
  Ref,
  type UUID,
} from "../../src/index.js";

/**
 * Ref-join test entity — `target_uuid` declares `@Ref("simple_test")`, the
 * api name `SimpleTestEntity` registers under. The join resolves the
 * target's materialized display template and projects `target_uuid_name`.
 * `ghost_uuid` points at a name that never registers — the contract for
 * unresolvable refs (cross-domain / headless) is SKIP, never boot-fail:
 * the column still lists its raw value.
 */
@Entity("dal_test_ref_source")
export class RefSourceEntity {
  @Key()
  id!: bigint;

  @Unique()
  uuid!: UUID;

  @Column({ pgType: "text", nullable: true })
  label?: string;

  @Ref("simple_test")
  @Column({ pgType: "uuid", nullable: true })
  target_uuid?: UUID;

  @Ref("unregistered_thing")
  @Column({ pgType: "uuid", nullable: true })
  ghost_uuid?: UUID;
}
