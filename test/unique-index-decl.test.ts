import "reflect-metadata";
import { describe, it, expect } from "vitest";
import {
  Entity,
  Column,
  Index,
  Key,
  Unique,
  UniqueIndex,
  EntityBase,
  Auditable,
  Deletable,
  getEntityPersistenceMeta,
  buildEntitySnapshot,
  type UUID,
} from "../src/index.js";

/**
 * Phase-2 unique-index declaration model — @UniqueIndex (class-level options)
 * + @Unique (per-column membership, accumulated).
 */

// ── fixtures ────────────────────────────────────────────────────────────

/** Multi-group column: `code` joins a solo unique AND a composite — the
 *  service_registry partial-unique shape. Not Deletable: no aliveOnly. */
@Entity("uq_multi_group")
@UniqueIndex({ name: "uq_multi_code_solo", where: "is_scoped = true" })
@UniqueIndex({ name: "uq_multi_code_pair", where: "is_scoped = false" })
class MultiGroupEntity {
  @Key() id!: bigint;
  @Unique("uq_multi_code_solo", 0)
  @Unique("uq_multi_code_pair", 0)
  code!: string;
  @Unique("uq_multi_code_pair", 1)
  base!: string;
  is_scoped!: boolean;
}

/** Deletable entity — bare @Unique() gets aliveOnly by default. */
@Entity("uq_deletable")
class DeletableUniqueEntity extends Deletable(EntityBase) {
  @Key() id!: bigint;
  @Unique() key!: string;
}

/** Deletable entity opting out explicitly via the named class-level path. */
@Entity("uq_deletable_optout")
@UniqueIndex({ name: "uq_optout_full", aliveOnly: false })
class DeletableOptOutEntity extends Deletable(EntityBase) {
  @Key() id!: bigint;
  @Unique("uq_optout_full", 0) key!: string;
}

/** Deletable with where + default aliveOnly → combined predicate. */
@Entity("uq_deletable_where")
@UniqueIndex({ name: "uq_scoped_partial", where: "is_scoped = true" })
class DeletableWhereEntity extends Deletable(EntityBase) {
  @Key() id!: bigint;
  @Unique("uq_scoped_partial", 0) code!: string;
  is_scoped!: boolean;
}

/** nullsNotDistinct rides the class-level decl. */
@Entity("uq_nnd")
@UniqueIndex({ name: "uq_nnd_pair", nullsNotDistinct: true })
class NndEntity {
  @Key() id!: bigint;
  @Unique("uq_nnd_pair", 0) a!: string;
  @Unique("uq_nnd_pair", 1) b!: string;
}

// ── enforcement fixtures (constructed lazily per-test so the throw lands
//    at getEntityPersistenceMeta, matching the boot path) ────────────────

@Entity("uq_nodecl")
class NoDeclEntity {
  @Key() id!: bigint;
  @Unique("uq_missing", 0) code!: string;
}

@Entity("uq_empty")
@UniqueIndex({ name: "uq_empty_idx" })
class EmptyDeclEntity {
  @Key() id!: bigint;
  code!: string;
}

@Entity("uq_badcol")
@UniqueIndex({ name: "uq_badcol_idx", where: "missing_col = true" })
class BadWhereColEntity {
  @Key() id!: bigint;
  @Unique("uq_badcol_idx", 0) code!: string;
}

@Entity("uq_deleted")
@UniqueIndex({ name: "uq_deleted_idx", where: "deleted_at IS NULL" })
class DeletedAtWhereEntity extends Deletable(EntityBase) {
  @Key() id!: bigint;
  @Unique("uq_deleted_idx", 0) code!: string;
}

@Entity("uq_alive_nondeletable")
@UniqueIndex({ name: "uq_alive_idx", aliveOnly: true })
class AliveNonDeletableEntity {
  @Key() id!: bigint;
  @Unique("uq_alive_idx", 0) code!: string;
}

// ── @Index sort/nulls/with fixtures ─────────────────────────────────────

/** Composite "filter + timestamp DESC" — the auth_events/job_runs shape. */
@Entity("ix_desc")
class DescCompositeEntity {
  @Key() id!: bigint;
  @Index({ name: "ix_desc_kind_at", order: 0 })
  kind!: string;
  @Index({ name: "ix_desc_kind_at", order: 1, sort: "desc" })
  event_at!: Date;
}

