import { describe, it, expect } from "vitest";
import { calculateDelta } from "../src/audit/delta-calculator.js";

describe("calculateDelta — wire-decoded BigInt safety", () => {
  it("does not crash on a bigint nested inside a jsonb object value", () => {
    // extJsonParse turns every wire integer into native bigint — an object
    // field (endpoints/page_props/layout) can carry `2n` at ANY depth. The
    // JSON.stringify equality probe must not throw on it.
    const oldEntity = { endpoints: { nav: { fields: [{ key: "name" }] } } };
    const newEntity = {
      endpoints: { nav: { fields: [{ key: "name", span: 2n }] } },
    };
    const delta = calculateDelta(oldEntity, newEntity);
    expect(delta.endpoints).toBeDefined();
    const d = delta.endpoints as { old: unknown; new: unknown };
    expect(JSON.stringify(d.new)).toContain('"span":2');
  });

  it("normalizes bigint inside arrays at any depth", () => {
    const delta = calculateDelta(
      { payload: { list: [1n] } },
      { payload: { list: [1n, { span: 2n }] } },
    );
    const d = delta.payload as { new: { list: unknown[] } };
    expect(d.new.list[1]).toEqual({ span: 2 });
    expect(() => JSON.stringify(d.new)).not.toThrow();
  });

  it("keeps scalar bigint behavior (safe range → number)", () => {
    const delta = calculateDelta({ gen: 1n }, { gen: 2n });
    expect(delta.gen).toEqual({ old: 1, new: 2 });
  });

  it("treats identical deeply-bigint values as unchanged", () => {
    const delta = calculateDelta(
      { endpoints: { span: 2n } },
      { endpoints: { span: 2n } },
    );
    expect(delta.endpoints).toBeUndefined();
  });

  it("leaves class instances untouched (Date passthrough)", () => {
    const d = new Date("2026-01-01");
    const delta = calculateDelta({ at: null }, { at: d });
    expect((delta.at as { new: unknown }).new).toBe(d);
  });
});
