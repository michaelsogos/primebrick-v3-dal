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
    for (const k of ["binding_key", "expire_at", "switch_at", "revived_from", "revived_at", "revived_by"]) {
      expect(() => decl.schemas.createBody({ entity: { ...VALID, [k]: "x" } }), k).toThrow(/unknown field/);
    }
  });

  it("default_from is a create-only anchor key — instant-validated", () => {
    const out = decl.schemas.createBody({ entity: { ...VALID, default_from: "2026-11-26T00:00:00Z" } });
    expect(out.entity.default_from).toBeInstanceOf(Date);
    expect(() => decl.schemas.createBody({ entity: { ...VALID, default_from: "not-a-date" } })).toThrow(/default_from/);
  });

  it("revive_every requires a valid 'N unit' interval", () => {
    expect(() => decl.schemas.createBody({ entity: { ...VALID, revive_every: "soon" } })).toThrow(/N \(day\|week/);
    expect(() => decl.schemas.createBody({ entity: { ...VALID, revive_every: "1 year" } })).toThrow(/revive_slot/);
  });

  it("revive_every accepts an 'at <RFC3339>' pin — 'until' is axis-bound to grace", () => {
    const out = decl.schemas.createBody({
      entity: { ...PATTERN_SEZ, pattern: "ORD-{seq:5}/{yyyy}/{sez}", sez: "26", revive_every: "at 2027-06-16T00:00:00Z", revive_slot: "sez" },
    });
    expect(out.entity.revive_every).toBe("at 2027-06-16T00:00:00Z");
    // 'until' literal on the cadence axis → rejected
    expect(() => decl.schemas.createBody({
      entity: { ...PATTERN_SEZ, pattern: "ORD-{seq:5}/{yyyy}/{sez}", sez: "26", revive_every: "until 2027-06-16T00:00:00Z", revive_slot: "sez" },
    })).toThrow(/at <RFC3339>/);
    // ambiguous literal — no offset → rejected
    expect(() => decl.schemas.createBody({
      entity: { ...PATTERN_SEZ, pattern: "ORD-{seq:5}/{yyyy}/{sez}", sez: "26", revive_every: "at 2027-06-16", revive_slot: "sez" },
    })).toThrow(/RFC3339/);
    // 'at' on a period-free pattern — no grain to advance the sez by
    expect(() => decl.schemas.createBody({
      entity: { ...PATTERN_SEZ, sez: "26", revive_every: "at 2027-06-16T00:00:00Z", revive_slot: "sez" },
    })).toThrow(/sequence_revive_at_needs_period/);
  });

  it("revive_grace accepts 'N unit' and 'until <RFC3339>' — 'at' rejected", () => {
    const out = decl.schemas.createBody({
      entity: { ...PATTERN_SEZ, sez: "26", revive_every: "1 year", revive_slot: "sez", revive_grace: "until 2027-01-15T00:00:00Z" },
    });
    expect(out.entity.revive_grace).toBe("until 2027-01-15T00:00:00Z");
    expect(() => decl.schemas.createBody({
      entity: { ...PATTERN_SEZ, sez: "26", revive_every: "1 year", revive_slot: "sez", revive_grace: "at 2027-06-16T00:00:00Z" },
    })).toThrow(/until <RFC3339>/);
  });

  it("revive_slot must be a used sez slot the pattern declares", () => {
    // sez2 not in pattern → rejected (the core shape predicate's contract)
    expect(() => decl.schemas.createBody({
      entity: { ...PATTERN_SEZ, sez: "26", revive_every: "1 year", revive_slot: "sez2" },
    })).toThrow(/sequence_revive_slot_not_in_pattern/);
  });

  it("revive slot value must be row-owned and advanceable", () => {
    // slot declared but row doesn't own the value → nothing to advance
    expect(() => decl.schemas.createBody({
      entity: { ...PATTERN_SEZ, revive_every: "1 year", revive_slot: "sez" },
    })).toThrow(/sequence_revive_slot_value_required/);
    // row owns a non-advanceable label
    expect(() => decl.schemas.createBody({
      entity: { ...PATTERN_SEZ, sez: "URGENT", revive_every: "1 year", revive_slot: "sez" },
    })).toThrow(/sequence_revive_value_not_advancable/);
  });

  it("sez charset and pattern-slot coherence are enforced", () => {
    expect(() => decl.schemas.createBody({ entity: { ...PATTERN_SEZ, sez: "bad value!" } })).toThrow(/charset/);
    // sez supplied but pattern declares no {sez} → mis-keyed config rejected
    expect(() => decl.schemas.createBody({ entity: { ...VALID, sez: "26" } })).toThrow(/sequence_sez_not_in_pattern/);
  });

  it("update: revive_slot/default_from/sez* are immutable — rejected outright", () => {
    for (const k of ["revive_slot", "default_from", "sez", "sez2", "sez3"]) {
      expect(() => decl.schemas.updateBody({ entity: { [k]: "1 year", version: 1n } }), k).toThrow(/immutable/);
    }
  });

  it("update: revive_every/revive_grace editable — spec-validated both modes", () => {
    const out = decl.schemas.updateBody({ entity: { revive_every: "6 months", revive_grace: "10 days", version: 1n } });
    expect(out.entity).toMatchObject({ revive_every: "6 months", revive_grace: "10 days" });
    // instant literals accepted on their own axis
    const lit = decl.schemas.updateBody({ entity: { revive_every: "at 2027-06-16T00:00:00Z", revive_grace: "until 2027-08-01T00:00:00Z", version: 1n } });
    expect(lit.entity).toMatchObject({ revive_every: "at 2027-06-16T00:00:00Z", revive_grace: "until 2027-08-01T00:00:00Z" });
    // cross-axis keywords still rejected; NULL clears the axis (revive off)
    expect(() => decl.schemas.updateBody({ entity: { revive_every: "until 2027-01-01T00:00:00Z", version: 1n } })).toThrow();
    expect(() => decl.schemas.updateBody({ entity: { revive_grace: "later", version: 1n } })).toThrow();
    const off = decl.schemas.updateBody({ entity: { revive_every: null, version: 1n } });
    expect(off.entity.revive_every).toBeNull();
  });
});
