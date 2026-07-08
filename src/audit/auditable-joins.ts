/**
 * Auditable join helpers — builds LEFT JOINs for creator, updater, deleter.
 *
 * Unlike the BE version which hardcodes `UserProfileEntity`, the DAL version
 * accepts the "user entity" class as a parameter. This makes the DAL a true
 * leaf dependency — it doesn't import from any consumer repo.
 */

import type { EntityClass } from "../meta/entity-meta.js";
import { getEntityPersistenceMeta } from "../meta/entity-meta.js";
import { Join, field, Project } from "../query/dsl.js";
import type { JoinExpr, FieldProjector } from "../query/dsl.js";

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
  } = {}
): ReturnType<typeof Join.on>[] {
  const joins: ReturnType<typeof Join.on>[] = [];
  const { includeCreator = true, includeUpdater = true, includeDeleter = true } = options;

  if (includeCreator) {
    joins.push(
      Join.on(
        field(userEntity, "uuid" as any),
        field(entity, "created_by" as any),
        "LEFT",
        { castRightTo: "text", castLeftTo: "text", alias: "creator" }
      )
    );
  }

  if (includeUpdater) {
    joins.push(
      Join.on(
        field(userEntity, "uuid" as any),
        field(entity, "updated_by" as any),
        "LEFT",
        { castRightTo: "text", castLeftTo: "text", alias: "updater" }
      )
    );
  }

  if (includeDeleter) {
    joins.push(
      Join.on(
        field(userEntity, "uuid" as any),
        field(entity, "deleted_by" as any),
        "LEFT",
        { castRightTo: "text", castLeftTo: "text", alias: "deleter" }
      )
    );
  }

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
 * @param userEntity - The user entity class (e.g., UserProfileEntity) with uuid, display_name, idp_code columns
 * @returns { joins, projections } — joins for the query, projections for display_name + idp_code
 */
export function buildAuditTrailJoins(
  auditEntity: EntityClass,
  userEntity: EntityClass,
): { joins: JoinExpr[]; projections: FieldProjector[] } {
  const meta = getEntityPersistenceMeta(auditEntity);
  const changedByCol = meta.auditTrailChangedByColumn ?? "changed_by";

  return {
    joins: [
      Join.on(
        field(userEntity, "uuid" as any),
        field(auditEntity, changedByCol as any),
        "LEFT",
        { castRightTo: "uuid", castLeftTo: "uuid", alias: "creator" },
      ),
    ],
    projections: [
      Project.expr("creator.display_name", "changed_by_display_name"),
      Project.expr("creator.idp_code", "changed_by_idp_code"),
    ],
  };
}
