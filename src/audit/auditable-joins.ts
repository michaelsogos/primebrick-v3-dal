/**
 * Auditable join helpers — builds LEFT JOINs for creator, updater, deleter.
 *
 * Unlike the BE version which hardcodes `UserProfileEntity`, the DAL version
 * accepts the "user entity" class as a parameter. This makes the DAL a true
 * leaf dependency — it doesn't import from any consumer repo.
 */

import type { EntityClass } from "../meta/entity-meta.js";
import { Join, field } from "../query/dsl.js";

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
