/**
 * Pairwise rename detection between “entity-only” and “database-only” column names.
 * Deterministic rule ladder (no numeric weights): strictest tier first, then greedy 1:1
 * with stable tie-breaks (PK pair preferred, then lexicographic column names).
 *
 * Performance: avoids full E×D Cartesian product by indexing DB-only columns by ordinal
 * and only probing small ordinal windows per entity column (plus a fallback when
 * ordinal metadata is missing).
 */

import type { SchemaColumnMeta } from "./schema-types.js";
import { comparablePgType, typesCompatibleForRename } from "./schema-type-normalize.js";

export type LikelyRename = {
  databaseColumn: string;
  entityColumn: string;
  /** 0 = strictest rule; larger = looser fallback */
  matchTier: number;
  /** Stable label for the tier (for logs / JSON) */
  matchRule: string;
  reasons: string[];
  suggestedSql: string;
};

export type RenameAmbiguity = {
  matchTier: number;
  matchRule: string;
  /** Entity columns with more than one valid DB partner in this tier (before greedy). */
  competingEntityColumns: string[];
  /** DB columns with more than one valid entity partner in this tier (before greedy). */
  competingDatabaseColumns: string[];
  /** Candidate pairs in this tier (deterministic order). */
  pairs: { entityColumn: string; databaseColumn: string }[];
};

export type RenameHeuristicResult = {
  likelyRenames: LikelyRename[];
  /** If non-empty, heuristic matching was not unique; do not treat renames as authoritative without user input. */
  ambiguities: RenameAmbiguity[];
  userReviewRequired: boolean;
};

/** Ordered strict → loose; documented for consumers of `diff-entities-vs-database.json`. */
export const RENAME_MATCH_RULE_LABELS: readonly string[] = [
  "compatible_type_same_ordinal",
  "compatible_type_adjacent_ordinal",
  "compatible_type_ordinal_delta_2",
  "weak_untyped_entity_same_ordinal_same_nullability",
  "weak_untyped_entity_adjacent_ordinal_same_nullability",
  "compatible_type_ordinal_metadata_unavailable",
] as const;

export const RENAME_HEURISTIC_AGENT_INSTRUCTION =
  "renameHeuristicUserReviewRequired is true: ambiguous rename candidates were detected. You MUST ask the user which renames (if any) to apply before running suggested ALTER ... RENAME COLUMN or generating migrations from likelyRenames.";

function ordinal(meta: SchemaColumnMeta | undefined): number | null {
  return meta?.ordinalPosition ?? null;
}

function ordinalDelta(eMeta: SchemaColumnMeta, dMeta: SchemaColumnMeta): number | null {
  const eo = ordinal(eMeta);
  const dor = ordinal(dMeta);
  if (eo == null || dor == null) return null;
  return Math.abs(eo - dor);
}

function weakUntypedEntity(eMeta: SchemaColumnMeta): boolean {
  return !(eMeta.typname ?? "").length && !(eMeta.dataType ?? "").length;
}

function sameNullability(eMeta: SchemaColumnMeta, dMeta: SchemaColumnMeta): boolean {
  return (
    eMeta.isNullable != null &&
    dMeta.isNullable != null &&
    eMeta.isNullable === dMeta.isNullable
  );
}

function bothPrimaryKey(eMeta: SchemaColumnMeta, dMeta: SchemaColumnMeta): boolean {
  return Boolean(eMeta.isPrimaryKey && dMeta.isPrimaryKey);
}

/**
 * Assigns the single strictest tier that applies, or `null` if no rule matches.
 */
