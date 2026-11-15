/**
 * Display-template → SQL renderer for join display projections.
 *
 * `"${key}"` tokens resolve against the joined entity's column metadata
 * and are projected off the join alias; everything else is literal text.
 * The expression is NULL when EVERY referenced column is NULL, so the
 * outer `COALESCE(expr, <raw col>::text)` fallback (orphan join row,
 * non-uuid actor like `system`) keeps identical semantics to the plain
 * `display_name` column case. A single-token template renders the bare
 * column ref — `COALESCE` needs no CASE wrapper.
 *
 * Template keys are validated against the entity's persistence meta at
 * RENDER time (service construction) — an unknown `${key}` is a
 * `ValidationError`, never a runtime `42703`.
 */

import type { EntityClass } from "../meta/entity-meta.js";
import { getEntityPersistenceMeta } from "../meta/entity-meta.js";
import { quoteIdent } from "./query-builder.js";
import { ValidationError } from "../errors/errors.js";

const TOKEN = /\$\{([^}]+)\}/g;

const sqlLiteral = (s: string): string => `'${s.replaceAll("'", "''")}'`;

export function renderDisplayTemplate(
  template: string,
  entity: EntityClass,
  alias: string,
): string {
  const meta = getEntityPersistenceMeta(entity);
  const operands: string[] = [];
  const guards: string[] = [];
  let bareRef: string | undefined;
  let last = 0;
  for (const m of template.matchAll(TOKEN)) {
    if (m.index > last) operands.push(sqlLiteral(template.slice(last, m.index)));
    const key = m[1].trim();
    const col = meta.columns[key];
    if (!col) {
      throw new ValidationError(
        `display template "${template}": \${${key}} is not a column of ${meta.entityClassName}`,
      );
    }
    const ref = `${quoteIdent(alias)}.${quoteIdent(col.sqlName)}::text`;
    guards.push(ref);
    operands.push(`COALESCE(${ref}, '')`);
    if (m.index === 0 && m[0].length === template.length) bareRef = ref;
    last = m.index + m[0].length;
  }
  if (last < template.length) operands.push(sqlLiteral(template.slice(last)));

  if (bareRef !== undefined) return bareRef; // "${key}" only — NULL propagates
  if (guards.length === 0) return sqlLiteral(template); // literal-only (degenerate)

  return `CASE WHEN COALESCE(${guards.join(", ")}) IS NULL THEN NULL ELSE ${operands.join(" || ")} END`;
}
