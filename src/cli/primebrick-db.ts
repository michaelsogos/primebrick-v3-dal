#!/usr/bin/env node
// standards-exempt-file: ext-json — CLI dev tool: prints/writes plain-JSON output and db-meta artifacts (dal-pg has no @primebrick/sdk dependency)
/**
 * primebrick-db — one-shot CLI over the dal-pg migration engine + schema-diff.
 *
 * Bun-first (works under `bun run` / `bun x`; node via tsx for consumers that
 * haven't migrated yet). Thin wrapper — all logic lives in src/migrations and
 * src/schema-diff.
 *
 * Commands:
 *   primebrick-db compare --registry <module.ts> --url <pg-url> [--out db-meta]
 *       entity-snapshot vs catalog → snapshots JSON + unsigned .sql patch +
 *       refreshed (unsigned) MANIFEST.json entries
 *   primebrick-db apply   --schema <s> --url <pg-url> --patches <dir>
 *       run the engine once (same code path as service boot)
 *   primebrick-db check   --registry <module.ts> --url <pg-url>
 *       drift gate — exit 1 when entity intent is not fully applied
 *   primebrick-db status  --schema <s> --url <pg-url>
 *       print the <schema>.primebrick_database_patches registry
 *   primebrick-db sign    --db-meta <dir> --key <b64|@file> --key-id <id>
 *       re-sign MANIFEST.json (dev key locally, release key only in CI)
 *   primebrick-db keygen  --key-id <id> --trust <release|dev> [--out db-meta]
 *       generate an ed25519 keypair; pubkey goes to keys.json, private key
 *       is printed ONCE (dev: keep in workspace temp; release: CI secret)
 *
 * Patch generation / application NEVER happens via git hooks in prod and
 * NEVER ships in env vars — mode is read from <schema>.config_entries.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { Pool } from "pg";
import {
  buildDatabaseSnapshot,
  buildEntitySnapshot,
  buildPatchFilename,
  buildSqlPatchFromMetaDiff,
  compareSnapshots,
  patchNameFromFilename,
  sha256Hex,
  type SchemaSnapshot,
} from "../schema-diff/index.js";
import {
  checkDrift,
  isDriftClean,
  registryStatus,
  runMigrations,
  signManifest,
  writeManifest,
  loadManifest,
  loadKeyring,
  verifyManifest,
  canonicalJson,
  manifestPaths,
  MANIFEST_FILENAME,
  KEYS_FILENAME,
  type PatchManifest,
  type TrustedKey,
} from "../migrations/index.js";
import { getEntityPersistenceMeta, type EntityClass } from "../meta/entity-meta.js";
import { extractEntityAnnotations, type EntityAnnotationMap } from "../meta/entity-annotation-extract.js";
import { collectEntityTypeWarnings } from "../schema-diff/build-entity-snapshot.js";

/**
 * Static annotation map for the registry — deterministic entity types under
 * every runtime (tsc/tsx/bun identical, no `design:type` dependence).
 * Extraction failure is a hard error: guessing would reintroduce the
 * silent-`text` failure mode this contract exists to remove.
 */
async function loadAnnotations(registryPath: string): Promise<EntityAnnotationMap> {
  const map = await extractEntityAnnotations(resolve(registryPath));
  if (map.classes.size === 0) {
    console.warn("annotation-extract: no classes found — check --registry path");
  }
  return map;
}

/**
 * Advisory authoring warnings (`*_uuid` resolving to non-uuid, redundant
 * `pgType`). Printed to stderr; they never flip the exit code — they are the
 * review surface the name-inference removal replaced.
 */
function printEntityTypeWarnings(registry: readonly EntityClass[], annotations: EntityAnnotationMap): void {
  for (const w of collectEntityTypeWarnings(registry, annotations)) {
    console.warn(`[${w.kind}] ${w.message}`);
  }
}

// ─── arg parsing (deliberately dependency-free) ─────────────────────────────

