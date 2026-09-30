/**
 * list-filters — translateFilterConditions unit tests. Pure function (no
 * DB): QS-bracket conditions → FilterExpr groups with allowlist enforcement,
 * ILIKE wrap/escape, BETWEEN normalization, connector grouping.
 */
import "reflect-metadata";
import { describe, it, expect } from "vitest";

import { translateFilterConditions } from "../src/query/list-filters.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import type { FilterExpr } from "../src/query/dsl.js";

const ALLOWED = new Set(["name", "email", "description"]);

type GroupExpr = Extract<FilterExpr, { kind: "group" }>;
type LeafExpr = Extract<FilterExpr, { kind: "field_value" }>;

/** Unwrap the outer AND-group → inner condition group → leaves. */
function innerLeaves(exprs: FilterExpr[] | null): LeafExpr[] {
  const outer = exprs?.[0] as GroupExpr | undefined;
  const first = outer?.filters?.[0] as GroupExpr | LeafExpr | undefined;
  if (first && first.kind === "group") return first.filters as LeafExpr[];
  return (outer?.filters ?? []) as LeafExpr[];
}

describe("translateFilterConditions", () => {
  it("returns null for empty/undefined conditions", () => {
    expect(translateFilterConditions(SimpleTestEntity, undefined, { allowedFields: ALLOWED })).toBeNull();
    expect(translateFilterConditions(SimpleTestEntity, [], { allowedFields: ALLOWED })).toBeNull();
  });

  it("skips fields outside the allowlist and unknown ops (SQL-injection barrier)", () => {
    const exprs = translateFilterConditions(
      SimpleTestEntity,
      [
        { field: "name", op: "=", value: "a" },
        { field: "password_hash; DROP TABLE", op: "=", value: "x" },
        { field: "name", op: "DROP", value: "x" },
      ],
      { allowedFields: ALLOWED },
    );
    const leaves = innerLeaves(exprs);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.left.key).toBe("name");
  });

  it("LIKE/ILIKE without wildcard is wrapped %v%", () => {
    const exprs = translateFilterConditions(
      SimpleTestEntity,
      [{ field: "name", op: "ILIKE", value: "acme" }],
      { allowedFields: ALLOWED },
    );
    const leaves = innerLeaves(exprs);
    expect(leaves[0]!.op).toBe("ILIKE");
    expect(leaves[0]!.right).toBe("%acme%");
  });

  it("ILIKE keeps caller-provided wildcards and uses escapeIlike hook when given", () => {
    const withWild = translateFilterConditions(
      SimpleTestEntity,
      [{ field: "name", op: "ILIKE", value: "%acme" }],
      { allowedFields: ALLOWED },
    );
    expect(innerLeaves(withWild)[0]!.right).toBe("%acme");

    const escaped = translateFilterConditions(
      SimpleTestEntity,
      [{ field: "name", op: "ILIKE", value: "a%b" }],
      { allowedFields: ALLOWED, escapeIlike: (raw) => `ESC(${raw})` },
    );
    // value contains % → passed through (hook only fires on wildcard-free input)
    expect(innerLeaves(escaped)[0]!.right).toBe("a%b");

    const hooked = translateFilterConditions(
      SimpleTestEntity,
      [{ field: "name", op: "ILIKE", value: "plain" }],
      { allowedFields: ALLOWED, escapeIlike: (raw) => `ESC(${raw})` },
    );
    expect(innerLeaves(hooked)[0]!.right).toBe("ESC(plain)");
  });

  it("IN/NOT IN pass the array through", () => {
    const exprs = translateFilterConditions(
      SimpleTestEntity,
      [{ field: "name", op: "IN", value: ["a", "b"] }],
      { allowedFields: ALLOWED },
    );
    const leaves = innerLeaves(exprs);
    expect(leaves[0]!.op).toBe("IN");
    expect(leaves[0]!.right).toEqual(["a", "b"]);
  });

  it("BETWEEN: {start,end} → [start,end]; half-open or scalar → skipped", () => {
    const exprs = translateFilterConditions(
      SimpleTestEntity,
      [
        { field: "name", op: "BETWEEN", value: { start: 1, end: 5 } },
        { field: "name", op: "BETWEEN", value: { start: 1, end: null } },
        { field: "name", op: "BETWEEN", value: "scalar" },
      ],
      { allowedFields: ALLOWED },
    );
    const leaves = innerLeaves(exprs);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.right).toEqual([1, 5]);
  });

  it("multiple conditions are grouped under one connector (default AND, OR override)", () => {
    const andRes = translateFilterConditions(
      SimpleTestEntity,
      [
        { field: "name", op: "=", value: "a" },
        { field: "email", op: "=", value: "b" },
      ],
      { allowedFields: ALLOWED },
    );
    const outer = andRes![0] as GroupExpr;
    expect(outer.kind).toBe("group");
    const inner = outer.filters[0] as GroupExpr;
    expect(inner.kind).toBe("group");
    expect(inner.connector).toBe("AND");

    const orRes = translateFilterConditions(
      SimpleTestEntity,
      [
        { field: "name", op: "=", value: "a" },
        { field: "email", op: "=", value: "b" },
      ],
      { allowedFields: ALLOWED, connector: "OR" },
    );
    const innerOr = (orRes![0] as GroupExpr).filters[0] as GroupExpr;
    expect(innerOr.connector).toBe("OR");
  });

  it("validOps override narrows the operator allowlist", () => {
    const exprs = translateFilterConditions(
      SimpleTestEntity,
      [
        { field: "name", op: "ILIKE", value: "x" },
        { field: "name", op: "=", value: "y" },
      ],
      { allowedFields: ALLOWED, validOps: new Set(["="]) },
    );
    const leaves = innerLeaves(exprs);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.op).toBe("=");
  });
});
