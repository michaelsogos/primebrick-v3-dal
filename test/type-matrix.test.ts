import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";

import { extractEntityAnnotations, type EntityAnnotationInfo } from "../src/meta/entity-annotation-extract.js";
import { buildEntitySnapshot } from "../src/schema-diff/build-entity-snapshot.js";
import {
  assertPgTypeCompatible,
  columnTypeWarnings,
  pgTypeFromAnnotation,
  resolvePgTypeForSchema,
  type EntityColumnTypeHints,
} from "../src/meta/entity-ts-to-pg.js";
import {
  columnHintsFromMetaColumn,
  jsValueToPgParam,
  pgValueToJsValue,
} from "../src/meta/column-pg-io.js";
import { getEntityPersistenceMeta } from "../src/index.js";
import { Vector } from "../src/types/vector.js";
import { Decimal, dec } from "@primebrick/core/decimal";
import { TypeMatrixEntity } from "./entities/type-matrix-entity.js";

/**
 * The type contract, pinned cell by cell:
 *   TS annotation → resolved PostgreSQL type → io/wire behaviour.
 *
 * Three layers are exercised:
 *   1. resolution — `extractEntityAnnotations` (real TS source, transpiler-free)
 *      + `buildEntitySnapshot` over the canonical `TypeMatrixEntity` fixture;
 *   2. authoring rules — `resolvePgTypeForSchema` throws on the unmappable,
 *      `assertPgTypeCompatible` enforces the explicit-pgType whitelist,
 *      `columnTypeWarnings` flags `*_uuid`/`redundant-pgType` smells;
 *   3. io — `jsValueToPgParam`/`pgValueToJsValue` honour the entity meta
 *      (`jsType`, semantic pins) so values hydrate to the annotated type.
 */

const ann = (typeName: string, extra: Partial<EntityAnnotationInfo> = {}): EntityAnnotationInfo => ({
  prop: "p",
  annotation: typeName,
  typeName,
  optional: false,
  nullableUnion: false,
  isArray: false,
  isStringLiteralUnion: false,
  isObjectLike: false,
  isUnmappable: false,
  file: "synthetic.ts",
  ...extra,
});

const hints = (over: Partial<EntityColumnTypeHints> = {}): EntityColumnTypeHints => ({
  sqlName: "p",
  propertyKey: "p",
  isKey: false,
  ...over,
});

// ─── 1. The canonical fixture — full resolution pipeline ─────────────────────

const FIXTURE = fileURLToPath(new URL("./entities/type-matrix-entity.ts", import.meta.url));
const annots = await extractEntityAnnotations(FIXTURE);
const snap = buildEntitySnapshot([TypeMatrixEntity], { annotations: annots });
const cols = snap.tables["matrix.type_matrix"]!.columns;

