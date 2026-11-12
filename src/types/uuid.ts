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

import { getRandomValues } from "node:crypto";

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

// RFC 4122 uuid with version nibble 7 (3rd group `7xxx`) and variant bits
// `10xx` (4th group `8|9|a|bxxx`) — the canonical uuid-PK form.
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Type guard — RFC 4122 layout AND version 7 + RFC variant. */
export function isUuidV7(v: unknown): v is UUID {
  return typeof v === "string" && UUID_V7_RE.test(v);
}

/** Validating constructor for the uuid-PK boundary — throws on malformed or non-v7 input. */
export function toUuidV7(v: string): UUID {
  if (!isUuidV7(v)) throw new Error(`Expected a uuid v7 value: ${String(v)}`);
  return v;
}

/**
 * App-side uuid v7 generator (RFC 9562 §5.7): 48-bit ms timestamp + version +
 * 12-bit rand_a + variant + 62-bit rand_b. Same layout PostgreSQL `uuidv7()`
 * produces — app-injected uuids pass the v7 boundary guard.
 */
export function newUuidV7(): UUID {
  const rand = getRandomValues(new Uint8Array(10));
  let randA = BigInt((rand[0]! << 8) | rand[1]!) & 0xfffn;
  let randB = 0n;
  for (let i = 2; i < 10; i++) randB = (randB << 8n) | BigInt(rand[i]!);
  randB &= (1n << 62n) - 1n;
  const ts = BigInt(Date.now());
  const uuid =
    (ts >> 16n).toString(16).padStart(8, "0") + "-" +
    (ts & 0xffffn).toString(16).padStart(4, "0") + "-" +
    (0x7000n | randA).toString(16).padStart(4, "0") + "-" +
    (0x8000n | (randB >> 48n)).toString(16).padStart(4, "0") + "-" +
    (randB & 0xffffffffffffn).toString(16).padStart(12, "0");
  return trustedUUID(uuid);
}

/** Zero-cost cast for trusted sources (DB rows, values already validated upstream). Named explicitly so reviews can spot it. */
export function trustedUUID(v: string): UUID {
  return v as UUID;
}
