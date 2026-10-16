# Devin Rule: Entity Type Contract

## Trigger
- Applies to ALL entity definitions, `@Column` usage, `pgType` declarations,
  guarded types (`UUID`/`ISODate`/`ISOTime`/`Vector`/`Decimal`), and any work
  in `src/meta/entity-ts-to-pg.ts`, `src/meta/entity-annotation-extract.ts`,
  `src/meta/column-pg-io.ts`, `src/types/`, or `test/type-matrix.test.ts`.

## The contract

Column types resolve **statically from the TS annotation** — never from the
property name, never from `design:type` (removed: transpiler-dependent).
Resolution order: explicit `pgType` → semantic decorator pin → annotation →
`throw` (an unmappable type is never silently `text`).

Architectural defaults (locked by the project owner):

- **integers → `bigint` → `int8`**. `number` + `int4`/`int2` only when the
  domain bounds the value under 32 bits — a deliberate narrowing decision.
- **reals → `number` → `float8`**. `number` + `numeric` is a hard error
  (`numeric` hydrates as `Decimal`, a `number` prop would lie).
- **`Decimal` only for financial/mandatory-precision math** — not config.
- **`uuid`-holding columns → `UUID`** guarded type, FK or not. `string` on a
  `uuid`/`*_uuid` column triggers the `uuid-name` warning unless an explicit
  `pgType` declares intent (`pgType:"text"` = deliberate loose reference).
- **Never spell the default** — an explicit `pgType` equal to what the
  annotation infers is a `redundant-pgType` warning.
- **`date`/`time` columns are `ISODate`/`ISOTime` strings, never `Date`** —
  a calendar date has no timezone. `timestamptz`/`timestamp` carry `Date`.
- **`length` → `varchar(N)`/`vector(N)`; `precision`/`scale` → `numeric(p,s)`**
  — modifiers are options, never strings inside `pgType`.
- **`jsType` on `Decimal`/`Vector`/non-audit `Date` props** — runtime
  hydration marker for JSON/deferred-transaction round-trips.
- **nullability is declared, not inferred** — `NOT NULL` default; nullable
  columns say `@Column({ nullable: true })`.

## New column types — ASK FIRST

Adding a row to the mapping table (new annotation family, new `PgColumnType`,
new guarded type) is a **contract decision** — storage, runtime hydration,
wire format, and lint rules all have to be designed together. **Discuss with
the project owner before creating a new type.** The mapping table is
`src/meta/entity-ts-to-pg.ts`, the closed union is
`src/types/pg-column-type.ts`, and the canonical pin test is
`test/type-matrix.test.ts` + `test/entities/type-matrix-entity.ts` (extend
both when a type is added).

## Verification

- `test/type-matrix.test.ts` pins every cell of the matrix — it must stay
  exhaustive when the contract changes.
- `primebrick-db check` enforces the annotation↔pgType whitelist (hard error)
  and prints `uuid-name`/`redundant-pgType` warnings on real registries.
- Runtime io (`column-pg-io.ts`) is driven by `jsType`/value shape/semantic
  pins — runtime meta deliberately cannot see annotations.
