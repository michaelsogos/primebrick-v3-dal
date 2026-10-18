import "reflect-metadata";

import {
  Entity,
  Column,
  Key,
  Unique,
  EntityBase,
  Auditable,
  Deletable,
  type UUID,
} from "../../src/index.js";

/** Fixture: audit+deletable entity via capability mixins (new style). */
@Entity("dal_test_mixin")
export class MixinEntity extends Deletable(Auditable(EntityBase)) {
  @Key()
  @Column({ pgType: "bigint" })
  id!: bigint;

  @Unique()
  @Column({ pgType: "uuid" })
  uuid!: UUID;

  @Column({ nullable: false })
  name!: string;
}
