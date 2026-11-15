/**
 * Auditable join helpers — builds LEFT JOINs for creator, updater, deleter.
 *
 * Unlike the BE version which hardcodes `UserProfileEntity`, the DAL version
 * accepts the "user entity" class as a parameter. This makes the DAL a true
 * leaf dependency — it doesn't import from any consumer repo.
 */

import type { EntityClass } from "../meta/entity-meta.js";
import { getEntityPersistenceMeta, getColumnName } from "../meta/entity-decorators.js";
import { ServiceRegistryRefEntity } from "../entities/service-registry-ref-entity.js";
import { Join, field, Project } from "../query/dsl.js";
import { renderDisplayTemplate } from "../query/display-template.js";
import { quoteIdent } from "../query/query-builder.js";
import type { JoinExpr, FieldProjector } from "../query/dsl.js";

/** Platform-identity display template for every actor join — mirrors the
 *  `display_field` declared on user_profile's BE meta (`display_name`),
 *  i.e. the materialized default `"${display_field}"`. Evaluated on the
 *  join alias exactly like entity self-ref display templates. */
const USER_DISPLAY_TEMPLATE = "${display_name}";

/**
 * Standard join configuration for auditable entities.
 * Automatically adds LEFT JOINs to the user entity table for created_by, updated_by, deleted_by fields.
 *
 * Uses regex guardrail pattern to only join when the field contains a valid UUID.
 * This prevents errors when the field contains non-UUID values like "system".
 *
 * @param entity - The entity class implementing IAuditableEntity
 * @param userEntity - The user entity class (e.g. UserProfileEntity) that has a `uuid` and `display_name` column
 * @returns Array of Join expressions for creator, updater, and deleter
 */
export function buildAuditableJoins(
  entity: EntityClass,
  userEntity: EntityClass
): ReturnType<typeof Join.on>[] {
  return [
    Join.on(
      field(userEntity, "uuid" as any),
      field(entity, "created_by" as any),
      "LEFT",
      { castRightTo: "text", castLeftTo: "text", alias: "creator" }
    ),
    Join.on(
      field(userEntity, "uuid" as any),
      field(entity, "updated_by" as any),
      "LEFT",
      { castRightTo: "text", castLeftTo: "text", alias: "updater" }
    ),
    Join.on(
      field(userEntity, "uuid" as any),
      field(entity, "deleted_by" as any),
      "LEFT",
      { castRightTo: "text", castLeftTo: "text", alias: "deleter" }
    ),
  ];
}

/**
 * Enhanced version that allows selective joins (e.g., only creator and updater).
 * Useful when you only need specific audit fields to reduce query overhead.
 *
 * When `serviceEntity` is supplied (platform `service_registry` projection),
 * every actor column also joins it on `code = split_part(actor, ':', 2)` —
 * the `system:<code>` writer convention — so `<col>_name` resolves
 * `COALESCE(user.display_name, service.name)` and two verbatim verdict
 * projections feed the lazy-ref contract:
 * `<col>_ref_entity` (`'user_profile' | 'service_registry' | NULL` — NULL
 * for writers no join resolved, e.g. `migration-*`) and `<col>_ref_key`
 * (the resolved key). The verdict is JOIN-MATCH driven, not string-shaped:
 * whichever join found a row owns the ref.
 *
 * @param entity - The entity class implementing IAuditableEntity
 * @param userEntity - The user entity class (e.g. UserProfileEntity)
 * @param options - Configuration for which joins to include
 * @returns Array of Join expressions for selected audit fields
 */
