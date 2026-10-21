import "reflect-metadata";

import {
  AuditableField,
  AuditableFieldType,
  Column,
  DeletableField,
  DeletableFieldType,
  Entity,
  IsNotColumn,
  Key,
  SynchronizableField,
  SynchronizableFieldType,
  Unique,
  Vector,
  type ISODate,
  type ISOTime,
  type UUID,
} from "../../src/index.js";
import type { Decimal } from "@primebrick/core/decimal";

/**
 * Canonical type-matrix entity — one property per annotation → PostgreSQL
 * mapping row. The schema pipeline (`extractEntityAnnotations` +
 * `buildEntitySnapshot`) must resolve every column deterministically;
 * `test/type-matrix.test.ts` pins each cell of the matrix.
 *
 * Authoring contract demonstrated here:
 * - annotation drives the base type — NEVER write the inferred `pgType`
 *   (`UUID`→uuid, `bigint`→int8, `number`→float8, `Date`→timestamptz,
 *   `ISODate`→date, `Decimal`→numeric, `Vector`→vector, `string`→text,
 *   `boolean`→boolean, `Uint8Array`→bytea, `T[]`→`base[]`, object→jsonb)
 * - explicit `pgType` only for a whitelisted NARROWER/other storage
 *   (`int4`/`int2`/`float4` on `number`, `inet` on `string`, `json` on
 *   objects, `timestamp` on `Date`, `timetz` on `ISOTime`)
 * - modifiers via options, never inside the pgType string:
 *   `length`→varchar(n)/char(n)/vector(n), `precision`/`scale`→numeric(p,s)
 * - `jsType` on `Decimal`/`Vector` props — runtime hydration marker
 * - `nullable` always explicit on optional props
 */
@Entity("type_matrix", "matrix")
export class TypeMatrixEntity {
  @Key()
  id!: bigint;

  @Unique()
  uuid!: UUID;

  // ── strings ──────────────────────────────────────────────────────
  @Column({ nullable: false })
  txt!: string;

  @Column({ nullable: false, length: 64 })
  vc!: string;

  @Column({ nullable: false, pgType: "char", length: 2 })
  cc!: string;

  @Column({ nullable: false, pgType: "inet" })
  ip!: string;

  @Column({ nullable: false, pgType: "citext" })
  ci!: string;

  // ── numbers ──────────────────────────────────────────────────────
  @Column({ nullable: false })
  num!: number;

  @Column({ nullable: false, pgType: "int4" })
  n4!: number;

  @Column({ nullable: false, pgType: "int2" })
  n2!: number;

  @Column({ nullable: false, pgType: "float4" })
  f4!: number;

  @Column({ nullable: false })
  big!: bigint;

  @Column({ nullable: false })
  flag!: boolean;

  // ── date & time ──────────────────────────────────────────────────
  @Column({ nullable: false })
  ts!: Date;

  @Column({ nullable: false, pgType: "timestamp" })
  ts_ntz!: Date;

  @Column({ nullable: false })
  day!: ISODate;

  @Column({ nullable: false })
  tod!: ISOTime;

  @Column({ nullable: false, pgType: "timetz" })
  tod_tz!: ISOTime;

  // ── guarded / runtime-identifiable types ─────────────────────────
  @Column({ nullable: false, jsType: "decimal" })
  money!: Decimal;

  @Column({ nullable: false, jsType: "decimal", precision: 12, scale: 4 })
  price!: Decimal;

  @Column({ nullable: false, jsType: "vector" })
  emb!: Vector;

  @Column({ nullable: false, jsType: "vector", length: 3 })
  emb3!: Vector;

  // ── objects / binary ─────────────────────────────────────────────
  @Column({ nullable: false })
  meta!: Record<string, unknown>;

  @Column({ nullable: false, pgType: "json" })
  doc!: Record<string, unknown>;

  @Column({ nullable: false })
  blob!: Uint8Array;

  // ── arrays ───────────────────────────────────────────────────────
  @Column({ nullable: false })
  tags!: string[];

  @Column({ nullable: false })
  scores!: number[];

  @Column({ nullable: false })
  ids!: bigint[];

  @Column({ nullable: false })
  refs!: UUID[];

  @Column({ nullable: false })
  flags!: boolean[];

  @Column({ nullable: false })
  hist!: Decimal[];

  // ── literal unions ───────────────────────────────────────────────
  @Column({ nullable: false })
  status!: "ok" | "degraded" | "down";

  @Column({ nullable: false })
  factor!: "totp";

  // ── semantic pins (decorator wins over annotation) ───────────────
  @AuditableField(AuditableFieldType.CREATED_AT)
  created_at!: Date;

  @AuditableField(AuditableFieldType.VERSION)
  version!: number;

  @DeletableField(DeletableFieldType.DELETED_AT)
  deleted_at?: Date;

  @SynchronizableField(SynchronizableFieldType.LAST_SYNCED_AT)
  last_synced_at!: Date;

  // ── nullable columns ─────────────────────────────────────────────
  @Column({ nullable: true })
  opt_txt?: string;

  @Column({ nullable: true })
  opt_num?: number | null;

  /** `@IsNotColumn` — never a column, extractor skips it too. */
  @IsNotColumn()
  helper!: string;
}
