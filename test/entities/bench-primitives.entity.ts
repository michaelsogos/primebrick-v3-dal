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
 * Benchmark entity — 20+ column table covering all PostgreSQL primitive types.
 * Used for measuring bulk operation throughput on a wide row with diverse types.
 */
@Entity("test_bench_primitives")
@AuditTrail()
export class BenchPrimitivesEntity {
  @Key()
  id!: number;

  @Unique()
  uuid!: string;

  // ── Integer types ───────────────────────────────────────────────
  @Column({ pgType: "int2" })
  int2_val?: number;

  @Column({ pgType: "int4" })
  int4_val?: number;

  @Column({ pgType: "int8" })
  int8_val?: bigint;

  // ── Floating point types ────────────────────────────────────────
  @Column({ pgType: "float4" })
  float4_val?: number;

  @Column({ pgType: "float8" })
  float8_val?: number;

  // ── Numeric ─────────────────────────────────────────────────────
  @Column({ pgType: "numeric", precision: 15, scale: 2 })
  numeric_safe?: number;

  // ── Boolean ─────────────────────────────────────────────────────
  @Column({ pgType: "boolean" })
  boolean_val?: boolean;

  // ── String types ────────────────────────────────────────────────
  @Column({ pgType: "char", length: 1 })
  char_val?: string;

  @Column({ pgType: "varchar", length: 200 })
  varchar_val?: string;

  @Column({ pgType: "text" })
  text_val?: string;

  // ── UUID ────────────────────────────────────────────────────────
  @Column({ pgType: "uuid" })
  uuid_val?: string;

  // ── Date/time types ─────────────────────────────────────────────
  @Column({ pgType: "date" })
  date_val?: Date;

  @Column({ pgType: "timestamp" })
  timestamp_val?: Date;

  @Column({ pgType: "timestamptz" })
  timestamptz_val?: Date;

  // ── JSON ────────────────────────────────────────────────────────
  @Column({ pgType: "jsonb" })
  jsonb_val?: Record<string, unknown>;

  // ── Array types ─────────────────────────────────────────────────
  @Column({ pgType: "text[]" })
  text_arr?: string[];

  @Column({ pgType: "int4[]" })
  int4_arr?: number[];

  // ── Network types ───────────────────────────────────────────────
  @Column({ pgType: "inet" })
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
