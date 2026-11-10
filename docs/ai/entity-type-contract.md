# Devin Rule: Entity Type Contract

> Canonical body of `.devin/rules/entity-type-contract.md` — the rule file is a pointer to this page.

## Trigger
- Applies to ALL entity definitions, `@Column` usage, `pgType` declarations,
  guarded types (`UUID`/`ISODate`/`ISOTime`/`Vector`/`Decimal`), and any work
  in `src/meta/entity-ts-to-pg.ts`, `src/meta/entity-annotation-extract.ts`,
  `src/meta/column-pg-io.ts`, `src/types/`, or `test/type-matrix.test.ts`.

## The contract

Column types resolve **statically from the TS annotation** — never from the
property name, never from `design:type` (removed: transpiler-dependent).

There are **two cascades**, one per consumer:

- **Schema pipeline** (`primebrick-db check`, snapshot/patch generation —
  sees the real annotation via the TS compiler API):
  `explicit pgType` → `semantic pin` → `annotation` → `throw`
  (an unmappable type is never silently `text`).
- **Runtime** (`inferPgTypeFromEntityColumn` — annotation is erased at
  transpile, so decorator arguments are the only facts that survive):
  `explicit pgType` → `semantic pin` → `jsType` → `annotation` *(absent
  at runtime)* → `"text"` non-authoritative fallback.

Runtime-visible declaration channels, strongest first:

| Channel | Carried by | Pins |
|---|---|---|
| `explicitPgType` | `@Column({ pgType })` | the literal type |
| semantic pins | `@AuditableField`/`@DeletableField`/`@SynchronizableField` | contract-fixed |
| `@Key` identity | `@Key()` + `keyGenerated:"identity"` (default) | `int8` — an identity surrogate IS int8 by construction |
| `jsType` | `@Column({ jsType })` | `instant`→timestamptz, `decimal`→numeric, `vector`→vector, `bigint`→int8 |
| `annotation` | `prop?: Type` | erased at transpile — static pipeline only |

**A prop whose annotation maps to non-text storage MUST carry a
runtime-visible declaration** (`jsType`, `pgType`, semantic pin, or
non-manual `@Key`) — `entity-type-declared` lint enforces it. Without one
the column silently resolves `pg_type:"text"`.

## What the declaration feeds (the cascade)

One declaration on the entity prop drives every downstream consumer:

- **Schema patches** — annotation+pin resolution → `snapshot-entities.json`
  → `db:meta:compare` DDL patches.
- **Served meta** — `inferredPgType` → `pg_type` + derived `type` +
  `searchable`/`filterable`/`sortable` defaults → FE widget choice
  (datetime picker, numeric input, boolean switch, …) and label defaults.
- **Query rendering** — `likeNeedsTextCast` reads `inferredPgType`: a
  non-text column gets `CAST(col AS text)` under ILIKE; a `"text"` lie
  skips the cast → **42883** on `?search=` (uuid/timestamptz/int8/jsonb
  have no `~~*` operator).
- **ext-json / JSON hydration** — `jsType` drives `pgValueToJsValue`
  revive for JSON round-trips and deferred-transaction results (plain DB
  reads already come back typed via the pg OID parsers: INT8→bigint,
  NUMERIC→Decimal…).
- **Pg param conversion** — `jsValueToPgParam` converts entity values by
  codec pins + value shape (`Date`→ISO passthrough, `Decimal`→string,
  jsonb→JSON.stringify with bigint→number coercion).
- **Entity catalog / docs KB** — the decoration is the single source the
  catalog and generated docs derive from.

## Illegal

- A non-string annotation **without** a runtime-visible declaration —
  silent `pg_type:"text"` drift. (`entity-type-declared` lint)
- `pgType` restating what annotation/jsType/pin already infers —
  `redundant-pgType` warning; declare the fact once.
- Prop-name inference — `id`, `*_uuid`, `*_at` carry NO type meaning.
- `design:type`/reflect-metadata — transpiler-dependent, removed.
- Runtime dependence on `snapshot-entities.json` or any generated file —
  **the code must carry the fact**.
- `pgType` overriding a semantic pin's protected storage.
- Non-canonical `pgType` aliases (`"integer"`, `"timestamp with time zone"`)
  — compile errors; use canonical names.
- `number` + `pgType:"numeric"` — `numeric` hydrates `Decimal`, a `number`
  prop would lie (hard error).
- Declaring `nullable: true` on a non-optional prop / omitting it on an
  optional one. (`entity-nullable-explicit` lint)

## Things to know

- **Semantic pins beat `jsType` beat annotation** — authored hints cannot
  override system-column contracts.
- `@Key()` on `id!: bigint` needs **no** `jsType` — the identity pin
  covers all surrogate keys for free.
- `jsType` is the runtime counterpart of the erased annotation — the prop
  declares "my JS value IS an instant/decimal/vector/bigint" and the
  pg-type mapping lives in ONE place (`JS_TYPE_PINS`).
- `pgType` lies hurt twice: wrong `pg_type` in served meta AND missing
  ILIKE cast → runtime 42883, not just cosmetic.
- `date`/`time`/`timetz` columns hydrate as `ISODate`/`ISOTime` strings —
  never `Date` — by contract; `timestamptz`/`timestamp` carry `Date`.

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
- **`jsType` on `Decimal`/`Vector`/`bigint`/non-audit `Date` props** —
  runtime hydration marker AND storage pin (`bigint`→`int8`); the erased
  annotation's runtime counterpart.
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
