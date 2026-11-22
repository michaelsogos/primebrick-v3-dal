import { describe, it, expect } from "vitest";
import "reflect-metadata";

import { builtinSequenceEntityDecl } from "../src/builtin/sequence-decl.js";

/**
 * Sequence write validator — the perimeter contract around DB DEFAULTs.
 * `step`/`start` carry `defaultSql:"1"`:
 *
 *   - OMITTED  → stays out of the validated payload → INSERT omits the
 *                column → the DB applies its DEFAULT 1;
 *   - PROVIDED → validated strictly on the perimeter: 0n and non-numeric
 *                are rejected, negatives are legal (decrementing
 *                sequences), valid positives pass.
 *
 * The validator enforces the input perimeter — it never invents or
 * replaces the DB default (no disambiguation).
 */

process.env.DATABASE_SCHEMA ??= "crm";

const decl = builtinSequenceEntityDecl({ actor: () => "seq-validator-test" }) as {
  schemas: {
    createBody: (b: unknown) => { entity: Record<string, unknown> };
    updateBody: (b: unknown) => { entity: Record<string, unknown> };
  };
};

const VALID = { name: "orders", pattern: "ORD-{seq:5}" };

describe("sequence write validator — DB-default semantics on step/start", () => {
  it("omitted step/start stay OUT of the create payload (DB applies DEFAULT 1)", () => {
    const out = decl.schemas.createBody({ entity: { ...VALID } });
    expect(out.entity).toMatchObject(VALID);
    expect(out.entity).not.toHaveProperty("step");
    expect(out.entity).not.toHaveProperty("start");
  });

  it("provided step/start pass through validated and typed", () => {
    const out = decl.schemas.createBody({ entity: { ...VALID, step: 5n, start: 100n } });
    expect(out.entity).toMatchObject({ step: 5n, start: 100n });
  });

  it("step 0n is rejected — a provided value is perimeter-validated", () => {
    expect(() => decl.schemas.createBody({ entity: { ...VALID, step: 0n } })).toThrow(/non-zero|step/i);
  });

  it("negative step is legal — decrementing sequences are a valid use", () => {
    const out = decl.schemas.createBody({ entity: { ...VALID, step: -1n, start: 100n } });
    expect(out.entity).toMatchObject({ step: -1n });
  });

  it("non-numeric step is rejected", () => {
    expect(() => decl.schemas.createBody({ entity: { ...VALID, step: "abc" } })).toThrow();
    expect(() => decl.schemas.createBody({ entity: { ...VALID, step: NaN } })).toThrow();
  });

  it("partial update: omitted step stays untouched, provided 0n still rejected", () => {
    const out = decl.schemas.updateBody({ entity: { name: "x", version: 1n } });
    expect(out.entity).not.toHaveProperty("step");
    expect(() => decl.schemas.updateBody({ entity: { step: 0n, version: 1n } })).toThrow(/non-zero|step/i);
  });
});
