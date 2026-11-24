import "reflect-metadata";
import { describe, it, expect } from "vitest";
import {
  Entity,
  Column,
  Key,
  Unique,
  UniqueIndex,
  EntityBase,
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
