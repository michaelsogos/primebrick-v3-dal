import { describe, it, expect } from "vitest";
import "reflect-metadata";

import {
  compareSnapshots,
  buildSqlPatchFromMetaDiff,
  normalizeDefaultExpr,
  isDriftClean,
  type SchemaSnapshot,
  type SchemaColumnMeta,
} from "../src/index.js";

/** Minimal snapshot builder — only `name` is required on a column. */
function snap(
  source: "entities" | "database",
  columns: Record<string, Partial<SchemaColumnMeta>>,
  capturesDefaults?: boolean,
): SchemaSnapshot {
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    source,
    ...(capturesDefaults !== undefined ? { capturesDefaults } : {}),
    tables: {
      "crm.sequences": {
        kind: "table",
        schema: "crm",
        name: "sequences",
        columns: Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, { name: k, ...v }])),
      },
    },
  };
}

describe("normalizeDefaultExpr — pg_get_expr canonicalization", () => {
  it("strips trailing casts the catalog adds to stored literals", () => {
    expect(normalizeDefaultExpr("'user'::character varying")).toBe("'user'");
    expect(normalizeDefaultExpr("(1)::bigint")).toBe("1");
    expect(normalizeDefaultExpr("1::bigint")).toBe("1");
    expect(normalizeDefaultExpr("'12.34'::numeric(10, 2)")).toBe("'12.34'");
    expect(normalizeDefaultExpr("'now'::text::timestamp with time zone")).toBe("'now'");
  });

  it("leaves bare expressions and literals alone", () => {
    expect(normalizeDefaultExpr("now()")).toBe("now()");
    expect(normalizeDefaultExpr("uuidv7()")).toBe("uuidv7()");
    expect(normalizeDefaultExpr("false")).toBe("false");
    expect(normalizeDefaultExpr("1")).toBe("1");
    expect(normalizeDefaultExpr("interval '1 day'")).toBe("interval '1 day'");
  });

  it("never touches `::` or whitespace INSIDE a quoted literal", () => {
    expect(normalizeDefaultExpr("'foo::bar'::text")).toBe("'foo::bar'");
    expect(normalizeDefaultExpr("'a  b'::character varying")).toBe("'a  b'");
    expect(normalizeDefaultExpr("'it''s'::text")).toBe("'it''s'");
  });

  it("undefined / empty → undefined", () => {
    expect(normalizeDefaultExpr(undefined)).toBeUndefined();
    expect(normalizeDefaultExpr(null)).toBeUndefined();
    expect(normalizeDefaultExpr("   ")).toBeUndefined();
  });
});

describe("compareSnapshots — defaultMismatches", () => {
  it("equal after normalization → no mismatch", () => {
    const e = snap("entities", { step: { defaultSql: "1" }, name: { defaultSql: "'x'" } });
    const d = snap("database", { step: { defaultSql: "(1)::bigint" }, name: { defaultSql: "'x'::character varying" } }, true);
    expect(compareSnapshots(e, d).tables["crm.sequences"]).toBeUndefined();
  });

  it("entity declares, db lacks → SET-side mismatch", () => {
    const e = snap("entities", { step: { defaultSql: "1" } });
    const d = snap("database", { step: {} }, true);
    const t = compareSnapshots(e, d).tables["crm.sequences"]!;
    expect(t.defaultMismatches).toEqual([{ column: "step", entityDefault: "1", databaseDefault: null }]);
  });

  it("db has, entity declares none → DROP-side mismatch", () => {
    const e = snap("entities", { step: {} });
    const d = snap("database", { step: { defaultSql: "(1)::bigint" } }, true);
    const t = compareSnapshots(e, d).tables["crm.sequences"]!;
    expect(t.defaultMismatches).toEqual([{ column: "step", entityDefault: null, databaseDefault: "1" }]);
  });

  it("divergent expressions → mismatch carrying both sides", () => {
    const e = snap("entities", { step: { defaultSql: "1" } });
    const d = snap("database", { step: { defaultSql: "(2)::bigint" } }, true);
    const t = compareSnapshots(e, d).tables["crm.sequences"]!;
    expect(t.defaultMismatches).toEqual([{ column: "step", entityDefault: "1", databaseDefault: "2" }]);
  });

  it("identity/serial `nextval(…)` on the db side is NOT an authored default", () => {
    const e = snap("entities", { id: { isPostgresIdentity: true } });
    const d = snap("database", { id: { defaultSql: "nextval('crm.sequences_id_seq'::regclass)" } }, true);
    expect(compareSnapshots(e, d).tables["crm.sequences"]).toBeUndefined();
  });

  it("stale snapshot without `capturesDefaults` → 'unknown', never flags", () => {
    const e = snap("entities", { step: { defaultSql: "1" } });
    // snapshot written before the capture existed — no marker, no column defaults
    const d = snap("database", { step: {} });
    expect(compareSnapshots(e, d).tables["crm.sequences"]).toBeUndefined();
  });
});

describe("buildSqlPatchFromMetaDiff — column DEFAULT emission", () => {
  it("entity-only default → ALTER COLUMN SET DEFAULT (authored SQL verbatim)", () => {
    const e = snap("entities", { step: { defaultSql: "1" } });
    const diff = compareSnapshots(e, snap("database", { step: {} }, true));
    const sql = buildSqlPatchFromMetaDiff(e, diff);
    expect(sql).toContain('ALTER TABLE "crm"."sequences" ALTER COLUMN "step" SET DEFAULT 1;');
  });

  it("db-only default → ALTER COLUMN DROP DEFAULT", () => {
    const e = snap("entities", { step: {} });
    const diff = compareSnapshots(e, snap("database", { step: { defaultSql: "1" } }, true));
    const sql = buildSqlPatchFromMetaDiff(e, diff);
    expect(sql).toContain('ALTER TABLE "crm"."sequences" ALTER COLUMN "step" DROP DEFAULT;');
  });
});

describe("isDriftClean — defaults participate in the gate", () => {
  it("a defaultMismatch alone is drift", () => {
    const diff = compareSnapshots(snap("entities", { step: { defaultSql: "1" } }), snap("database", { step: {} }, true));
    expect(isDriftClean(diff)).toBe(false);
  });
});