export function buildAuditableJoinsSelective(
  entity: EntityClass,
  userEntity: EntityClass,
  options: {
    includeCreator?: boolean;
    includeUpdater?: boolean;
    includeDeleter?: boolean;
    /** `cloned_by` — the clone-write actor. Only `Clonable` entities carry
     *  the column; the caller gates on `isClonableEntity`. */
    includeCloner?: boolean;
    /** Platform service-registry ref entity — when present, `system:<code>`
     *  actors resolve to the service's `name` and a `service_registry`
     *  lazy-ref target. Absent → display/vocab keep the raw token. */
    serviceEntity?: EntityClass;
  } = {}
): ReturnType<typeof Join.on>[] {
  const joins: ReturnType<typeof Join.on>[] = [];
  const { includeCreator = true, includeUpdater = true, includeDeleter = true, includeCloner = false, serviceEntity } = options;
  const actorJoin = (col: "created_by" | "updated_by" | "deleted_by" | "cloned_by", alias: string) => {
    const svcAlias = `${alias}_svc`;
    const colSql = quoteIdent(getColumnName(entity, col));
    const userNameSql = renderDisplayTemplate(USER_DISPLAY_TEMPLATE, userEntity, alias);
    joins.push(
      Join.on(
        field(userEntity, "uuid" as any),
        field(entity, col as any),
        "LEFT",
        {
          castRightTo: "text",
          castLeftTo: "text",
          alias,
          display: {
            as: `${col}_name`,
            sql: serviceEntity !== undefined
              ? `COALESCE(${userNameSql}, ${quoteIdent(svcAlias)}."name")`
              : userNameSql,
          },
          projections: serviceEntity !== undefined
            ? [
                {
                  as: `${col}_ref_entity`,
                  sql:
                    `CASE WHEN ${quoteIdent(alias)}."uuid" IS NOT NULL THEN 'user_profile' ` +
                    `WHEN ${quoteIdent(svcAlias)}."code" IS NOT NULL THEN 'service_registry' END`,
                },
                {
                  as: `${col}_ref_key`,
                  sql:
                    `CASE WHEN ${quoteIdent(alias)}."uuid" IS NOT NULL THEN {self}.${colSql} ` +
                    `ELSE ${quoteIdent(svcAlias)}."code" END`,
                },
              ]
            : undefined,
        }
      )
    );
    if (serviceEntity !== undefined) {
      joins.push(
        Join.on(
          field(serviceEntity, "code" as any),
          field(entity, col as any),
          "LEFT",
          {
            alias: svcAlias,
            // `system:<code>` convention only — the CASE guard keeps any
            // other `x:<code>` actor (nats subjects, migration stamps)
            // from false-matching a registry row.
            rightExpr: `CASE WHEN {self}.${colSql} LIKE 'system:%' THEN split_part({self}.${colSql}, ':', 2) END`,
          }
        )
      );
    }
  };

  if (includeCreator) actorJoin("created_by", "creator");
  if (includeUpdater) actorJoin("updated_by", "updater");
  if (includeDeleter) actorJoin("deleted_by", "deleter");
  if (includeCloner) actorJoin("cloned_by", "cloner");

  return joins;
}

/**
 * Build LEFT JOIN + projections for audit trail entities (AuditLogEntity).
 *
 * Audit trail entities have a single `changed_by` column (not created_by/updated_by/deleted_by).
 * This function joins the user entity to resolve `changed_by` into `display_name` and `idp_code`.
 *
 * Uses `castRightTo: "uuid"` + `castLeftTo: "uuid"` to trigger the regex guardrail
 * (`changed_by ~ '^[0-9a-fA-F-]{36}$'`) automatically in renderJoins().
 * This prevents errors when `changed_by` contains non-UUID values like "system".
 *
 * Distinct from buildAuditableJoins() which uses castRightTo: "text" (no guardrail, text = text).
 * buildAuditTrailJoins() uses castRightTo: "uuid" + castLeftTo: "uuid" (guardrail + uuid = uuid).
 *
 * @param auditEntity - The audit trail entity class (e.g., AuditLogEntity)
 * @param userEntity - The user entity class (e.g., UserProfileRefEntity) with uuid, display_name, idp_code columns
 * @param baseTableRef - Quoted `"schema"."table"` ref of the audit table actually queried
 *   (callers query via `tableName` override — e.g. `"crm"."customers_audit"`); needed so the
 *   COALESCE fallback can qualify `changed_by` on the right table
 * @returns { joins, projections } — joins for the query, projections for display_name + idp_code
 */
export function buildAuditTrailJoins(
  auditEntity: EntityClass,
  userEntity: EntityClass,
  baseTableRef: string,
): { joins: JoinExpr[]; projections: FieldProjector[] } {
  const meta = getEntityPersistenceMeta(auditEntity);
  const changedByCol = meta.auditTrailChangedByColumn ?? "changed_by";
  const changedByColSql = quoteIdent(changedByCol);

  return {
    joins: [
      Join.on(
        field(userEntity, "uuid" as any),
        field(auditEntity, changedByCol as any),
        "LEFT",
        { castRightTo: "uuid", castLeftTo: "uuid", alias: "creator" },
      ),
      // `system:<code>` writers resolve through the platform registry —
      // the CASE guard keeps other `x:<code>` actors from false-matching.
      Join.on(
        field(ServiceRegistryRefEntity, "code" as any),
        field(auditEntity, changedByCol as any),
        "LEFT",
        { alias: "creator_svc", rightExpr: `CASE WHEN ${baseTableRef}.${changedByColSql} LIKE 'system:%' THEN split_part(${baseTableRef}.${changedByColSql}, ':', 2) END` },
      ),
    ],
    projections: [
      Project.expr(
        `COALESCE("creator"."display_name", "creator_svc"."name", ${baseTableRef}.${changedByColSql})`,
        "changed_by_display_name",
      ),
      Project.expr('"creator"."idp_code"', "changed_by_idp_code"),
    ],
  };
}
