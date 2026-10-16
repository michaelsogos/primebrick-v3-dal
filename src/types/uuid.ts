/**
 * `UUID` — branded `string` for RFC 4122 UUID values.
 *
 * Compile-time only (zero runtime cost): a `UUID` IS assignable to `string`,
 * a plain `string` is NOT assignable to `UUID` — the compiler forces a guard
 * call (`toUUID`/`trustedUUID`) at trust boundaries.
 *
 * In entities, a `UUID`-typed property maps to the PostgreSQL `uuid` column
 * type automatically — no `pgType` needed.
 */

declare const uuidBrand: unique symbol;
export type UUID = string & { readonly [uuidBrand]: "UUID" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Type guard — validates RFC 4122 layout (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, hex). */
export function isUUID(v: unknown): v is UUID {
  return typeof v === "string" && UUID_RE.test(v);
}

/** Validating constructor — throws on malformed input. Use at system boundaries (request bodies, env, user input). */
export function toUUID(v: string): UUID {
  if (!isUUID(v)) throw new Error(`Invalid UUID value: ${String(v)}`);
  return v;
}

/** Zero-cost cast for trusted sources (DB rows, values already validated upstream). Named explicitly so reviews can spot it. */
export function trustedUUID(v: string): UUID {
  return v as UUID;
}