/** crm.sequences shape — desc + explicit NULLS LAST + partial predicate. */
@Entity("ix_desc_nulls")
class DescNullsLastEntity extends Deletable(EntityBase) {
  @Key() id!: bigint;
  @Index({ name: "ix_desc_nulls", order: 0, where: "deleted_at IS NULL" })
  binding_key!: string;
  @Index({ name: "ix_desc_nulls", order: 1, sort: "desc", nulls: "last", where: "deleted_at IS NULL" })
  default_from?: Date;
}

/** hnsw vector index — using/opclass/with storage params. */
@Entity("ix_vector")
class VectorIdxEntity {
  @Key() id!: bigint;
  @Index({ using: "hnsw", opclass: "vector_cosine_ops", with: { m: "16", ef_construction: "64" } })
  embedding!: number[];
}

/** diverging `with` across members — construction-time violation. */
@Entity("ix_bad_with")
class BadWithEntity {
  @Key() id!: bigint;
  @Index({ name: "ix_bad", order: 0, with: { m: "16" } })
  a!: string;
  @Index({ name: "ix_bad", order: 1, with: { m: "32" } })
  b!: string;
}

/** Class-level spec on a mixin column — the job_runs/audit-column shape. */
@Entity("ix_spec")
@Index({
  name: "ix_spec_created",
  columns: [{ name: "created_at", sort: "desc" }],
})
class SpecEntity extends Auditable(EntityBase) {
  @Key() id!: bigint;
}

/** Spec colliding with a property-level group — ownership violation. */
@Entity("ix_spec_collide")
@Index({ name: "ix_collide", columns: ["a"] })
class SpecCollideEntity {
  @Key() id!: bigint;
  @Index({ name: "ix_collide" })
  a!: string;
}

/** Spec column that is not a column — resolution violation. */
@Entity("ix_spec_badcol")
@Index({ name: "ix_badcol", columns: ["ghost_col"] })
class SpecBadColEntity {
  @Key() id!: bigint;
}

// ── tests ───────────────────────────────────────────────────────────────

describe("@UniqueIndex + @Unique accumulate — snapshot emission", () => {
  it("a column joins N named unique indexes", () => {
    const meta = getEntityPersistenceMeta(MultiGroupEntity);
    const code = meta.columns["code"]!;
    // decorators on one property apply bottom-up (last written runs first)
    expect(code.uniques).toEqual([
      { name: "uq_multi_code_pair", order: 0 },
      { name: "uq_multi_code_solo", order: 0 },
    ]);
    expect(meta.uniqueIndexes).toHaveLength(2);
  });

  it("named groups resolve where from the class decl", () => {
    const snap = buildEntitySnapshot([MultiGroupEntity]);
    const table = Object.values(snap.tables)[0]!;
    const solo = table.indexes!.find((i) => i.name === "uq_multi_code_solo")!;
    const pair = table.indexes!.find((i) => i.name === "uq_multi_code_pair")!;
    expect(solo.columns).toEqual(["code"]);
    expect(solo.where).toBe("is_scoped = true");
    expect(pair.columns).toEqual(["code", "base"]);
    expect(pair.where).toBe("is_scoped = false");
  });

  it("aliveOnly defaults ON for Deletable entities (bare @Unique too)", () => {
    const snap = buildEntitySnapshot([DeletableUniqueEntity]);
    const ix = Object.values(snap.tables)[0]!.indexes!.find(
      (i) => i.name === "uq_deletable_key_uq",
    )!;
    expect(ix.isUnique).toBe(true);
    expect(ix.where).toBe("deleted_at IS NULL");
  });

  it("aliveOnly:false opts out explicitly", () => {
    const snap = buildEntitySnapshot([DeletableOptOutEntity]);
    const ix = Object.values(snap.tables)[0]!.indexes!.find(
      (i) => i.name === "uq_optout_full",
    )!;
    expect(ix.where).toBeUndefined();
  });

  it("where composes as (where) AND (deleted_at IS NULL)", () => {
    const snap = buildEntitySnapshot([DeletableWhereEntity]);
    const ix = Object.values(snap.tables)[0]!.indexes!.find(
      (i) => i.name === "uq_scoped_partial",
    )!;
    // emit order must norm-match the live pg_get_indexdef rendering
    expect(ix.where).toBe("(is_scoped = true) AND (deleted_at IS NULL)");
  });

  it("nullsNotDistinct carries on the index meta", () => {
    const snap = buildEntitySnapshot([NndEntity]);
    const ix = Object.values(snap.tables)[0]!.indexes!.find(
      (i) => i.name === "uq_nnd_pair",
    )!;
    expect(ix.nullsNotDistinct).toBe(true);
    expect(ix.columns).toEqual(["a", "b"]);
  });

  it("non-Deletable entities emit no predicate by default", () => {
    const snap = buildEntitySnapshot([MultiGroupEntity]);
    const solo = Object.values(snap.tables)[0]!.indexes!.find(
      (i) => i.name === "uq_multi_code_solo",
    )!;
    expect(solo.where).toBe("is_scoped = true"); // no deleted_at clause added
  });
});

