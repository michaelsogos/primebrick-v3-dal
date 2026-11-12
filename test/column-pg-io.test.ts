import { describe, it, expect } from "vitest";
import { jsValueToPgParam, pgValueToJsValue, type ColumnPgPersistenceHints } from "../src/meta/column-pg-io.js";

const jsonb: ColumnPgPersistenceHints = {
  sqlName: "payload",
  inferredPgType: "jsonb",
};

const timestamptz: ColumnPgPersistenceHints = {
  sqlName: "created_at",
  inferredPgType: "timestamptz",
  auditableType: "CREATED_AT",
};

describe("jsValueToPgParam — jsonb BigInt safety", () => {
  it("serializes nested BigInt values to Number instead of crashing", () => {
    const value = { detail: { measured_vram_bytes: 1044381696n, tags: ["a"] } };
    const out = jsValueToPgParam(value, jsonb);
    expect(typeof out).toBe("string");
    expect(JSON.parse(out as string)).toEqual({
      detail: { measured_vram_bytes: 1044381696, tags: ["a"] },
    });
  });

  it("serializes a top-level BigInt to Number", () => {
    expect(jsValueToPgParam(42n, jsonb)).toBe(42);
  });

  it("keeps ordinary objects unchanged in shape", () => {
    const value = { a: 1, b: "x", c: [1, 2] };
    expect(JSON.parse(jsValueToPgParam(value, jsonb) as string)).toEqual(value);
  });

  it("passes null/undefined through", () => {
    expect(jsValueToPgParam(null, jsonb)).toBeNull();
    expect(jsValueToPgParam(undefined, jsonb)).toBeUndefined();
  });
});

describe("jsValueToPgParam — non-jsonb behaviour preserved", () => {
  it("converts Date to YYYY-MM-DD for sql date columns", () => {
    const h = { sqlName: "day", inferredPgType: "date" };
    expect(jsValueToPgParam(new Date("2026-09-26T10:00:00Z"), h)).toBe("2026-09-26");
  });

  it("passes Date through for timestamptz", () => {
    const d = new Date("2026-09-26T10:00:00Z");
    expect(jsValueToPgParam(d, timestamptz)).toBe(d);
  });

  it("parses ISO strings on date-like columns", () => {
    const out = jsValueToPgParam("2026-09-26T10:00:00Z", timestamptz);
    expect(out).toBeInstanceOf(Date);
  });

  it("does not strip BigInt on non-jsonb columns", () => {
    const h = { sqlName: "big", inferredPgType: "bigint" };
    expect(jsValueToPgParam(7n, h)).toBe(7n);
  });
});

describe("pgValueToJsValue — class-ctor jsType revival (jsonb → instance)", () => {
  class Envelope {
    to = "";
    cc?: string[];
    upperTo() { return this.to.toUpperCase(); }
  }
  class WithFromJson {
    val = 0;
    static fromJson(v: unknown) {
      const o = new WithFromJson();
      o.val = typeof v === "object" && v !== null ? (v as { n?: number }).n ?? 0 : 0;
      return o;
    }
  }
  const envHints: ColumnPgPersistenceHints = {
    sqlName: "recipients",
    inferredPgType: "jsonb",
    jsType: Envelope,
  };

  it("revives a plain jsonb object to a real class instance (prototype graft)", () => {
    const out = pgValueToJsValue({ to: "a@b.c", cc: ["x@y.z"] }, envHints);
    expect(out).toBeInstanceOf(Envelope);
    expect((out as Envelope).to).toBe("a@b.c");
    expect((out as Envelope).upperTo()).toBe("A@B.C");
  });

  it("revives array elements element-wise", () => {
    const h = { sqlName: "rules", inferredPgType: "jsonb", jsType: Envelope };
    const out = pgValueToJsValue([{ to: "a" }, { to: "b" }], h) as Envelope[];
    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Envelope);
    expect(out[1].upperTo()).toBe("B");
  });

  it("honours cls.fromJson when the class exposes it", () => {
    const h = { sqlName: "cfg", inferredPgType: "jsonb", jsType: WithFromJson };
    const out = pgValueToJsValue({ n: 42 }, h);
    expect(out).toBeInstanceOf(WithFromJson);
    expect((out as WithFromJson).val).toBe(42);
  });

  it("passes an already-instantiated value through", () => {
    const inst = new Envelope();
    inst.to = "x";
    expect(pgValueToJsValue(inst, envHints)).toBe(inst);
  });

  it("null/undefined stay null/undefined", () => {
    expect(pgValueToJsValue(null, envHints)).toBeNull();
    expect(pgValueToJsValue(undefined, envHints)).toBeUndefined();
  });
});

describe("jsValueToPgParam — class instances serialize to jsonb", () => {
  class Envelope {
    to = "";
    upperTo() { return this.to.toUpperCase(); }
  }
  const envHints: ColumnPgPersistenceHints = {
    sqlName: "recipients",
    inferredPgType: "jsonb",
    jsType: Envelope,
  };

  it("serializes a class instance — own fields land in the JSON, methods don't", () => {
    const inst = new Envelope();
    inst.to = "a@b.c";
    const out = jsValueToPgParam(inst, envHints);
    expect(typeof out).toBe("string");
    const parsed = JSON.parse(out as string);
    expect(parsed).toEqual({ to: "a@b.c" });
    expect("upperTo" in parsed).toBe(false);
  });

  it("serializes an array of instances", () => {
    const a = new Envelope(); a.to = "a";
    const b = new Envelope(); b.to = "b";
    const out = JSON.parse(jsValueToPgParam([a, b], envHints) as string);
    expect(out).toEqual([{ to: "a" }, { to: "b" }]);
  });
});
