/**
 * Type-parser registration for pg — centralized in the library so consumers
 * don't have to know about OIDs or coercion semantics.
 *
 * Contract (entity type table):
 * - INT8    → native JS `bigint`
 * - NUMERIC → `string` ALWAYS — no silent precision loss. Entity `Decimal`
 *             columns hydrate via `pgValueToJsValue`/`jsType`; ad-hoc
 *             queries get the lossless raw value.
 * - DATE    → `string` "YYYY-MM-DD" — a calendar date has no timezone;
 *             node-pg's `Date` parse uses LOCAL midnight and shifts the day
 *             on JSON round-trips in positive-offset zones. `ISODate` is a
 *             string by contract.
 * - TIMESTAMP/TIMESTAMPTZ → driver `Date` (unchanged).
 *
 * The parsers are global on the `pg` module, so registering once per process
 * is correct. The `typeParsersRegistered` guard makes this idempotent — safe
 * to call from multiple `Dal` instances (multi-DB case) or during HMR.
 */

import pg from "pg";

let typeParsersRegistered = false;

/**
 * Register the Primebrick type-parser contract on the global `pg` module.
 * Idempotent — safe to call multiple times; only registers on the first call.
 */
export function ensureTypeParsers(): void {
  if (typeParsersRegistered) return;

  // INT8 → native bigint (not string)
  pg.types.setTypeParser(pg.types.builtins.INT8, (val: string) => BigInt(val));

  // NUMERIC → string, always. `numeric` is arbitrary-precision; converting to
  // `number` silently rounds beyond 2^53 and loses fractional precision on
  // large values. Consumers hydrate `Decimal` where the column contract says so.
  pg.types.setTypeParser(pg.types.builtins.NUMERIC, (val: string) => val);

  // DATE → string "YYYY-MM-DD". node-pg's default `Date` conversion anchors
  // at LOCAL midnight, so a `date` column shifts a day on ISO round-trip in
  // UTC+ zones. Calendar dates are strings (`ISODate`), not `Date`.
  pg.types.setTypeParser(pg.types.builtins.DATE, (val: string) => val);

  typeParsersRegistered = true;
}

/**
 * Reset the registration guard. Intended for tests only — allows re-registration
 * after the pg module state has been manipulated by test code.
 */
export function _resetTypeParserGuard(): void {
  typeParsersRegistered = false;
}
