#!/usr/bin/env node
/**
 * Extract API documentation from TypeScript source using TypeDoc.
 * Produces JSON output for use as deterministic context in AI-generated docs.
 *
 * Usage: node scripts/extract-api-docs.mjs
 * Output: docs/dev-guide/_extracted/api.json
 */
import { execSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const outputDir = join(projectRoot, 'docs', 'dev-guide', '_extracted');

console.log('=== TypeDoc API extraction ===');

// Ensure output directory exists
mkdirSync(outputDir, { recursive: true });

/**
 * TSDoc text values capture the SOURCE files' line endings — on Windows
 * checkouts they arrive as \r\n, on CI as \n, which makes the committed
 * extraction permanently "stale" on the other platform. Normalize every
 * string value to \n so the artifact is byte-identical cross-platform.
 */
const normalizeEol = (value) => {
  if (typeof value === 'string') return value.replace(/\r\n?/g, '\n');
  if (Array.isArray(value)) return value.map(normalizeEol);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeEol(v)]));
  }
  return value;
};

try {
  execSync('npx typedoc', {
    cwd: projectRoot,
    stdio: 'inherit',
    timeout: 120000,
  });
  const outputFile = join(outputDir, 'api.json');
  if (existsSync(outputFile)) {
    const doc = normalizeEol(JSON.parse(readFileSync(outputFile, 'utf8')));
    writeFileSync(outputFile, JSON.stringify(doc, null, '\t') + '\n', 'utf8');
    console.log(`\nWrote API reference to docs/dev-guide/_extracted/api.json`);
  } else {
    console.warn('Warning: api.json was not created. Check typedoc.json config.');
  }
  console.log('=== Extraction complete ===');
} catch (err) {
  console.error('TypeDoc extraction failed:', err.message);
  process.exit(1);
}
