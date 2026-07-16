import "reflect-metadata";

import {
  Entity,
  Column,
  Key,
  Unique,
  AuditableField,
  DeletableField,
  AuditTrail,
  AuditableFieldType,
  DeletableFieldType,
} from "../../src/index.js";

/**
 * Test user entity — used for buildAuditTrailJoins tests.
 * Has uuid, display_name, idp_code columns for join resolution.
 */
@Entity("dal_test_users")
@AuditTrail()
export class TestUserEntity {
  @Key()
  id!: bigint;

  @Unique()
  uuid!: string;

  @Column({ pgType: "text" })
  display_name!: string;

  @Column({ pgType: "text" })
  idp_code!: string;

  @AuditableField(AuditableFieldType.CREATED_AT)
  created_at!: Date;

  @AuditableField(AuditableFieldType.CREATED_BY)
  created_by!: string;

  @AuditableField(AuditableFieldType.UPDATED_AT)
  updated_at!: Date;

  @AuditableField(AuditableFieldType.UPDATED_BY)
  updated_by!: string;

  @AuditableField(AuditableFieldType.VERSION)
  version!: number;

  @DeletableField(DeletableFieldType.DELETED_AT)
  deleted_at?: Date;

  @DeletableField(DeletableFieldType.DELETED_BY)
  deleted_by?: string;
}