describe("type matrix — annotation → resolved PostgreSQL type", () => {
  const EXPECTED: Record<string, string> = {
    id: "int8",
    uuid: "uuid",

    txt: "text",
    vc: "varchar(64)",
    cc: "char(2)",
    ip: "inet",
    ci: "citext",

    num: "float8",
    n4: "int4",
    n2: "int2",
    f4: "float4",
    big: "int8",
    flag: "boolean",

    ts: "timestamptz",
    ts_ntz: "timestamp",
    day: "date",
    tod: "time",
    tod_tz: "timetz",

    money: "numeric",
    price: "numeric(12,4)",
    emb: "vector",
    emb3: "vector(3)",

    meta: "jsonb",
    doc: "json",
    blob: "bytea",

    tags: "text[]",
    scores: "float8[]",
    ids: "int8[]",
    refs: "uuid[]",
    flags: "boolean[]",
    hist: "numeric[]",

    status: "text",
    factor: "text",

    created_at: "timestamptz",
    version: "int4",
    deleted_at: "timestamptz",
    last_synced_at: "timestamptz",

    opt_txt: "text",
    opt_num: "float8",
  };

  it.each(Object.entries(EXPECTED))("%s resolves to %s", (col, want) => {
    expect(cols[col], `column ${col} must exist`).toBeDefined();
    expect(cols[col]!.dataType).toBe(want);
  });

  it("covers every fixture column — no unmapped leftovers", () => {
    expect(Object.keys(cols).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("the canonical entity produces zero authoring warnings", () => {
    const warnings: string[] = [];
    for (const ctor of [TypeMatrixEntity]) {
      const meta = getEntityPersistenceMeta(ctor);
      for (const [sqlName, c] of Object.entries(meta.columns)) {
        warnings.push(
          ...columnTypeWarnings(meta.entityClassName, {
            sqlName,
            propertyKey: c.propertyKey,
            isKey: c.isKey,
            explicitPgType: c.pgType,
            length: c.length,
            precision: c.precision,
            scale: c.scale,
            auditableType: c.auditableType,
            deletableType: c.deletableType,
            synchronizableType: c.synchronizableType,
            annotation: lookupForTest(c.propertyKey),
          }, resolveForTest(c.propertyKey, sqlName, c)).map((w) => w.message),
        );
      }
    }
    expect(warnings).toEqual([]);

    function lookupForTest(prop: string) {
      return [...annots.classes.values()]
        .flatMap((e) => [...e.props.values()])
        .find((p) => p.prop === prop && p.file.endsWith("type-matrix-entity.ts"));
    }
    function resolveForTest(
      prop: string,
      sqlName: string,
      c: ReturnType<typeof getEntityPersistenceMeta>["columns"][string],
    ) {
      return resolvePgTypeForSchema({
        sqlName,
        propertyKey: prop,
        isKey: c.isKey,
        explicitPgType: c.pgType,
        length: c.length,
        precision: c.precision,
        scale: c.scale,
        auditableType: c.auditableType,
        deletableType: c.deletableType,
        synchronizableType: c.synchronizableType,
        annotation: lookupForTest(prop),
      });
    }
  });

  it("@IsNotColumn properties never become columns", () => {
    expect(cols["helper"]).toBeUndefined();
  });

  it("identity key flags", () => {
    expect(cols["id"]!.isPrimaryKey).toBe(true);
    expect(cols["id"]!.isPostgresIdentity).toBe(true);
    expect(cols["uuid"]!.isUnique).toBe(true);
  });

  it("nullability", () => {
    expect(cols["opt_txt"]!.isNullable).toBe(true);
    expect(cols["opt_num"]!.isNullable).toBe(true);
    expect(cols["deleted_at"]!.isNullable).toBe(true);
    expect(cols["txt"]!.isNullable).toBe(false);
    expect(cols["num"]!.isNullable).toBe(false);
  });
});

// ─── 2a. Pure mapping — pgTypeFromAnnotation ──────────────────────────────────

describe("pgTypeFromAnnotation — pure mapping table", () => {
  const arr = (elementTypeName: string) => ann("unused", { isArray: true, elementTypeName });
  const CASES: [EntityAnnotationInfo, string | null][] = [
    [ann("UUID"), "uuid"],
    [ann("Decimal"), "numeric"],
    [ann("ISODate"), "date"],
    [ann("ISOTime"), "time"],
    [ann("Vector"), "vector"],
    [ann("string"), "text"],
    [ann("number"), "float8"],
    [ann("bigint"), "int8"],
    [ann("boolean"), "boolean"],
    [ann("Date"), "timestamptz"],
    [ann("Uint8Array"), "bytea"],
    [arr("string"), "text[]"],
    [arr("UUID"), "uuid[]"],
    [arr("number"), "float8[]"],
    [arr("bigint"), "int8[]"],
    [arr("boolean"), "boolean[]"],
    [arr("Decimal"), "numeric[]"],
    [ann("MfaFactorType", { isStringLiteralUnion: true }), "text"],
    [ann('"totp"', { isStringLiteralUnion: true }), "text"],
    [ann("Record<string, unknown>", { isObjectLike: true }), "jsonb"],
    [ann("unknown", { isObjectLike: true }), "jsonb"],
    [ann("object", { isObjectLike: true }), "jsonb"],
    // unmappable — resolve must throw, never silently map to text/jsonb
    [ann("() => void", { isUnmappable: true, isObjectLike: true }), null],
    [ann("[string, number]", { isUnmappable: true }), null],
    [ann("Colour", { isUnmappable: true }), null],
    [ann("unique symbol", { isUnmappable: true }), null],
  ];
  it.each(CASES)("annotation %j → %s", (a, want) => {
    expect(pgTypeFromAnnotation(a)).toBe(want);
  });
});

// ─── 2b. resolvePgTypeForSchema — resolution order + failure modes ────────────

describe("resolvePgTypeForSchema", () => {
  it("explicit pgType wins over annotation", () => {
    expect(resolvePgTypeForSchema(hints({ explicitPgType: "int4", annotation: ann("number") }))).toBe("int4");
  });

  it("applies modifiers: length→varchar(n)/vector(n), precision/scale→numeric(p,s)", () => {
    expect(resolvePgTypeForSchema(hints({ annotation: ann("string"), length: 20 }))).toBe("varchar(20)");
    expect(resolvePgTypeForSchema(hints({ annotation: ann("Vector"), length: 1024 }))).toBe("vector(1024)");
    expect(resolvePgTypeForSchema(hints({ annotation: ann("Decimal"), precision: 12, scale: 4 }))).toBe("numeric(12,4)");
    expect(resolvePgTypeForSchema(hints({ annotation: ann("Decimal"), precision: 10 }))).toBe("numeric(10)");
  });

  it("semantic pins beat annotations (VERSION is int4 even on a `number` prop)", () => {
    expect(resolvePgTypeForSchema(hints({ auditableType: "VERSION", annotation: ann("number") }))).toBe("int4");
    expect(resolvePgTypeForSchema(hints({ auditableType: "CREATED_AT", annotation: ann("Date") }))).toBe("timestamptz");
    expect(resolvePgTypeForSchema(hints({ deletableType: "DELETED_AT", annotation: ann("Date") }))).toBe("timestamptz");
    expect(resolvePgTypeForSchema(hints({ synchronizableType: "LAST_SYNCED_AT", annotation: ann("Date") }))).toBe("timestamptz");
  });

  it("throws without annotation information — never silently text", () => {
    expect(() => resolvePgTypeForSchema(hints())).toThrow(/No type information/);
  });

  it("throws on unmappable annotations (functions, tuples, enums)", () => {
    const fn = ann("() => void", { isUnmappable: true, isObjectLike: true });
    expect(() => resolvePgTypeForSchema(hints({ annotation: fn }))).toThrow(/Unmappable/);
    const tuple = ann("[string, number]", { isUnmappable: true });
    expect(() => resolvePgTypeForSchema(hints({ annotation: tuple }))).toThrow(/Unmappable/);
  });

  it("explicit pgType is the escape hatch for unmappable annotations", () => {
    const fn = ann("() => void", { isUnmappable: true, isObjectLike: true });
    expect(resolvePgTypeForSchema(hints({ explicitPgType: "jsonb", annotation: fn }))).toBe("jsonb");
  });

  it("rejects incompatible explicit pgType via the whitelist", () => {
    expect(() =>
      resolvePgTypeForSchema(hints({ explicitPgType: "int8", annotation: ann("number") })),
    ).toThrow(/incompatible/);
  });
});

// ─── 2c. assertPgTypeCompatible — the whitelist ───────────────────────────────

describe("assertPgTypeCompatible — annotation ↔ pgType whitelist", () => {
  const ARR = (el: string) => ann("unused", { isArray: true, elementTypeName: el });
  const ALLOW: [EntityAnnotationInfo, string][] = [
    [ann("UUID"), "uuid"],
    [ann("string"), "varchar"],
    [ann("string"), "char"],
    [ann("string"), "citext"],
    [ann("string"), "inet"],
    [ann("string"), "cidr"],
    [ann("string"), "macaddr"],
    [ann("string"), "macaddr8"],
    [ann("string"), "jsonb"],
    [ann("string"), "json"],
    [ann("string"), "xml"],
    [ann("string"), "uuid"], // string-typed uuid columns exist — explicit opt-in
    [ann("number"), "float8"],
    [ann("number"), "float4"],
    [ann("number"), "int4"],
    [ann("number"), "int2"],
    [ann("bigint"), "int8"],
    [ann("boolean"), "boolean"],
    [ann("Decimal"), "numeric"],
    [ann("Date"), "timestamptz"],
    [ann("Date"), "timestamp"],
    [ann("ISODate"), "date"],
    [ann("ISOTime"), "time"],
    [ann("ISOTime"), "timetz"],
    [ann("Vector"), "vector"],
    [ann("Vector"), "vector(3)"], // dimension literal — modifier-stripped on check
    [ann("Uint8Array"), "bytea"],
    [ann("object", { isObjectLike: true }), "jsonb"],
    [ann("object", { isObjectLike: true }), "json"],
    [ARR("string"), "text[]"],
    [ARR("string"), "varchar[]"],
    [ARR("string"), "jsonb"],
    [ARR("UUID"), "uuid[]"],
    [ARR("number"), "float8[]"],
    [ARR("number"), "float4[]"],
    [ARR("number"), "int4[]"],
    [ARR("number"), "int2[]"],
    [ARR("number"), "numeric[]"],
    [ARR("bigint"), "int8[]"],
    [ARR("bigint"), "numeric[]"],
    [ARR("boolean"), "boolean[]"],
    [ARR("Decimal"), "numeric[]"],
  ];
  it.each(ALLOW)("allows %j + pgType %s", (a, pg) => {
    expect(() => assertPgTypeCompatible(a, pg, "p")).not.toThrow();
  });

  const DENY: [EntityAnnotationInfo, string][] = [
    [ann("UUID"), "text"],       // a uuid-typed prop must not degrade to text
    [ann("UUID"), "varchar"],
    [ann("number"), "int8"],     // integer intent → `bigint` prop, not `number`
    [ann("number"), "numeric"],  // numeric hydrates as Decimal — `number` lies
    [ann("number"), "text"],
    [ann("number"), "boolean"],
    [ann("bigint"), "int4"],     // narrowing an int8 prop hides overflow
    [ann("bigint"), "float8"],
    [ann("bigint"), "numeric"],
    [ann("boolean"), "text"],
    [ann("Decimal"), "float8"],  // precision intent → Decimal prop, not number
    [ann("Decimal"), "int8"],
    [ann("Date"), "date"],       // `date` is ISODate (string) — Date would tz-shift
    [ann("Date"), "text"],
    [ann("ISODate"), "timestamptz"],
    [ann("ISODate"), "text"],
    [ann("ISOTime"), "timestamptz"],
    [ann("Vector"), "text"],     // a Vector prop must store as vector
    [ann("Vector"), "float8[]"],
    [ann("Uint8Array"), "text"],
    [ann("object", { isObjectLike: true }), "text"],
    [ann("object", { isObjectLike: true }), "float8"],
    [ARR("string"), "int4[]"],
    [ARR("UUID"), "text[]"],
    [ARR("number"), "text[]"],
    [ARR("number"), "uuid[]"],
    [ARR("bigint"), "int4[]"],
    [ARR("boolean"), "int4[]"],
    [ARR("Decimal"), "float8[]"],
  ];
  it.each(DENY)("denies %j + pgType %s", (a, pg) => {
    expect(() => assertPgTypeCompatible(a, pg, "p")).toThrow(/incompatible/);
  });
});

// ─── 2d. columnTypeWarnings — advisory authoring smells ───────────────────────

describe("columnTypeWarnings", () => {
  it("flags *_uuid columns that resolve to non-uuid", () => {
    const w = columnTypeWarnings("E", {
      ...hints({ sqlName: "doc_uuid", propertyKey: "doc_uuid", annotation: ann("string") }),
    }, "text");
    expect(w).toHaveLength(1);
    expect(w[0]!.kind).toBe("uuid-name");
  });

  it("an explicit pgType on *_uuid declares intent and silences the warning", () => {
    const w = columnTypeWarnings("E", {
      ...hints({ sqlName: "doc_uuid", propertyKey: "doc_uuid", explicitPgType: "text", annotation: ann("string") }),
    }, "text");
    expect(w).toEqual([]);
  });

  it("no uuid-name warning when the column resolves to uuid", () => {
    const w = columnTypeWarnings("E", {
      ...hints({ sqlName: "doc_uuid", propertyKey: "doc_uuid", annotation: ann("UUID") }),
    }, "uuid");
    expect(w).toEqual([]);
  });

  it("flags a pgType that restates the inferred default", () => {
    const w = columnTypeWarnings("E", {
      ...hints({ sqlName: "name", propertyKey: "name", explicitPgType: "text", annotation: ann("string") }),
    }, "text");
    expect(w).toHaveLength(1);
    expect(w[0]!.kind).toBe("redundant-pgType");
  });

  it("non-default explicit pgType is not redundant", () => {
    const w = columnTypeWarnings("E", {
      ...hints({ sqlName: "count", propertyKey: "count", explicitPgType: "int4", annotation: ann("number") }),
    }, "int4");
    expect(w).toEqual([]);
  });
});

// ─── 3. io — params in, hydration out ─────────────────────────────────────────

describe("type matrix — io honours entity meta", () => {
  const meta = getEntityPersistenceMeta(TypeMatrixEntity);
  const h = (col: string) => columnHintsFromMetaColumn(meta.columns[col]!);

  it("Decimal → plain numeric param; string → Decimal hydration; 'N.Nd' wire", () => {
    expect(jsValueToPgParam(dec("12.3400"), h("money"))).toBe("12.3400");
    const back = pgValueToJsValue("12.3400", h("money"));
    expect(back).toBeInstanceOf(Decimal);
    expect((back as Decimal).toString()).toBe("12.3400");
    expect(JSON.stringify(dec("1.5"))).toBe('"1.5d"');
    expect((pgValueToJsValue("1.5d", h("money")) as Decimal).toString()).toBe("1.5");
  });

  it("Vector → '[…]' literal param; literal → Vector hydration", () => {
    expect(jsValueToPgParam(Vector.fromNumbers([1, 2, 3]), h("emb3"))).toBe("[1,2,3]");
    // plain number[] params bind as the vector literal too (write path)
    expect(jsValueToPgParam([1, 2, 3], h("emb3"))).toBe("[1,2,3]");
    const back = pgValueToJsValue("[1,2,3]", h("emb3"));
    expect(back).toBeInstanceOf(Vector);
    expect([...(back as Vector)]).toEqual([1, 2, 3]);
  });

  it("ISODate is a STRING both ways — never a Date (no tz shift)", () => {
    expect(jsValueToPgParam("2026-03-15", h("day"))).toBe("2026-03-15");
    const back = pgValueToJsValue("2026-03-15", h("day"));
    expect(back).toBe("2026-03-15");
    expect(back).not.toBeInstanceOf(Date);
  });

  it("Date props pass Date through both ways (driver-native)", () => {
    const d = new Date("2026-03-15T10:00:00Z");
    expect(jsValueToPgParam(d, h("ts"))).toBe(d);
    expect(pgValueToJsValue(d, h("ts"))).toBe(d);
  });

  it("audit *_at columns hydrate ISO strings to Date", () => {
    const back = pgValueToJsValue("2026-03-15T10:00:00Z", h("created_at"));
    expect(back).toBeInstanceOf(Date);
    expect((back as Date).toISOString()).toBe("2026-03-15T10:00:00.000Z");
  });

  it("bigint, UUID, arrays pass through unchanged", () => {
    expect(pgValueToJsValue(42n, h("big"))).toBe(42n);
    const u = "550e8400-e29b-41d4-a716-446655440000";
    expect(pgValueToJsValue(u, h("uuid"))).toBe(u);
    expect(pgValueToJsValue(["a", "b"], h("tags"))).toEqual(["a", "b"]);
    expect(pgValueToJsValue([1n, 2n], h("ids"))).toEqual([1n, 2n]);
  });

  it("jsonb columns serialize objects; nested bigint → number", () => {
    const hj = { ...h("meta"), inferredPgType: "jsonb" };
    expect(jsValueToPgParam({ a: 1, b: 7n }, hj)).toBe('{"a":1,"b":7}');
    expect(pgValueToJsValue({ a: 1 }, hj)).toEqual({ a: 1 });
  });
});
