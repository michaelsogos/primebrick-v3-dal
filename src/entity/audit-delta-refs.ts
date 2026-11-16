/**
 * Audit-delta ref enrichment — uuid ref values inside an audit `delta`
 * resolve to display names through the SAME `@Ref` machinery the list
 * joins use (`col.refEntity` → registry → display template), read-side
 * batched: one lookup per distinct ref target per audit page.
 *
 * The wire contract is the `*_display_name` sibling the FE already
 * prefers when present (`change.old_display_name || change.old`) —
 * unresolved values (cross-domain ref, headless entity, missing display
 * template, deleted target row) keep their raw uuid, exactly like the
 * list-cell degrade.
 *
 * Actor vocabulary: `refEntity:"user_profile"` columns (the `*_by`
 * mixin stamps) resolve uuids through `UserProfileRefEntity`; a
 * `system:<code>` actor resolves through `ServiceRegistryRefEntity`'s
 * `name` — the mirror of the join's `CASE` verdict for `<col>_name`.
 */

import type { EntityClass } from "../meta/entity-meta.js";
import { getEntityPersistenceMeta } from "../meta/entity-meta.js";
import { getSchemaDomain } from "../meta/schema-domain.js";
import type { Repository } from "../repository/repository.js";
import { Filter, Project, field } from "../query/dsl.js";
import { lookupEntityService } from "./entity-registry.js";
import { UserProfileRefEntity } from "../entities/user-profile-ref-entity.js";
import { ServiceRegistryRefEntity } from "../entities/service-registry-ref-entity.js";

/** Structural minimum the enrichment queries need — satisfied by both
 *  the gateway `Dal` and a tx-scoped `Repository`. */
type DeltaQueryable = Pick<Repository, "findAll">;

type DeltaChange = {
  old?: unknown;
  new?: unknown;
  from?: unknown;
  to?: unknown;
  old_display_name?: string;
  new_display_name?: string;
};

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SYSTEM_ACTOR_RE = /^system:(.+)$/;

/** `${key}` tokens interpolate against the raw row — the JS twin of
 *  `renderDisplayTemplate`. `undefined` when EVERY token resolves to a
 *  null/undefined prop (same NULL-verdict the SQL renderer emits). */
function materializeDisplay(template: string, row: Record<string, unknown>): string | undefined {
  let anyValue = false;
  const out = template.replace(/\$\{([^}]+)\}/g, (_m, k: string) => {
    const v = row[k.trim()];
    if (v !== null && v !== undefined) anyValue = true;
    return v === null || v === undefined ? "" : String(v);
  });
  return anyValue ? out : undefined;
}

/**
 * Enrich every delta row's ref-valued changes with `old_display_name` /
 * `new_display_name`, batched per audit page. `entity` is the audited
 * row's entity class — its column meta carries the `@Ref` targets.
 * Returns the same rows (deltas replaced in place via spread copy —
 * caller owns the mapping).
 */
