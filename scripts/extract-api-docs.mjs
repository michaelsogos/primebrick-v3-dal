#!/usr/bin/env node
/**
 * Extract API documentation from TypeScript source using TypeDoc.
 * Produces JSON output for use as deterministic context in AI-generated docs.
 *
 * Usage: node scripts/extract-api-docs.mjs
 * Output: docs/user-guide/_extracted/api.json
 */
import { execSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const outputDir = join(projectRoot, 'docs', 'user-guide', '_extracted');

console.log('=== TypeDoc API extraction ===');

// Ensure output directory exists
mkdirSync(outputDir, { recursive: true });

try {
  execSync('npx typedoc', {
    cwd: projectRoot,
    stdio: 'inherit',
    timeout: 120000,
  });
  const outputFile = join(outputDir, 'api.json');
  if (existsSync(outputFile)) {
    console.log(`\nWrote API reference to docs/user-guide/_extracted/api.json`);
  } else {
    console.warn('Warning: api.json was not created. Check typedoc.json config.');
  }
  console.log('=== Extraction complete ===');
} catch (err) {
  console.error('TypeDoc extraction failed:', err.message);
  process.exit(1);
}
