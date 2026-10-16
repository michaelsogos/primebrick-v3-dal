import "reflect-metadata";
import { describe, it, expect } from "vitest";
import {
  Entity,
  Key,
  Unique,
  Column,
  AuditableField,
  AuditableFieldType,
  DeletableField,
  DeletableFieldType,
  CloneField,
  getEntityPersistenceMeta,
} from "../src/index.js";

/**
 * Deterministic nullability semantics — `design:type` inference was removed
 * because it is transpiler-dependent (esbuild/tsx never emit decorator
 * metadata; bun collapses union types to the concrete member). The only
 * sources of truth for `nullable` are: explicit @Column({ nullable }), and
 * decorators that imply it (@DeletableField/@CloneField → true,
 * @Key/@Unique/@PartitionField → false). Everything else defaults to NOT NULL.
 */
describe("entity nullable semantics — no design:type inference", () => {
  @Entity("nullable_semantics_test")
  class SemanticsEntity {
    @Key()
    id!: bigint;

    @Unique()
    uuid!: string;

    /** Optional with NO decorator options → defaults to NOT NULL. */
    bare_optional?: string;

    /** Optional with @Column but no nullable → still NOT NULL. */
    @Column({ length: 50 })
    decorated_optional?: string;

    /** Optional with explicit nullable:true → nullable. */
    @Column({ nullable: true })
    explicit_nullable?: string;

    /** Optional with explicit nullable:false → NOT NULL (legal: TS-optional + DB default). */
    @Column({ nullable: false })
    explicit_not_null?: string;

    /** Non-optional, no decorators → NOT NULL. */
    required_field!: string;

    /** `| null` union without explicit option → NOT NULL (declaration must use nullable). */
    union_field!: string | null;

    @AuditableField(AuditableFieldType.CREATED_AT)
    created_at!: Date;

    @DeletableField(DeletableFieldType.DELETED_AT)
    deleted_at?: Date;

    @CloneField()
    cloned_from?: string;
  }

  const cols = getEntityPersistenceMeta(SemanticsEntity).columns;

  it("non-optional property defaults to NOT NULL", () => {
    expect(cols["required_field"].nullable).toBe(false);
  });

  it("optional property without explicit nullable defaults to NOT NULL", () => {
    expect(cols["bare_optional"].nullable).toBe(false);
  });

  it("optional property with @Column but no nullable defaults to NOT NULL", () => {
    expect(cols["decorated_optional"].nullable).toBe(false);
  });

  it("explicit nullable:true wins on optional property", () => {
    expect(cols["explicit_nullable"].nullable).toBe(true);
  });

  it("explicit nullable:false wins on optional property", () => {
    expect(cols["explicit_not_null"].nullable).toBe(false);
  });

  it("`| null` union without explicit nullable defaults to NOT NULL", () => {
    expect(cols["union_field"].nullable).toBe(false);
  });

  it("@Key is NOT NULL", () => {
    expect(cols["id"].nullable).toBe(false);
  });

  it("@Unique is NOT NULL", () => {
    expect(cols["uuid"].nullable).toBe(false);
  });

  it("@AuditableField without nullable option is NOT NULL", () => {
    expect(cols["created_at"].nullable).toBe(false);
  });

  it("@DeletableField implies nullable", () => {
    expect(cols["deleted_at"].nullable).toBe(true);
  });

  it("@CloneField implies nullable", () => {
    expect(cols["cloned_from"].nullable).toBe(true);
  });
});
