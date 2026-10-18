import { describe, it, expect } from "vitest";
import "reflect-metadata";

import {
  Entity,
  Column,
  Key,
  Unique,
  AuditableField,
  AuditableFieldType,
  DeletableField,
  DeletableFieldType,
  EntityBase,
  Auditable,
  Deletable,
  getEntityPersistenceMeta,
  type IAuditableEntity,
  type IDeletableEntity,
} from "../src/index.js";

/** Old-style entity: every shared column declared manually. */
@Entity("legacy_entity")
class LegacyAudited implements IAuditableEntity, IDeletableEntity {
  @Key() @Column({ pgType: "bigint" }) id!: bigint;
  @Unique() @Column({ pgType: "uuid" }) uuid!: string;
  @Column({ nullable: false }) name!: string;
  @AuditableField(AuditableFieldType.CREATED_AT) created_at!: Date;
  @AuditableField(AuditableFieldType.CREATED_BY) created_by!: string;
  @AuditableField(AuditableFieldType.UPDATED_AT) updated_at!: Date;
  @AuditableField(AuditableFieldType.UPDATED_BY) updated_by!: string;
  @AuditableField(AuditableFieldType.VERSION) version!: number;
  @DeletableField(DeletableFieldType.DELETED_AT) deleted_at?: Date;
  @DeletableField(DeletableFieldType.DELETED_BY) deleted_by?: string;
}

/** New-style entity: capability mixins compose the same column set. */
@Entity("mixin_entity")
class MixinAudited extends Deletable(Auditable(EntityBase)) {
  @Key() @Column({ pgType: "bigint" }) id!: bigint;
  @Unique() @Column({ pgType: "uuid" }) uuid!: string;
  @Column({ nullable: false }) name!: string;
}

/** Audit-only entity — hard delete, no deletable columns. */
@Entity("audit_only")
class AuditOnly extends Auditable(EntityBase) {
  @Key() id!: bigint;
  @Column({ nullable: false }) label!: string;
}

type ColView = { key: boolean; uniq: boolean; aud: unknown; del: unknown; pgType: unknown };
function columnsOf(ctor: Function): Record<string, ColView> {
  const meta = getEntityPersistenceMeta(ctor as never);
  return Object.fromEntries(
    Object.entries(meta.columns).map(([k, v]) => [
      k,
      {
        key: (v as { isKey: boolean }).isKey,
        uniq: (v as { isUnique: boolean }).isUnique,
        aud: (v as { auditableType?: unknown }).auditableType ?? null,
        del: (v as { deletableType?: unknown }).deletableType ?? null,
        pgType: (v as { pgType?: unknown }).pgType ?? null,
      },
    ]),
  );
}

describe("Entity capability mixins (Auditable / Deletable)", () => {
  it("produces column meta identical to manual field declarations", () => {
    const oldCols = columnsOf(LegacyAudited);
    const newCols = columnsOf(MixinAudited);
    expect(newCols).toEqual(oldCols);
  });

  it("audit-only mixin registers exactly the 5 audit columns, no deletable", () => {
    const cols = columnsOf(AuditOnly);
    expect(Object.keys(cols).sort()).toEqual(
      ["created_at", "created_by", "id", "label", "updated_at", "updated_by", "version"].sort(),
    );
    expect(cols.created_at.aud).toBe(AuditableFieldType.CREATED_AT);
    expect(cols.version.aud).toBe(AuditableFieldType.VERSION);
    expect(Object.values(cols).every((c) => c.del === null)).toBe(true);
  });

  it("composed instance satisfies both capability interfaces", () => {
    const e = new MixinAudited();
    const aud: IAuditableEntity = e;
    const del: IDeletableEntity = e;
    expect(aud.version).toBeUndefined(); // declared but unset before hydration
    expect(del.deleted_at).toBeUndefined();
    // Runtime props exist (useDefineForClassFields)
    expect("created_at" in e).toBe(true);
    expect("deleted_at" in e).toBe(true);
  });

  it("static annotation extraction resolves mixin fields through the chain", async () => {
    // The schema pipeline resolves column types from TS annotations via the
    // heritage chain — mixin extends-clauses must resolve to the declaring
    // anonymous classes (AuditableEntity/DeletableEntity).
    const { extractEntityAnnotations, lookupEntityAnnotation } =
      await import("../src/meta/entity-annotation-extract.js");
    const { fileURLToPath } = await import("node:url");
    const fixture = fileURLToPath(new URL("./entities/mixin-entity.ts", import.meta.url));
    const map = await extractEntityAnnotations(fixture);

    // created_by is NOT semantic-pinned — annotation must reach it
    const createdBy = lookupEntityAnnotation(map, "MixinEntity", "created_by");
    expect(createdBy?.typeName).toBe("string");
    const deletedBy = lookupEntityAnnotation(map, "MixinEntity", "deleted_by");
    expect(deletedBy?.typeName).toBe("string"); // union already stripped; optionality lives on .optional
    const version = lookupEntityAnnotation(map, "MixinEntity", "version");
    expect(version?.typeName).toBe("number");
  });
});
