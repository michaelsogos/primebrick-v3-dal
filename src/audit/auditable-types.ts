/**
 * TypeScript utility types for auditable entities.
 * These types add display name fields to row types for entities that implement IAuditableEntity.
 */

/**
 * Adds display name fields to a row type for auditable entities.
 * Use this to type the result of queries that include auditable joins.
 */
export type WithAuditableDisplayNames<T> = T & {
  created_by_name?: string;
  updated_by_name?: string;
  deleted_by_name?: string;
};

/** Adds only creator display name (for cases where you only need created_by). */
export type WithCreatorDisplayName<T> = T & {
  created_by_name?: string;
};

/** Adds only updater display name (for cases where you only need updated_by). */
export type WithUpdaterDisplayName<T> = T & {
  updated_by_name?: string;
};
