import "reflect-metadata";

import {
  Entity,
  Column,
  Key,
  Unique,
  AuditableField,
  DeletableField,
  AuditableFieldType,
  DeletableFieldType,
  type UUID,
} from "../../src/index.js";

/**
 * Auditable-columns entity WITHOUT `@AuditTrail()` — used to prove that the
 * gateway audit auto-inject fires only when the trail table exists (meta
 * `hasAuditTrail`), never for Auditable-columns-only entities. Maps to the
 * same table as `TestUserEntity`; the companion `dal_test_users_audit`
 * table is created by the test that needs it.
 */
@Entity("dal_test_users")
export class TestUserNoTrailEntity {
  @Key()
  id!: bigint;

  @Unique()
  uuid!: UUID;

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
