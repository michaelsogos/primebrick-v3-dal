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

const decl = builtinSequenceEntityDecl({ actor: () => "seq-validator-test", schemas: ["crm"] }) as {
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

describe("sequence write validator — revive contract", () => {
  const REVIVING = { ...VALID, sez: "26", revive_every: "1 year", revive_slot: "sez" };
  const PATTERN_SEZ = { ...VALID, pattern: "ORD-{seq:5}/{sez}" };

  it("reviving row passes validation — revive fields are create-time keys", () => {
    const out = decl.schemas.createBody({ entity: { ...PATTERN_SEZ, ...{ sez: "26", revive_every: "1 year", revive_slot: "sez" } } });
    expect(out.entity).toMatchObject({ sez: "26", revive_every: "1 year", revive_slot: "sez" });
  });

  it("system-owned columns are never write keys — construction gate", () => {
    for (const k of ["binding_key", "expire_at", "switch_at", "default_from", "revived_from", "revived_at", "revived_by"]) {
      expect(() => decl.schemas.createBody({ entity: { ...VALID, [k]: "x" } }), k).toThrow(/unknown field/);
    }
  });

  it("revive_every requires a valid 'N unit' interval", () => {
    expect(() => decl.schemas.createBody({ entity: { ...VALID, revive_every: "soon" } })).toThrow(/N \(day\|week/);
    expect(() => decl.schemas.createBody({ entity: { ...VALID, revive_every: "1 year" } })).toThrow(/revive_slot/);
  });

  it("revive_slot must be a used sez slot the pattern declares", () => {
    // sez2 not in pattern → rejected
    expect(() => decl.schemas.createBody({
      entity: { ...PATTERN_SEZ, sez: "26", revive_every: "1 year", revive_slot: "sez2" },
    })).toThrow(/no \{sez2\}/);
  });

  it("revive slot value must be row-owned and advanceable", () => {
    // slot declared but row doesn't own the value → nothing to advance
    expect(() => decl.schemas.createBody({
      entity: { ...PATTERN_SEZ, revive_every: "1 year", revive_slot: "sez" },
    })).toThrow(/must own the revive slot/);
    // row owns a non-advanceable label
    expect(() => decl.schemas.createBody({
      entity: { ...PATTERN_SEZ, sez: "URGENT", revive_every: "1 year", revive_slot: "sez" },
    })).toThrow(/cannot be advanced/);
  });

  it("sez charset and pattern-slot coherence are enforced", () => {
    expect(() => decl.schemas.createBody({ entity: { ...PATTERN_SEZ, sez: "bad value!" } })).toThrow(/charset/);
    // sez supplied but pattern declares no {sez} → mis-keyed config rejected
    expect(() => decl.schemas.createBody({ entity: { ...VALID, sez: "26" } })).toThrow(/no \{sez\} token/);
  });

  it("update: revive_every/revive_slot are immutable — rejected outright", () => {
    for (const k of ["revive_every", "revive_slot"]) {
      expect(() => decl.schemas.updateBody({ entity: { [k]: "1 year", version: 1n } }), k).toThrow(/immutable/);
    }
  });

  it("update: revive_grace stays editable, validated as 'N unit'", () => {
    const out = decl.schemas.updateBody({ entity: { revive_grace: "10 days", version: 1n } });
    expect(out.entity).toMatchObject({ revive_grace: "10 days" });
    expect(() => decl.schemas.updateBody({ entity: { revive_grace: "later", version: 1n } })).toThrow();
  });
});