export async function enrichAuditDeltaRefs(
  repo: DeltaQueryable,
  entity: EntityClass,
  deltas: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const meta = getEntityPersistenceMeta(entity);
  const shared = getSchemaDomain()?.sharedTables;

  // ── collect candidates: target key → uuids ──────────────────────────
  const userUuids = new Set<string>();
  const systemCodes = new Set<string>();
  const domainUuids = new Map<string, Set<string>>(); // refEntity → uuids

  const SIDES = ["old", "new", "from", "to"] as const;
  for (const delta of deltas) {
    for (const [fieldName, raw] of Object.entries(delta)) {
      const change = raw as DeltaChange | undefined;
      if (change === null || typeof change !== "object") continue;
      const refEntity = meta.columns[fieldName]?.refEntity;
      if (refEntity === undefined) continue;
      for (const side of SIDES) {
        const v = change[side];
        if (typeof v !== "string") continue;
        if (UUID_RE.test(v)) {
          if (refEntity === "user_profile") userUuids.add(v);
          else {
            let set = domainUuids.get(refEntity);
            if (!set) domainUuids.set(refEntity, (set = new Set()));
            set.add(v);
          }
        } else if (refEntity === "user_profile") {
          const m = SYSTEM_ACTOR_RE.exec(v);
          if (m) systemCodes.add(m[1]);
        }
      }
    }
  }
  if (userUuids.size === 0 && systemCodes.size === 0 && domainUuids.size === 0) return deltas;

  // ── resolve each target once ────────────────────────────────────────
  const names = new Map<string, string>(); // `target\u0000value` → label

  if (userUuids.size > 0) {
    const rows = (await repo.findAll(
      UserProfileRefEntity,
      [
        Project.field(field(UserProfileRefEntity, "uuid")),
        Project.field(field(UserProfileRefEntity, "display_name")),
      ],
      {
        filters: [Filter.fieldValue(field(UserProfileRefEntity, "uuid"), "IN", [...userUuids])],
        deletedRecords: "INCLUDED",
      } as never,
    )) as unknown as Record<string, unknown>[];
    for (const r of rows ?? []) {
      const name = r["display_name"];
      if (typeof name === "string") names.set(`user_profile${r["uuid"] as string}`, name);
    }
  }

  if (systemCodes.size > 0) {
    const rows = (await repo.findAll(
      ServiceRegistryRefEntity,
      [
        Project.field(field(ServiceRegistryRefEntity, "code")),
        Project.field(field(ServiceRegistryRefEntity, "name")),
      ],
      {
        filters: [Filter.fieldValue(field(ServiceRegistryRefEntity, "code"), "IN", [...systemCodes])],
        deletedRecords: "INCLUDED",
      } as never,
    )) as unknown as Record<string, unknown>[];
    for (const r of rows ?? []) {
      const name = r["name"];
      if (typeof name === "string") names.set(`service_registry${r["code"] as string}`, name);
    }
  }

  for (const [refEntity, uuids] of domainUuids) {
    const target = lookupEntityService(refEntity);
    if (target === undefined || target.display === null) continue;
    let targetMeta;
    try {
      targetMeta = getEntityPersistenceMeta(target.entity, meta.tableSchema);
    } catch {
      continue; // foreign-domain entity — the schema guard itself says no
    }
    if (targetMeta.tableSchema !== meta.tableSchema && !(shared?.has(targetMeta.tableName) ?? false)) {
      continue;
    }
    const uidKey = Object.values(targetMeta.columns).find(
      (c) => c.propertyKey === "uuid" || c.isUnique,
    )?.propertyKey;
    if (uidKey === undefined) continue;
    const rows = (await repo.findAll(target.entity, null, {
      filters: [Filter.fieldValue(field(target.entity, uidKey as never), "IN", [...uuids])],
      deletedRecords: "INCLUDED",
    } as never)) as unknown as Record<string, unknown>[];
    for (const r of rows ?? []) {
      const label = materializeDisplay(target.display, r);
      if (label !== undefined) names.set(`${refEntity}${r[uidKey] as string}`, label);
    }
  }
  if (names.size === 0) return deltas;

  // ── apply ───────────────────────────────────────────────────────────
  return deltas.map((delta) => {
    const out = { ...delta };
    for (const [fieldName, raw] of Object.entries(out)) {
      const change = raw as DeltaChange | undefined;
      if (change === null || typeof change !== "object") continue;
      const refEntity = meta.columns[fieldName]?.refEntity;
      if (refEntity === undefined) continue;
      const resolve = (v: unknown): string | undefined => {
        if (typeof v !== "string") return undefined;
        if (UUID_RE.test(v)) return names.get(`${refEntity}${v}`);
        if (refEntity === "user_profile") {
          const m = SYSTEM_ACTOR_RE.exec(v);
          if (m) return names.get(`service_registry${m[1]}`);
        }
        return undefined;
      };
      const oldResolved = resolve(change.old ?? change.from);
      const newResolved = resolve(change.new ?? change.to);
      if (oldResolved !== undefined) change.old_display_name = oldResolved;
      if (newResolved !== undefined) change.new_display_name = newResolved;
    }
    return out;
  });
}

/** The service's schema domain shares — the same source
 *  `refDisplayJoinsFor` consults (`getSchemaDomain` is process-global,
 *  configured at `getDal(config)` boot). */
