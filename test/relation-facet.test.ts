import { describe, it, expect } from "vitest";
import "reflect-metadata";

import {
  Entity,
  Key,
  Unique,
  Column,
  Ref,
  Relation,
  getRelationFacet,
  getEntityPersistenceMeta,
  withColumnConstraints,
  buildSqlPatchFromMetaDiff,
  compareSnapshots,
  type UUID,
} from "../src/index.js";
import type { EntityMeta } from "@primebrick/core";
import type { SchemaSnapshot, SchemaMetaDiffV2 } from "../src/index.js";

// ── Fixture: a directed parent→child edge, minimal @Relation entity ─────────
@Entity("rel_links", "crm")
@Relation({
  parent_field: "parent_customer_uuid",
  child_field: "child_customer_uuid",
  type_field: "type_uuid",
})
class RelEdge {
  @Key() id!: bigint;
  @Unique() uuid!: UUID;
  @Column({ nullable: false }) @Ref("customer") parent_customer_uuid!: UUID;
  @Column({ nullable: false }) @Ref("customer") child_customer_uuid!: UUID;
  @Column({ nullable: false }) @Ref("customer_link_type") type_uuid!: UUID;
  @Column({ nullable: true }) note?: string;
}

// Undecorated subclass — inherits the facet through the prototype chain.
class RelEdgeSub extends RelEdge {}

// A plain entity for the negative probe — no @Relation anywhere.
@Entity("rel_plain", "crm")
class RelPlain {
  @Key() id!: bigint;
  @Unique() uuid!: UUID;
  @Column({ nullable: false }) name!: string;
}

// An edge without type_field — pair index has no third key.
@Entity("rel_links2", "crm")
@Relation({ parent_field: "p_uuid", child_field: "c_uuid" })
class RelEdgeNoType {
  @Key() id!: bigint;
  @Unique() uuid!: UUID;
  @Column({ nullable: false }) @Ref("customer") p_uuid!: UUID;
  @Column({ nullable: false }) @Ref("customer") c_uuid!: UUID;
}

// Facet field pointing at a column WITHOUT @Ref → construction error.
@Entity("rel_bad_ref", "crm")
@Relation({ parent_field: "p_uuid", child_field: "c_uuid" })
class RelBadRef {
  @Key() id!: bigint;
  @Unique() uuid!: UUID;
  @Column({ nullable: false }) p_uuid!: UUID;
  @Column({ nullable: false }) @Ref("customer") c_uuid!: UUID;
}

// parent_field === child_field → an edge needs two distinct ends.
@Entity("rel_same_ends", "crm")
@Relation({ parent_field: "p_uuid", child_field: "p_uuid" })
class RelSameEnds {
  @Key() id!: bigint;
  @Unique() uuid!: UUID;
  @Column({ nullable: false }) @Ref("customer") p_uuid!: UUID;
}

const relMeta = (): EntityMeta => ({
  entity: "rel_link",
  translation_key: "rel_link",
  uid: "uuid",
  columns: [
    { key: "parent_customer_uuid", label_key: "x.parent", type: "ref", order: 10 },
    { key: "child_customer_uuid", label_key: "x.child", type: "ref", order: 20 },
    { key: "type_uuid", label_key: "x.type", type: "ref", order: 30 },
    { key: "note", label_key: "x.note", type: "text", order: 40 },
  ],
});

describe("@Relation facet", () => {
  it("resolves the declared facet — declared on the class or inherited subclass-first", () => {
    const f = getRelationFacet(RelEdge);
    expect(f).toEqual({
      parent_field: "parent_customer_uuid",
      child_field: "child_customer_uuid",
      type_field: "type_uuid",
    });
    expect(getRelationFacet(RelEdgeSub)).toEqual(f); // inherited through the chain
    expect(getRelationFacet(RelEdgeNoType)).toEqual({ parent_field: "p_uuid", child_field: "c_uuid" });
    expect(getRelationFacet(RelPlain)).toBeUndefined();
  });

  it("derives the unordered-pair unique index into persistence meta", () => {
    const p = getEntityPersistenceMeta(RelEdge);
    const ix = (p.indexes ?? []).find((i) => i.name === "rel_links_pair_uq");
    expect(ix).toBeDefined();
    expect(ix).toMatchObject({ using: "btree", isUnique: true });
    expect(ix!.expressions).toEqual([
      "LEAST(parent_customer_uuid, child_customer_uuid)",
      "GREATEST(parent_customer_uuid, child_customer_uuid)",
    ]);
    expect(ix!.columns).toEqual(["type_uuid"]);
  });

  it("omits the type column from the pair index when type_field is undeclared", () => {
    const p = getEntityPersistenceMeta(RelEdgeNoType);
    const ix = (p.indexes ?? []).find((i) => i.name === "rel_links2_pair_uq");
    expect(ix).toBeDefined();
    expect(ix!.expressions).toEqual(["LEAST(p_uuid, c_uuid)", "GREATEST(p_uuid, c_uuid)"]);
    expect(ix!.columns).toEqual([]);
  });

  it("throws when a facet field is not a @Ref column", () => {
    expect(() => getEntityPersistenceMeta(RelBadRef)).toThrow(
      /parent_field "p_uuid" must be a column carrying @Ref/,
    );
  });

  it("throws when parent_field and child_field resolve to the same column", () => {
    expect(() => getEntityPersistenceMeta(RelSameEnds)).toThrow(
      /parent_field and child_field resolve to the same column/,
    );
  });
});

