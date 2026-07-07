/**
 * Type-parser registration for pg — centralized in the library so consumers
 * don't have to know about INT8_OID / NUMERIC coercion.
 *
 * - INT8  → native JS `bigint` (not string)
 * - NUMERIC → `number` when safe, `string` when precision overflows Number.MAX_SAFE_INTEGER
 *
 * The parsers are global on the `pg` module, so registering once per process
 * is correct. The `typeParsersRegistered` guard makes this idempotent — safe
 * to call from multiple `Dal` instances (multi-DB case) or during HMR.
 */

import pg from "pg";

let typeParsersRegistered = false;

/**
 * Register INT8 and NUMERIC type parsers on the global `pg` module.
 * Idempotent — safe to call multiple times; only registers on the first call.
 */
export function ensureTypeParsers(): void {
  if (typeParsersRegistered) return;

  // INT8 → native bigint (not string)
  pg.types.setTypeParser(pg.types.builtins.INT8, (val: string) => BigInt(val));

  // NUMERIC → number when safe, string when precision overflows MAX_SAFE_INTEGER
  pg.types.setTypeParser(pg.types.builtins.NUMERIC, (val: string) => {
    const num = Number(val);
    if (!val.includes(".") && Math.abs(num) > Number.MAX_SAFE_INTEGER) return val;
    return num;
  });

  typeParsersRegistered = true;
}

/**
 * Reset the registration guard. Intended for tests only — allows re-registration
 * after the pg module state has been manipulated by test code.
 */
export function _resetTypeParserGuard(): void {
  typeParsersRegistered = false;
}
