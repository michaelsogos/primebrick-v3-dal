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
 * Simple test entity — minimal columns, auditable, soft-deletable.
 * Used for basic CRUD, finder, and bulk operation tests.
 */
@Entity("dal_test_simple")
@AuditTrail()
export class SimpleTestEntity {
  @Key()
  id!: number;

  @Unique()
  uuid!: string;

  @Column({ pgType: "varchar", length: 255 })
  name!: string;

  @Column({ pgType: "text", nullable: true })
  description?: string;

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