describe("withColumnConstraints — relation identity contract", () => {
  it("serves a relation meta with no display_field and no pin — ends gain immutable:true", () => {
    const out = withColumnConstraints(relMeta(), RelEdge);
    const byKey = Object.fromEntries(out.columns.map((c) => [c.key, c]));
    expect(out.display_field).toBeUndefined();
    // ends: create-set / frozen afterwards — injected, never authored
    expect(byKey.parent_customer_uuid!.immutable).toBe(true);
    expect(byKey.child_customer_uuid!.immutable).toBe(true);
    // the mutable type field is NOT immutable (relationship type may evolve)
    expect(byKey.type_uuid!.immutable).toBeUndefined();
    // uid contract survives untouched on relation entities
    expect(byKey.uuid).toMatchObject({ order: -1, sticky: true, default_visible: false });
    expect(byKey.uuid!.hideable).not.toBe(false);
  });

  it("throws when the relation meta authors display_field", () => {
    const meta = relMeta() as EntityMeta & { display_field?: string };
    meta.display_field = "note";
    expect(() => withColumnConstraints(meta, RelEdge)).toThrow(
      /relation entities never declare display_field/,
    );
  });

  it("throws when the relation meta authors display_name", () => {
    const meta = relMeta() as EntityMeta & { display_name?: string };
    meta.display_name = "${note}";
    expect(() => withColumnConstraints(meta, RelEdge)).toThrow(
      /relation entities never declare display_name/,
    );
  });

  it("throws when a relation column authors the pinned-identity combination", () => {
    const meta = relMeta();
    meta.columns[3] = { ...meta.columns[3]!, sticky: true, hideable: false };
    expect(() => withColumnConstraints(meta, RelEdge)).toThrow(/relation entities carry no pinned column/);
  });

  it("throws when an end column authors immutable (the facet owns end mutability)", () => {
    const meta = relMeta();
    meta.columns[0] = { ...meta.columns[0]!, immutable: false };
    expect(() => withColumnConstraints(meta, RelEdge)).toThrow(
      /column "parent_customer_uuid" authors immutable/,
    );
  });

  it("throws when a facet field is hidden — relation fields must be served", () => {
    const meta = relMeta();
    meta.columns[1] = { ...meta.columns[1]!, hidden: true };
    expect(() => withColumnConstraints(meta, RelEdge)).toThrow(
      /@Relation child_field "child_customer_uuid" is not a served column/,
    );
  });
});

// ── Schema diff → SQL patch: the pair-unique expression index ───────────────

const entitySnap = (): SchemaSnapshot => ({
  version: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  source: "entities",
  tables: {
    "crm.rel_links": {
      kind: "table",
      schema: "crm",
      name: "rel_links",
      indexes: [
        {
          name: "rel_links_pair_uq",
          expressions: [
            "LEAST(parent_customer_uuid, child_customer_uuid)",
            "GREATEST(parent_customer_uuid, child_customer_uuid)",
          ],
          columns: ["type_uuid"],
          using: "btree",
          isUnique: true,
        },
      ],
      columns: {
        id: { name: "id", dataType: "bigint", isPrimaryKey: true, isPostgresIdentity: true },
        uuid: { name: "uuid", dataType: "uuid", isUnique: true },
        parent_customer_uuid: { name: "parent_customer_uuid", dataType: "uuid", isNullable: false },
        child_customer_uuid: { name: "child_customer_uuid", dataType: "uuid", isNullable: false },
        type_uuid: { name: "type_uuid", dataType: "uuid", isNullable: false },
      },
    },
  },
});

const emptyDiff = (over: Partial<SchemaMetaDiffV2> = {}): SchemaMetaDiffV2 => ({
  version: 2,
  generatedAt: "2026-01-01T00:00:00.000Z",
  onlyInEntityTables: [],
  onlyInDatabaseTables: [],
  tables: {},
  ...over,
});