describe("construction enforcement — fail-loud at meta resolution", () => {
  it("@Unique(name) without class-level @UniqueIndex(name) throws", () => {
    expect(() => getEntityPersistenceMeta(NoDeclEntity)).toThrow(
      /@Unique\("uq_missing"\) has no matching class-level @UniqueIndex/,
    );
  });

  it("@UniqueIndex with zero member columns throws", () => {
    expect(() => getEntityPersistenceMeta(EmptyDeclEntity)).toThrow(
      /@UniqueIndex\("uq_empty_idx"\) declares no member columns/,
    );
  });

  it("where referencing an undeclared column throws", () => {
    expect(() => getEntityPersistenceMeta(BadWhereColEntity)).toThrow(
      /where references column\(s\) not on the entity: missing_col/,
    );
  });

  it("where must not contain a deleted_at predicate — use aliveOnly", () => {
    expect(() => getEntityPersistenceMeta(DeletedAtWhereEntity)).toThrow(
      /must not reference "deleted_at"/,
    );
  });

  it("aliveOnly:true on a non-Deletable entity throws", () => {
    expect(() => getEntityPersistenceMeta(AliveNonDeletableEntity)).toThrow(
      /aliveOnly is only meaningful on Deletable entities/,
    );
  });
});

describe("@Index sort/nulls/with — declaration model", () => {
  it("per-member sort resolves into a parallel array", () => {
    const meta = getEntityPersistenceMeta(DescCompositeEntity);
    const ix = meta.indexes!.find((i) => i.name === "ix_desc_kind_at")!;
    expect(ix.columns).toEqual(["kind", "event_at"]);
    expect(ix.sort).toEqual(["asc", "desc"]);
    expect(ix.nulls).toBeUndefined();
  });

  it("nulls resolves the direction default for undeclared members", () => {
    const meta = getEntityPersistenceMeta(DescNullsLastEntity);
    const ix = meta.indexes!.find((i) => i.name === "ix_desc_nulls")!;
    expect(ix.columns).toEqual(["binding_key", "default_from"]);
    expect(ix.sort).toEqual(["asc", "desc"]);
    // binding_key undeclared → asc default "last"; default_from explicit "last"
    expect(ix.nulls).toEqual(["last", "last"]);
    expect(ix.where).toBe("deleted_at IS NULL");
  });

  it("with/opclass/using carry through as index-level options", () => {
    const meta = getEntityPersistenceMeta(VectorIdxEntity);
    const ix = meta.indexes!.find((i) => i.name === "ix_vector_embedding_idx")!;
    expect(ix.using).toBe("hnsw");
    expect(ix.opclass).toBe("vector_cosine_ops");
    expect(ix.with).toEqual({ m: "16", ef_construction: "64" });
  });

  it("diverging `with` across members throws at meta resolution", () => {
    expect(() => getEntityPersistenceMeta(BadWithEntity)).toThrow(
      /has inconsistent using\/opclass\/where\/with/,
    );
  });
});

describe("@Index class-level spec — mixin + spec-owned columns", () => {
  it("resolves a mixin column (created_at) without redeclaring it", () => {
    const meta = getEntityPersistenceMeta(SpecEntity);
    const ix = meta.indexes!.find((i) => i.name === "ix_spec_created")!;
    expect(ix.columns).toEqual(["created_at"]);
    expect(ix.sort).toEqual(["desc"]);
    // the audit column stays intact — spec adds the index, not a second column
    const snap = buildEntitySnapshot([SpecEntity]);
    expect(Object.values(snap.tables)[0]!.columns["created_at"]!.dataType).toBe("timestamptz");
  });

  it("spec name colliding with a property group throws", () => {
    expect(() => getEntityPersistenceMeta(SpecCollideEntity)).toThrow(
      /collides with a property-level @Index group/,
    );
  });

  it("spec column not on the entity throws", () => {
    expect(() => getEntityPersistenceMeta(SpecBadColEntity)).toThrow(
      /column "ghost_col" is not a column of the entity/,
    );
  });
});
