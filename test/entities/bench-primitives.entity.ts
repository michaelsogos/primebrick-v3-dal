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
  type UUID,
} from "../../src/index.js";

/**
 * Benchmark entity — 20+ column table covering all PostgreSQL primitive types.
 * Used for measuring bulk operation throughput on a wide row with diverse types.
 */
@Entity("test_bench_primitives")
@AuditTrail()
export class BenchPrimitivesEntity {
  @Key()
  id!: number;

  @Unique()
  uuid!: UUID;

  // ── Integer types ───────────────────────────────────────────────
  @Column({ pgType: "int2", nullable: true })
  int2_val?: number;

  @Column({ pgType: "int4", nullable: true })
  int4_val?: number;

  @Column({ pgType: "int8", nullable: true })
  int8_val?: bigint;

  // ── Floating point types ────────────────────────────────────────
  @Column({ pgType: "float4", nullable: true })
  float4_val?: number;

  @Column({ pgType: "float8", nullable: true })
  float8_val?: number;

  // ── Numeric ─────────────────────────────────────────────────────
  @Column({ pgType: "numeric", precision: 15, scale: 2, nullable: true })
  numeric_safe?: number;

  // ── Boolean ─────────────────────────────────────────────────────
  @Column({ pgType: "boolean", nullable: true })
  boolean_val?: boolean;

  // ── String types ────────────────────────────────────────────────
  @Column({ pgType: "char", length: 1, nullable: true })
  char_val?: string;

  @Column({ pgType: "varchar", length: 200, nullable: true })
  varchar_val?: string;

  @Column({ pgType: "text", nullable: true })
  text_val?: string;

  // ── UUID ────────────────────────────────────────────────────────
  @Column({ pgType: "uuid", nullable: true })
  uuid_val?: string;

  // ── Date/time types ─────────────────────────────────────────────
  @Column({ pgType: "date", nullable: true })
  date_val?: Date;

  @Column({ pgType: "timestamp", nullable: true })
  timestamp_val?: Date;

  @Column({ pgType: "timestamptz", nullable: true })
  timestamptz_val?: Date;

  // ── JSON ────────────────────────────────────────────────────────
  @Column({ pgType: "jsonb", nullable: true })
  jsonb_val?: Record<string, unknown>;

  // ── Array types ─────────────────────────────────────────────────
  @Column({ pgType: "text[]", nullable: true })
  text_arr?: string[];

  @Column({ pgType: "int4[]", nullable: true })
  int4_arr?: number[];

  // ── Network types ───────────────────────────────────────────────
  @Column({ pgType: "inet", nullable: true })
  inet_val?: string;

  // ── Audit fields ────────────────────────────────────────────────
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
