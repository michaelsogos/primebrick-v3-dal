/** Migration engine — apply side. Generation side lives in schema-diff/. */
export {
  runMigrations,
  parsePatchPragmas,
  type MigrationEngineOptions,
  type MigrationMode,
  type MigrationRunResult,
} from "./engine.js";
export {
  patchRegistryDdl,
  PATCH_REGISTRY_TABLE,
  type PatchRegistryRow,
  type PatchStatus,
} from "./patch-registry.js";
export {
  MANIFEST_FILENAME,
  KEYS_FILENAME,
  manifestPaths,
  loadKeyring,
  loadManifest,
  verifyManifest,
  signManifest,
  writeManifest,
  canonicalJson,
  ManifestError,
  type PatchManifest,
  type TrustedKey,
} from "./manifest.js";
export { splitSqlStatements, parsePatchSegments, type PatchSegment } from "./sql-splitter.js";
export { checkDrift, isDriftClean } from "./drift.js";
export {
  registryStatus,
  retryFailedPatches,
  approvePendingReview,
  resolveManually,
} from "./status.js";
