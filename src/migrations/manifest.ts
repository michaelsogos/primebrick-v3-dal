// standards-exempt-file: ext-json — MANIFEST.json/keys.json are canonical plain-JSON signed artifacts; ext-json markers would break signature stability (dal-pg has no @primebrick/sdk dependency)
/**
 * Patch provenance: db-meta/MANIFEST.json + db-meta/keys.json.
 *
 * MANIFEST.json:
 *   { version, key_id, issued_at, patches: { "<patch_name>": "<sha256>" }, signature }
 *   signature = ed25519 over the canonical JSON of everything except `signature`.
 *
 * keys.json (committed keyring — adding a key IS the trust decision, code-reviewed):
 *   [{ key_id, algo: "ed25519", public_key: "<base64 spki>", trust: "release" | "dev" }]
 *
 * Threat model: a .sql file dropped on disk by an exploit is refused — it is not
 * in the manifest; a tampered patch fails sha; a rewritten manifest fails the
 * signature; forging a signature needs the private key, which never lives on a
 * runtime machine (CI signs with the release key; devs sign with a dev key).
 */

import { createPublicKey, createPrivateKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_FILENAME = "MANIFEST.json";
export const KEYS_FILENAME = "keys.json";

export type TrustedKey = {
  key_id: string;
  algo: "ed25519";
  /** base64 SPKI public key */
  public_key: string;
  trust: "release" | "dev";
};

export type PatchManifest = {
  version: 1;
  key_id: string;
  issued_at: string;
  patches: Record<string, string>;
  signature: string;
};

export class ManifestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ManifestError";
  }
}

/** Stable JSON: object keys sorted recursively so signatures are deterministic. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export function loadKeyring(keysPath: string): TrustedKey[] {
  if (!existsSync(keysPath)) return [];
  const raw = JSON.parse(readFileSync(keysPath, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new ManifestError("keys_invalid", `${keysPath}: expected a JSON array`);
  return raw as TrustedKey[];
}

export function loadManifest(manifestPath: string): PatchManifest | null {
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, "utf8")) as PatchManifest;
}

/** Verify manifest signature against the keyring (filtered by allowed trust levels). */
export function verifyManifest(
  manifest: PatchManifest,
  keyring: TrustedKey[],
  allowedTrust: readonly ("release" | "dev")[]
): TrustedKey {
  const { signature, ...unsigned } = manifest;
  const key = keyring.find(
    (k) => k.key_id === manifest.key_id && allowedTrust.includes(k.trust)
  );
  if (!key) {
    throw new ManifestError(
      "manifest_untrusted_key",
      `MANIFEST signed by '${manifest.key_id}' — not in trusted keyring (allowed trust: ${allowedTrust.join(",")})`
    );
  }
  const pub = createPublicKey({ key: Buffer.from(key.public_key, "base64"), format: "der", type: "spki" });
  const ok = verify(null, Buffer.from(canonicalJson(unsigned)), pub, Buffer.from(signature, "base64"));
  if (!ok) throw new ManifestError("manifest_bad_signature", "MANIFEST.json signature verification failed");
  return key;
}

/** Sign a manifest body (entries already updated) with a PEM/DER private key. */
export function signManifest(
  manifest: Omit<PatchManifest, "signature">,
  privateKeyB64: string
): PatchManifest {
  const priv = createPrivateKey({ key: Buffer.from(privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  const signature = sign(null, Buffer.from(canonicalJson(manifest)), priv);
  return { ...manifest, signature: signature.toString("base64") };
}

/** Resolve manifest + keyring paths for a service's db-meta dir. */
export function manifestPaths(dbMetaDir: string): { manifestPath: string; keysPath: string } {
  return {
    manifestPath: join(dbMetaDir, MANIFEST_FILENAME),
    keysPath: join(dbMetaDir, KEYS_FILENAME),
  };
}

/** Write manifest (used by compare/sign tooling). */
export function writeManifest(manifestPath: string, manifest: PatchManifest): void {
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
