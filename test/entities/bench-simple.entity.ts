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
 * Benchmark entity — simple 5-column table.
 * Used for measuring bulk operation throughput on a narrow row.
 */
@Entity("test_bench_simple")
@AuditTrail()
export class BenchSimpleEntity {
  @Key()
  id!: number;

  @Unique()
  uuid!: string;

  @Column({ pgType: "varchar", length: 50 })
  code!: string;

  @Column({ pgType: "varchar", length: 200 })
  name!: string;

  @Column({ pgType: "varchar", length: 20 })
  status!: string;

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