export function classifyRenamePair(
  eMeta: SchemaColumnMeta,
  dMeta: SchemaColumnMeta
): { matchTier: number; reasons: string[] } | null {
  const delta = ordinalDelta(eMeta, dMeta);
  const typ = typesCompatibleForRename(eMeta, dMeta);

  if (typ && delta === 0) {
    return {
      matchTier: 0,
      reasons: [`compatible_type:${comparablePgType(eMeta)}`, "same_ordinal_position"],
    };
  }
  if (typ && delta === 1) {
    return {
      matchTier: 1,
      reasons: [`compatible_type:${comparablePgType(eMeta)}`, "adjacent_ordinal_position"],
    };
  }
  if (typ && delta === 2) {
    return {
      matchTier: 2,
      reasons: [`compatible_type:${comparablePgType(eMeta)}`, "ordinal_delta_2"],
    };
  }

  if (!typ && weakUntypedEntity(eMeta) && sameNullability(eMeta, dMeta) && delta === 0) {
    return {
      matchTier: 3,
      reasons: ["weak_no_entity_type_hint", "same_ordinal_position", "same_nullability"],
    };
  }
  if (!typ && weakUntypedEntity(eMeta) && sameNullability(eMeta, dMeta) && delta === 1) {
    return {
      matchTier: 4,
      reasons: ["weak_no_entity_type_hint", "adjacent_ordinal_position", "same_nullability"],
    };
  }

  if (typ && delta === null) {
    return {
      matchTier: 5,
      reasons: [`compatible_type:${comparablePgType(eMeta)}`, "ordinal_metadata_unavailable"],
    };
  }

  return null;
}

type Candidate = { e: string; d: string; matchTier: number; reasons: string[] };

/** DB-only column names grouped by `ordinalPosition` (small fan-out per ordinal). */
function buildOrdinalIndex(
  onlyNames: string[],
  columns: Record<string, SchemaColumnMeta>
): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const name of onlyNames) {
    const o = ordinal(columns[name]);
    if (o == null) continue;
    const list = m.get(o) ?? [];
    list.push(name);
    m.set(o, list);
  }
  return m;
}

function collectNamesAtOrds(
  idx: Map<number, string[]>,
  ords: readonly number[],
  allowed: ReadonlySet<string>
): string[] {
  const out: string[] = [];
  for (const o of ords) {
    for (const n of idx.get(o) ?? []) {
      if (allowed.has(n)) out.push(n);
    }
  }
  return out;
}

/**
 * DB column names to classify against `e` — ordinal window (tiers 0–4) plus any DB-only column
 * missing ordinal metadata (tier 5 may need those pairs).
 */
function candidateDatabaseColumnsForEntity(
  e: string,
  entityColumns: Record<string, SchemaColumnMeta>,
  databaseColumns: Record<string, SchemaColumnMeta>,
  databaseOnlySet: ReadonlySet<string>,
  dbOrdinalIndex: Map<number, string[]>,
  databaseOnly: readonly string[]
): string[] {
  const em = entityColumns[e]!;
  const eo = ordinal(em);
  const out = new Set<string>();

  if (eo == null) {
    for (const d of databaseOnly) {
      if (databaseOnlySet.has(d)) out.add(d);
    }
    return [...out];
  }

  const ordWindow = [eo, eo - 1, eo + 1, eo - 2, eo + 2] as const;
  for (const d of collectNamesAtOrds(dbOrdinalIndex, ordWindow, databaseOnlySet)) {
    out.add(d);
  }
  for (const d of databaseOnly) {
    if (!databaseOnlySet.has(d)) continue;
    if (ordinal(databaseColumns[d]) == null) out.add(d);
  }
  return [...out];
}

function sortCandidatesInTier(
  list: Candidate[],
  entityColumns: Record<string, SchemaColumnMeta>,
  databaseColumns: Record<string, SchemaColumnMeta>
): void {
  list.sort((a, b) => {
    const aPk = bothPrimaryKey(entityColumns[a.e]!, databaseColumns[a.d]!) ? 0 : 1;
    const bPk = bothPrimaryKey(entityColumns[b.e]!, databaseColumns[b.d]!) ? 0 : 1;
    if (aPk !== bPk) return aPk - bPk;
    const ce = a.e.localeCompare(b.e);
    if (ce !== 0) return ce;
    return a.d.localeCompare(b.d);
  });
}