function parseArgs(argv: string[]): { cmd: string | undefined; flags: Record<string, string> } {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = rest[i + 1];
        if (next && !next.startsWith("--")) flags[a.slice(2)] = next, i++;
        else flags[a.slice(2)] = "true";
      }
    }
  }
  return { cmd, flags };
}

function need(flags: Record<string, string>, name: string): string {
  const v = flags[name] ?? process.env[name.toUpperCase().replace(/-/g, "_")];
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
}

const consoleLogger = {
  error: (m: string, meta?: Record<string, unknown>) =>
    console.error(`[error] ${m}`, meta ? JSON.stringify(meta) : ""),
  warn: (m: string, meta?: Record<string, unknown>) =>
    console.warn(`[warn] ${m}`, meta ? JSON.stringify(meta) : ""),
  info: (m: string, meta?: Record<string, unknown>) =>
    console.log(`[info] ${m}`, meta ? JSON.stringify(meta) : ""),
};

async function loadRegistry(modulePath: string): Promise<readonly EntityClass[]> {
  const abs = resolve(modulePath);
  // pathToFileURL is required under Node/tsx on Windows — a bare `D:\…` path
  // is not a valid ESM specifier. Bun accepts it too, so this stays portable.
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  const reg = (mod.ENTITY_REGISTRY ?? mod.default ?? mod.registry) as
    | readonly EntityClass[]
    | undefined;
  if (!Array.isArray(reg)) {
    throw new Error(
      `${abs} must export ENTITY_REGISTRY (array of @Entity classes) — got ${Object.keys(mod).join(", ")}`,
    );
  }
  return reg;
}

// ─── commands ────────────────────────────────────────────────────────────────

async function cmdCompare(flags: Record<string, string>): Promise<void> {
  const registryPath = need(flags, "registry");
  const registry = await loadRegistry(registryPath);
  const annotations = await loadAnnotations(registryPath);
  const url = need(flags, "url");
  const outDir = resolve(flags["out"] ?? "db-meta");
  const patchesDir = join(outDir, "patches");
  mkdirSync(patchesDir, { recursive: true });

  const entitySnap = buildEntitySnapshot(registry, { annotations });
  printEntityTypeWarnings(registry, annotations);
  const tables = registry.map((c) => {
    const m = getEntityPersistenceMeta(c);
    return { schema: m.tableSchema, name: m.tableName };
  });
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const dbSnap = await buildDatabaseSnapshot(pool, tables);
    const diff = compareSnapshots(entitySnap, dbSnap);
    const sql = buildSqlPatchFromMetaDiff(entitySnap, diff);

    writeFileSync(join(outDir, "snapshot-entities.json"), JSON.stringify(entitySnap, null, 2));
    writeFileSync(join(outDir, "snapshot-database.json"), JSON.stringify(dbSnap, null, 2));
    writeFileSync(join(outDir, "diff-entities-vs-database.json"), JSON.stringify(diff, null, 2));

    const noop =
      diff.onlyInEntityTables.length === 0 &&
      Object.values(diff.tables).every(
        (t) =>
          !t.onlyInEntityColumns.length &&
          !t.likelyRenames.length &&
          !t.typeMismatches.length &&
          !t.nullabilityMismatches.length &&
          !(t.onlyInEntityIndexes?.length) &&
          !(t.onlyInEntityForeignKeys?.length),
      );

    if (!noop) {
      const filename = buildPatchFilename(diff);
      const patchName = patchNameFromFilename(filename);
      writeFileSync(join(patchesDir, filename), sql);
      console.log(`patch written: ${join(patchesDir, filename)}`);

      // Refresh the (unsigned) manifest entries — `primebrick-db sign` seals it.
      const { manifestPath } = manifestPaths(outDir);
      const existing = loadManifest(manifestPath);
      const patches = { ...(existing?.patches ?? {}), [patchName]: sha256Hex(sql) };
      const unsigned: Omit<PatchManifest, "signature"> = {
        version: 1,
        key_id: existing?.key_id ?? "unsigned",
        issued_at: new Date().toISOString(),
        patches,
      };
      // drop entries for patch files that no longer exist
      const onDisk = new Set(
        readdirSync(patchesDir)
          .filter((f) => f.endsWith(".sql"))
          .map(patchNameFromFilename),
      );
      for (const k of Object.keys(patches)) if (!onDisk.has(k)) delete patches[k];
      writeManifest(manifestPath, { ...unsigned, signature: "" } as PatchManifest);
      console.warn(`MANIFEST.json refreshed (UNSIGNED) — run \`primebrick-db sign\` to seal it`);
    } else {
      console.log("no drift — no patch written");
    }

    if (diff.renameHeuristicUserReviewRequired) {
      console.warn("renameHeuristicUserReviewRequired — review likelyRenames before applying");
    }
  } finally {
    await pool.end();
  }
}

