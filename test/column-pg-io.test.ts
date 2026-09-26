import { describe, it, expect } from "vitest";
import { jsValueToPgParam, type ColumnPgPersistenceHints } from "../src/meta/column-pg-io.js";

const jsonb: ColumnPgPersistenceHints = {
  sqlName: "payload",
  inferredPgType: "jsonb",
};

const timestamptz: ColumnPgPersistenceHints = {
  sqlName: "created_at",
  inferredPgType: "timestamptz",
  tsDesignTypeCtorName: "Date",
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
    const h = { sqlName: "day", inferredPgType: "date", tsDesignTypeCtorName: "Date" };
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
