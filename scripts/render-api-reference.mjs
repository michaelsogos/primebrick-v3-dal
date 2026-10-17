#!/usr/bin/env node
/**
 * Deterministic renderer: reads docs/dev-guide/_extracted/api.json (TypeDoc)
 * and writes docs/dev-guide/api-reference.mdx.
 *
 * No prose, no examples — just signatures and types in MDX tables.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const apiJsonPath = join(root, 'docs', 'dev-guide', '_extracted', 'api.json');
const outPath = join(root, 'docs', 'dev-guide', 'api-reference.mdx');

const data = JSON.parse(readFileSync(apiJsonPath, 'utf8'));
const children = data.children || [];

// TypeDoc kinds
const K_FUNCTION = 64;
const K_CLASS = 128;
const K_INTERFACE = 256;
const K_ENUM = 8;
const K_TYPE_ALIAS = 2097152;
const K_VARIABLE = 32;
const K_REFERENCE = 4194304; // re-export type alias — skip

function summaryText(comment) {
  if (!comment || !comment.summary) return '';
  return comment.summary.map(s => s.text).join('').trim();
}

function paramDescription(param) {
  if (param.comment && param.comment.summary) {
    return param.comment.summary.map(s => s.text).join('').trim();
  }
  return '';
}

function typeToString(type) {
  if (!type) return '';
  switch (type.type) {
    case 'intrinsic':
      return type.name;
    case 'reference':
      if (type.typeArguments && type.typeArguments.length) {
        return `${type.name}<${type.typeArguments.map(typeToString).join(', ')}>`;
      }
      return type.name;
    case 'array':
      return `${typeToString(type.elementType)}[]`;
    case 'union':
      return type.types.map(typeToString).join(' | ');
    case 'intersection':
      return type.types.map(typeToString).join(' & ');
    case 'literal':
      return type.value !== undefined ? JSON.stringify(type.value) : String(type.value);
    case 'reflection':
      if (type.declaration && type.declaration.children) {
        const fields = type.declaration.children
          .map(c => `${c.name}: ${typeToString(c.type)}`)
          .join('; ');
        return `{ ${fields} }`;
      }
      if (type.declaration && type.declaration.signatures) {
        const sig = type.declaration.signatures[0];
        const params = (sig.parameters || [])
          .map(p => `${p.name}: ${typeToString(p.type)}`)
          .join(', ');
        return `(${params}) => ${typeToString(sig.type)}`;
      }
      return '{}';
    case 'tuple':
      return `[${(type.elements || []).map(typeToString).join(', ')}]`;
    case 'predicate':
      return `${type.name} is ${typeToString(type.targetType)}`;
    case 'indexedAccess':
      return `${typeToString(type.objectType)}[${typeToString(type.indexType)}]`;
    case 'conditional':
      return `${typeToString(type.checkType)} extends ${typeToString(type.extendsType)} ? ${typeToString(type.trueType)} : ${typeToString(type.falseType)}`;
    case 'query':
      return `typeof ${typeToString(type.queryType)}`;
    case 'unknown':
      return type.name || 'unknown';
    default:
      return type.name || type.type || '';
  }
}

function esc(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// Type expressions are always emitted inside backticks so MDX can't parse
// `{`, `}`, `<`, `>` as JSX/expressions (and so they render as code).
const code = (t) => (t ? `\`${t}\`` : '');

// MDX-safe prose: escape MDX metacharacters outside inline-code spans so
// `{`, `}`, `<`, `>` in doc comments can never be parsed as JSX/expressions.
function mdxSafe(s) {
  return String(s).replace(/(`[^`]*`)|[{}<>]/g, (m, codeSpan) =>
    codeSpan ? m : `&#${m.charCodeAt(0)};`,
  );
}

function renderFunction(sym) {
  const sig = sym.signatures && sym.signatures[0];
  if (!sig) return '';
  const summary = summaryText(sig.comment);
  const params = (sig.parameters || []).map(p => ({
    name: p.name,
    type: esc(typeToString(p.type)),
    desc: mdxSafe(paramDescription(p)),
  }));
  const ret = esc(typeToString(sig.type));
  let md = `### \`${sym.name}(${params.map(p => p.name).join(', ')}): ${ret}\`\n\n`;
  if (summary) md += `${mdxSafe(summary)}\n\n`;
  if (params.length) {
    md += `| Parameter | Type | Description |\n|-----------|------|-------------|\n`;
    for (const p of params) {
      md += `| ${esc(p.name)} | ${code(p.type)} | ${p.desc} |\n`;
    }
    md += '\n';
  }
  return md;
}

function isOwnSource(child) {
  const src = child.sources && child.sources[0];
  if (!src || !src.fileName) return false;
  return src.fileName.includes('primebrick-dal-v3/src/');
}

function renderClass(sym) {
  let md = `### \`${sym.name}\`\n\n`;
  const summary = summaryText(sym.comment);
  if (summary) md += `${mdxSafe(summary)}\n\n`;
  // Only include members declared in the DAL's own src/ (not inherited from Error, etc.)
  const ownChildren = (sym.children || []).filter(isOwnSource);
  // Class methods (kind 2048), constructors (kind 512), properties (kind 1024)
  const methods = ownChildren.filter(c => c.kind === 2048);
  const ctors = ownChildren.filter(c => c.kind === 512);
  const props = ownChildren.filter(c => c.kind === 1024);
  if (props.length) {
    md += `| Property | Type | Description |\n|----------|------|-------------|\n`;
    for (const p of props) {
      md += `| ${esc(p.name)} | ${code(esc(typeToString(p.type)))} | ${mdxSafe(summaryText(p.comment))} |\n`;
    }
    md += '\n';
  }
  for (const ct of ctors) {
    const sig = ct.signatures && ct.signatures[0];
    if (!sig) continue;
    const cs = summaryText(sig.comment);
    const params = (sig.parameters || []).map(p => ({
      name: p.name,
      type: esc(typeToString(p.type)),
      desc: mdxSafe(paramDescription(p)),
    }));
    md += `#### \`${sym.name}(${params.map(p => p.name).join(', ')})\`\n\n`;
    if (cs) md += `${mdxSafe(cs)}\n\n`;
    if (params.length) {
      md += `| Parameter | Type | Description |\n|-----------|------|-------------|\n`;
      for (const p of params) {
        md += `| ${esc(p.name)} | ${code(p.type)} | ${p.desc} |\n`;
      }
      md += '\n';
    }
  }
  if (methods.length) {
    for (const m of methods) {
      const sig = m.signatures && m.signatures[0];
      if (!sig) continue;
      const ms = summaryText(sig.comment);
      const params = (sig.parameters || []).map(p => ({
        name: p.name,
        type: esc(typeToString(p.type)),
        desc: mdxSafe(paramDescription(p)),
      }));
      const ret = esc(typeToString(sig.type));
      md += `#### \`${sym.name}.${m.name}(${params.map(p => p.name).join(', ')})${ret && ret !== 'void' ? `: ${ret}` : ''}\`\n\n`;
      if (ms) md += `${mdxSafe(ms)}\n\n`;
      if (params.length) {
        md += `| Parameter | Type | Description |\n|-----------|------|-------------|\n`;
        for (const p of params) {
          md += `| ${esc(p.name)} | ${code(p.type)} | ${p.desc} |\n`;
        }
        md += '\n';
      }
    }
  }
  return md;
}

function renderInterface(sym) {
  let md = `### \`${sym.name}\`\n\n`;
  const summary = summaryText(sym.comment);
  if (summary) md += `${mdxSafe(summary)}\n\n`;
  const fields = (sym.children || []).filter(c => c.kind === 1024);
  if (fields.length) {
    md += `| Field | Type | Description |\n|-------|------|-------------|\n`;
    for (const f of fields) {
      md += `| ${esc(f.name)} | ${code(esc(typeToString(f.type)))} | ${mdxSafe(summaryText(f.comment))} |\n`;
    }
    md += '\n';
  }
  return md;
}

function renderTypeAlias(sym) {
  let md = `### \`${sym.name}\`\n\n`;
  const summary = summaryText(sym.comment);
  if (summary) md += `${mdxSafe(summary)}\n\n`;
  if (sym.type) {
    md += `**Type:** \`${esc(typeToString(sym.type))}\`\n\n`;
  }
  return md;
}

function renderEnum(sym) {
  let md = `### \`${sym.name}\`\n\n`;
  const summary = summaryText(sym.comment);
  if (summary) md += `${mdxSafe(summary)}\n\n`;
  const members = (sym.children || []).filter(c => c.kind === 16);
  if (members.length) {
    md += `| Member | Value |\n|--------|-------|\n`;
    for (const m of members) {
      const val = m.type && m.type.type === 'literal' ? m.type.value : m.name;
      md += `| ${esc(m.name)} | ${esc(JSON.stringify(val))} |\n`;
    }
    md += '\n';
  }
  return md;
}

function renderVariable(sym) {
  let md = `### \`${sym.name}\`\n\n`;
  const summary = summaryText(sym.comment);
  if (summary) md += `${mdxSafe(summary)}\n\n`;
  if (sym.type) {
    md += `**Type:** \`${esc(typeToString(sym.type))}\`\n\n`;
  }
  // If it's a reflection with children (like SERVICE_SUBJECTS const object), render fields
  if (sym.type && sym.type.type === 'reflection' && sym.type.declaration && sym.type.declaration.children) {
    const fields = sym.type.declaration.children;
    md += `| Field | Value |\n|-------|-------|\n`;
    for (const f of fields) {
      const val = f.type && f.type.type === 'literal' ? f.type.value : '';
      md += `| ${esc(f.name)} | ${esc(JSON.stringify(val))} |\n`;
    }
    md += '\n';
  }
  return md;
}

// Categorize
const classes = children.filter(c => c.kind === K_CLASS);
const interfaces = children.filter(c => c.kind === K_INTERFACE);
const typeAliases = children.filter(c => c.kind === K_TYPE_ALIAS);
const enums = children.filter(c => c.kind === K_ENUM);
const functions = children.filter(c => c.kind === K_FUNCTION);
const variables = children.filter(c => c.kind === K_VARIABLE);
// Skip K_REFERENCE (4194304) — these are re-export type aliases

let out = `<!-- AUTO-GENERATED:reference -->
---
title: API Reference
description: Complete API reference for @primebrick/dal-pg — every exported symbol.
---

# API Reference

Every exported symbol from \`@primebrick/dal-pg\`, rendered mechanically from the
TypeDoc extraction. This page is regenerated from \`docs/dev-guide/_extracted/api.json\`
on every \`pnpm extract-docs\` run — do not edit by hand.

`;

if (classes.length) {
  out += `## Classes\n\n`;
  for (const s of classes.sort((a, b) => a.name.localeCompare(b.name))) out += renderClass(s);
}
if (interfaces.length) {
  out += `## Interfaces\n\n`;
  for (const s of interfaces.sort((a, b) => a.name.localeCompare(b.name))) out += renderInterface(s);
}
if (typeAliases.length || enums.length) {
  out += `## Types & Enums\n\n`;
  for (const s of enums.sort((a, b) => a.name.localeCompare(b.name))) out += renderEnum(s);
  for (const s of typeAliases.sort((a, b) => a.name.localeCompare(b.name))) out += renderTypeAlias(s);
}
if (variables.length) {
  out += `## Constants\n\n`;
  for (const s of variables.sort((a, b) => a.name.localeCompare(b.name))) out += renderVariable(s);
}
if (functions.length) {
  out += `## Functions\n\n`;
  for (const s of functions.sort((a, b) => a.name.localeCompare(b.name))) out += renderFunction(s);
}

out += `<!-- END -->\n`;

writeFileSync(outPath, out, 'utf8');
const counts = {
  classes: classes.length,
  interfaces: interfaces.length,
  types: typeAliases.length + enums.length,
  constants: variables.length,
  functions: functions.length,
};
console.log('Rendered api-reference.mdx');
console.log(JSON.stringify(counts, null, 2));
console.log('Total symbols:', Object.values(counts).reduce((a, b) => a + b, 0));
