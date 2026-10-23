# Devin Rule: Entity Type Contract

## Trigger
- Applies to ALL entity definitions, `@Column` usage, `pgType` declarations,
  guarded types (`UUID`/`ISODate`/`ISOTime`/`Vector`/`Decimal`), and any work
  in `src/meta/entity-ts-to-pg.ts`, `src/meta/entity-annotation-extract.ts`,
  `src/meta/column-pg-io.ts`, `src/types/`, or `test/type-matrix.test.ts`.

## Canonical doc
**`docs/ai/entity-type-contract.md` — read it before acting.** This file is a
pointer; the normative text lives in the canonical doc.

## Enforcement
- Follow the normative body in the canonical doc — it is the contract; this file is only its trigger.