function findAmbiguityInTier(tier: number, candidates: Candidate[]): RenameAmbiguity | null {
  if (candidates.length === 0) return null;
  const eDeg = new Map<string, number>();
  const dDeg = new Map<string, number>();
  for (const p of candidates) {
    eDeg.set(p.e, (eDeg.get(p.e) ?? 0) + 1);
    dDeg.set(p.d, (dDeg.get(p.d) ?? 0) + 1);
  }
  const competingEntityColumns = [...eDeg.entries()]
    .filter(([, n]) => n > 1)
    .map(([name]) => name)
    .sort();
  const competingDatabaseColumns = [...dDeg.entries()]
    .filter(([, n]) => n > 1)
    .map(([name]) => name)
    .sort();
  if (competingEntityColumns.length === 0 && competingDatabaseColumns.length === 0) return null;
  const pairs = [...candidates]
    .map((p) => ({ entityColumn: p.e, databaseColumn: p.d }))
    .sort(
      (a, b) =>
        a.entityColumn.localeCompare(b.entityColumn) || a.databaseColumn.localeCompare(b.databaseColumn)
    );
  return {
    matchTier: tier,
    matchRule: RENAME_MATCH_RULE_LABELS[tier] ?? `tier_${tier}`,
    competingEntityColumns,
    competingDatabaseColumns,
    pairs,
  };
}

/**
 * Greedy 1:1 matching: process tiers 0→n, within each tier stable order, no floats.
 * Uses ordinal indexing to avoid scanning all DB-only columns for every entity-only column.
 */
export function findLikelyRenames(
  schema: string,
  table: string,
  entityOnly: string[],
  databaseOnly: string[],
  entityColumns: Record<string, SchemaColumnMeta>,
  databaseColumns: Record<string, SchemaColumnMeta>
): RenameHeuristicResult {
  const databaseOnlySet = new Set(databaseOnly);
  const dbOrdinalIndex = buildOrdinalIndex(databaseOnly, databaseColumns);
  const maxTier = RENAME_MATCH_RULE_LABELS.length - 1;
  const buckets: Candidate[][] = Array.from({ length: maxTier + 1 }, () => []);
  const pairSeen = buckets.map(() => new Set<string>());

  for (const e of entityOnly) {
    const em = entityColumns[e]!;
    const toCheck = candidateDatabaseColumnsForEntity(
      e,
      entityColumns,
      databaseColumns,
      databaseOnlySet,
      dbOrdinalIndex,
      databaseOnly
    );
    for (const d of toCheck) {
      const dm = databaseColumns[d]!;
      const c = classifyRenamePair(em, dm);
      if (!c) continue;
      const tier = c.matchTier;
      const key = `${e}\0${d}`;
      if (pairSeen[tier]!.has(key)) continue;
      pairSeen[tier]!.add(key);
      buckets[tier]!.push({ e, d, matchTier: tier, reasons: c.reasons });
    }
  }

  const ambiguities: RenameAmbiguity[] = [];
  for (let tier = 0; tier <= maxTier; tier++) {
    const amb = findAmbiguityInTier(tier, buckets[tier]!);
    if (amb) ambiguities.push(amb);
  }
  const userReviewRequired = ambiguities.length > 0;

  const usedE = new Set<string>();
  const usedD = new Set<string>();
  const out: LikelyRename[] = [];

  for (let tier = 0; tier <= maxTier; tier++) {
    const list = buckets[tier]!;
    sortCandidatesInTier(list, entityColumns, databaseColumns);
    const rule = RENAME_MATCH_RULE_LABELS[tier] ?? `tier_${tier}`;
    const fq = `"${schema}"."${table}"`;

    for (const p of list) {
      if (usedE.has(p.e) || usedD.has(p.d)) continue;
      usedE.add(p.e);
      usedD.add(p.d);
      out.push({
        databaseColumn: p.d,
        entityColumn: p.e,
        matchTier: p.matchTier,
        matchRule: rule,
        reasons: p.reasons,
        suggestedSql: `ALTER TABLE ${fq} RENAME COLUMN "${p.d}" TO "${p.e}";`,
      });
    }
  }

  out.sort(
    (a, b) =>
      a.matchTier - b.matchTier ||
      a.entityColumn.localeCompare(b.entityColumn) ||
      a.databaseColumn.localeCompare(b.databaseColumn)
  );

  return { likelyRenames: out, ambiguities, userReviewRequired };
}