async function cmdApply(flags: Record<string, string>): Promise<void> {
  const url = need(flags, "url");
  const schema = need(flags, "schema");
  const patchesDir = resolve(flags["patches"] ?? join("db-meta", "patches"));
  const trust = (flags["trust"] ?? "release").split(",") as ("release" | "dev")[];

  const pool = new Pool({ connectionString: url, max: 4 });
  try {
    const result = await runMigrations({
      pool,
      schema,
      patchesDir,
      allowedTrust: trust,
      actor: `cli:${process.pid}`,
      logger: consoleLogger,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.degraded || result.failed.length || result.securityEvents.length) {
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

async function cmdCheck(flags: Record<string, string>): Promise<void> {
  const registryPath = need(flags, "registry");
  const registry = await loadRegistry(registryPath);
  const annotations = await loadAnnotations(registryPath);
  printEntityTypeWarnings(registry, annotations);
  const snapshotPath = flags["snapshot"];

  // Snapshot gate — entity declarations vs the committed db-meta snapshot.
  // Needs no database: this is the CI/build gate — "entities changed without a
  // committed patch" exits non-zero. `--url` keeps the live-DB drift check.
  if (snapshotPath) {
    const abs = resolve(snapshotPath);
    if (!existsSync(abs)) {
      console.error(
        `snapshot-check: ${abs} missing — run \`primebrick-db compare --registry … --url … --out db-meta\` once to seed it`,
      );
      process.exit(1);
    }
    const committed = JSON.parse(readFileSync(abs, "utf8")) as SchemaSnapshot;
    const entitySnap = buildEntitySnapshot(registry, { annotations });
    const diff = compareSnapshots(entitySnap, committed);
    // Live-DB drift tolerates DB-only objects; the committed snapshot must not —
    // a snapshot-only table/column means an entity was removed without a patch.
    const residual =
      !isDriftClean(diff) ||
      diff.onlyInDatabaseTables.length > 0 ||
      diff.renameHeuristicUserReviewRequired === true;
    if (!residual) {
      console.log("snapshot-check: clean");
      return;
    }
    console.log(
      "snapshot-check: DRIFT — entity declarations differ from the committed db-meta snapshot; " +
        "run `compare`, review the emitted patch, `sign` the manifest, and commit all artifacts",
    );
    console.log(JSON.stringify(diff, null, 2));
    process.exit(1);
  }

  const url = need(flags, "url");
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const diff = await checkDrift(registry, pool, { annotations });
    if (isDriftClean(diff)) {
      console.log("drift-check: clean");
      return;
    }
    console.log("drift-check: DRIFT");
    console.log(JSON.stringify(diff, null, 2));
    process.exit(1);
  } finally {
    await pool.end();
  }
}

async function cmdStatus(flags: Record<string, string>): Promise<void> {
  const url = need(flags, "url");
  const schema = need(flags, "schema");
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    const rows = await registryStatus(pool, schema);
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await pool.end();
  }
}

async function cmdSign(flags: Record<string, string>): Promise<void> {
  const dbMetaDir = resolve(need(flags, "db-meta"));
  const keyId = need(flags, "key-id");
  let keyB64 = need(flags, "key");
  if (keyB64.startsWith("@")) keyB64 = readFileSync(resolve(keyB64.slice(1)), "utf8").trim();

  const { manifestPath } = manifestPaths(dbMetaDir);
  const existing = loadManifest(manifestPath);
  if (!existing) {
    // Build fresh manifest from the patches on disk.
    const patchesDir = join(dbMetaDir, "patches");
    const patches: Record<string, string> = {};
    if (existsSync(patchesDir)) {
      for (const f of readdirSync(patchesDir).filter((f) => f.endsWith(".sql")).sort()) {
        patches[patchNameFromFilename(f)] = sha256Hex(readFileSync(join(patchesDir, f), "utf8"));
      }
    }
    const manifest = signManifest(
      { version: 1, key_id: keyId, issued_at: new Date().toISOString(), patches },
      keyB64,
    );
    writeManifest(manifestPath, manifest);
    console.log(`signed new MANIFEST.json with key '${keyId}' (${Object.keys(patches).length} patches)`);
    return;
  }

  // Re-hash everything on disk — the signature covers what is THERE, not
  // what the previous manifest claimed.
  const patchesDir = join(dbMetaDir, "patches");
  const patches: Record<string, string> = {};
  for (const f of readdirSync(patchesDir).filter((f) => f.endsWith(".sql")).sort()) {
    patches[patchNameFromFilename(f)] = sha256Hex(readFileSync(join(patchesDir, f), "utf8"));
  }
  const manifest = signManifest(
    { version: 1, key_id: keyId, issued_at: new Date().toISOString(), patches },
    keyB64,
  );
  writeManifest(manifestPath, manifest);
  console.log(`re-signed MANIFEST.json with key '${keyId}' (${Object.keys(patches).length} patches)`);
}

async function cmdKeygen(flags: Record<string, string>): Promise<void> {
  const keyId = need(flags, "key-id");
  const trust = (flags["trust"] ?? "dev") as "release" | "dev";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privB64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

  console.log(`key_id:      ${keyId}`);
  console.log(`trust:       ${trust}`);
  console.log(`public_key:  ${pubB64}`);
  console.log(`private_key: ${privB64}`);
  console.warn("private key printed ONCE — store it in the workspace temp dir or CI secrets, never commit it");

  const out = flags["out"];
  if (out) {
    const keysPath = join(resolve(out), KEYS_FILENAME);
    const ring = existsSync(keysPath)
      ? (JSON.parse(readFileSync(keysPath, "utf8")) as TrustedKey[])
      : [];
    ring.push({ key_id: keyId, algo: "ed25519", public_key: pubB64, trust });
    writeFileSync(keysPath, JSON.stringify(ring, null, 2) + "\n");
    console.log(`public key appended to ${keysPath}`);
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

const { cmd, flags } = parseArgs(process.argv.slice(2));

const USAGE = `primebrick-db <command> [flags]
  compare  --registry <module> --url <pg> [--out db-meta]
  apply    --schema <s> --url <pg> [--patches db-meta/patches] [--trust release,dev]
  check    --registry <module> (--url <pg> | --snapshot <file>)
  status   --schema <s> --url <pg>
  sign     --db-meta <dir> --key-id <id> --key <b64|@file>
  keygen   --key-id <id> [--trust dev|release] [--out db-meta]
`;

try {
  switch (cmd) {
    case "compare":
      await cmdCompare(flags);
      break;
    case "apply":
      await cmdApply(flags);
      break;
    case "check":
      await cmdCheck(flags);
      break;
    case "status":
      await cmdStatus(flags);
      break;
    case "sign":
      await cmdSign(flags);
      break;
    case "keygen":
      await cmdKeygen(flags);
      break;
    default:
      console.error(USAGE);
      process.exit(2);
  }
} catch (e) {
  console.error(e instanceof Error ? `error: ${e.message}` : e);
  process.exit(1);
}