describe("@Relation pair-unique index → SQL emission", () => {
  it("emits LEAST/GREATEST keys verbatim-parenthesized on a new table", () => {
    const sql = buildSqlPatchFromMetaDiff(
      entitySnap(),
      emptyDiff({ onlyInEntityTables: ["crm.rel_links"] }),
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "rel_links_pair_uq" ON "crm"."rel_links" ' +
        '((LEAST(parent_customer_uuid, child_customer_uuid)), ' +
        '(GREATEST(parent_customer_uuid, child_customer_uuid)), "type_uuid");',
    );
  });

  it("emits CONCURRENTLY when the index is new on an existing table", () => {
    const sql = buildSqlPatchFromMetaDiff(
      entitySnap(),
      emptyDiff({
        tables: {
          "crm.rel_links": {
            onlyInEntityColumns: [],
            onlyInDatabaseColumns: [],
            likelyRenames: [],
            typeMismatches: [],
            nullabilityMismatches: [],
            onlyInEntityIndexes: ["rel_links_pair_uq"],
            onlyInDatabaseIndexes: [],
            indexMismatches: [],
            onlyInEntityForeignKeys: [],
            onlyInDatabaseForeignKeys: [],
            foreignKeyMismatches: [],
          },
        },
      }),
    );
    expect(sql).toContain("CREATE UNIQUE INDEX CONCURRENTLY");
    expect(sql).toContain("(LEAST(parent_customer_uuid, child_customer_uuid))");
  });
});

describe("@Relation pair-unique index → snapshot comparison", () => {
  it("matches pg_get_indexdef output — no phantom drift on expression indexes", () => {
    const dbSnap: SchemaSnapshot = {
      version: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      source: "database",
      tables: {
        "crm.rel_links": {
          kind: "table",
          schema: "crm",
          name: "rel_links",
          indexes: [
            {
              // Introspected columns are useless on expression indexes —
              // the comparison must resolve through `definition`.
              name: "rel_links_pair_uq",
              columns: ["LEAST(parent_customer_uuid", "child_customer_uuid"],
              using: "btree",
              isUnique: true,
              definition:
                "CREATE UNIQUE INDEX rel_links_pair_uq ON crm.rel_links USING btree " +
                "(LEAST(parent_customer_uuid, child_customer_uuid), " +
                "GREATEST(parent_customer_uuid, child_customer_uuid), type_uuid)",
            },
          ],
          columns: {},
        },
      },
    };
    const diff = compareSnapshots(entitySnap(), dbSnap);
    expect(diff.tables["crm.rel_links"]!.onlyInEntityIndexes).toEqual([]);
    expect(diff.tables["crm.rel_links"]!.indexMismatches).toEqual([]);
  });

  it("matches an entity-snapshot db side — `db:check` uses `expressions`, not `definition`", () => {
    // `db:check --snapshot snapshot-entities.json` hands an ENTITY snapshot
    // as the "database" side: its indexes carry `expressions` but no
    // `definition`. The comparator must mirror the entity-side signature
    // or every expression index reports phantom drift.
    const entitySideAsDb: SchemaSnapshot = {
      version: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      source: "database",
      tables: {
        "crm.rel_links": {
          kind: "table",
          schema: "crm",
          name: "rel_links",
          indexes: [
            {
              name: "rel_links_pair_uq",
              expressions: [
                "LEAST(parent_customer_uuid, child_customer_uuid)",
                "GREATEST(parent_customer_uuid, child_customer_uuid)",
              ],
              columns: ["type_uuid"],
              using: "btree",
              isUnique: true,
            },
          ],
          columns: {},
        },
      },
    };
    const diff = compareSnapshots(entitySnap(), entitySideAsDb);
    expect(diff.tables["crm.rel_links"]!.indexMismatches).toEqual([]);
    expect(diff.tables["crm.rel_links"]!.onlyInEntityIndexes).toEqual([]);
  });

  it("reports a mismatch when the db index keys diverge", () => {
    const dbSnap: SchemaSnapshot = {
      version: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      source: "database",
      tables: {
        "crm.rel_links": {
          kind: "table",
          schema: "crm",
          name: "rel_links",
          indexes: [
            {
              name: "rel_links_pair_uq",
              columns: ["x"],
              using: "btree",
              isUnique: true,
              // Different key set: only LEAST — the GREATEST key is missing.
              definition:
                "CREATE UNIQUE INDEX rel_links_pair_uq ON crm.rel_links USING btree " +
                "(LEAST(parent_customer_uuid, child_customer_uuid), type_uuid)",
            },
          ],
          columns: {},
        },
      },
    };
    const diff = compareSnapshots(entitySnap(), dbSnap);
    expect(diff.tables["crm.rel_links"]!.indexMismatches).toHaveLength(1);
    expect(diff.tables["crm.rel_links"]!.indexMismatches[0]!.name).toBe("rel_links_pair_uq");
  });
});
