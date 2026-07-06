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
 * Type-rich test entity — covers all PostgreSQL ↔ TypeScript type mappings.
 * Used for the type test matrix (77 cases) and type coercion verification.
 *
 * Columns cover:
 * - bigint (native TS bigint via INT8_OID type parser)
 * - numeric/decimal (metadata-driven number or string)
 * - date/timestamp (JS Date objects)
 * - boolean
 * - varchar with length
 * - text
 * - uuid
 * - integer
 * - jsonb
 */
@Entity("dal_test_types")
@AuditTrail()
export class TypeTestEntity {
  @Key()
  id!: number;

  @Unique()
  uuid!: string;

  // ── Primitive types ──────────────────────────────────────────────
  @Column({ pgType: "integer" })
  int_col!: number;

  @Column({ pgType: "bigint" })
  bigint_col!: bigint;

  @Column({ pgType: "boolean" })
  bool_col!: boolean;

  @Column({ pgType: "varchar", length: 100 })
  varchar_col!: string;

  @Column({ pgType: "text", nullable: true })
  text_col?: string;

  // ── Numeric types ────────────────────────────────────────────────
  @Column({ pgType: "numeric", precision: 15, scale: 2 })
  numeric_col!: number;

  @Column({ pgType: "numeric", precision: 38, scale: 0 })
  big_numeric_col!: string;

  @Column({ pgType: "decimal", precision: 10, scale: 4 })
  decimal_col!: number;

  // ── Date/time types ──────────────────────────────────────────────
  @Column({ pgType: "timestamptz" })
  timestamp_col!: Date;

  @Column({ pgType: "date" })
  date_col!: Date;

  // ── JSON ─────────────────────────────────────────────────────────
  @Column({ pgType: "jsonb", nullable: true })
  jsonb_col?: Record<string, unknown>;

  // ── Audit fields ─────────────────────────────────────────────────
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
