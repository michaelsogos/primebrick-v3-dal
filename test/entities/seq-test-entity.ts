import "reflect-metadata";

import {
  Entity,
  Column,
  Key,
  Unique,
  AuditableField,
  DeletableField,
  CloneField,
  SequenceField,
  AuditableFieldType,
  DeletableFieldType,
  type UUID,
} from "../../src/index.js";

/**
 * Sequence-bound test entity — `code` carries @SequenceField so every
 * Repository write resolves directives/omissions through the allocator.
 * Used by the seq write-path resolver tests.
 */
@Entity("dal_test_seq")
export class SeqTestEntity {
  @Key()
  id!: bigint;

  @Unique()
  uuid!: UUID;

  @Unique()
  @Column({ pgType: "varchar", length: 30, nullable: false })
  @SequenceField({ pattern: "TST-{seq:5}", step: 1n, start: 1n })
  code!: string;

  @Column({ pgType: "varchar", length: 255, nullable: true })
  label?: string;

  @AuditableField(AuditableFieldType.CREATED_AT)
  created_at!: Date;

  @AuditableField(AuditableFieldType.CREATED_BY)
  created_by!: string;

  @AuditableField(AuditableFieldType.UPDATED_AT)
  updated_at!: Date;

  @AuditableField(AuditableFieldType.UPDATED_BY)
  updated_by!: string;

  @AuditableField(AuditableFieldType.VERSION)
  version!: bigint;

  @DeletableField(DeletableFieldType.DELETED_AT)
  deleted_at?: Date;

  @DeletableField(DeletableFieldType.DELETED_BY)
  deleted_by?: string;

  @CloneField()
  cloned_from?: string;
}
