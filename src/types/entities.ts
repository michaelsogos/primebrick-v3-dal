/** Entity has a public UUID safe to expose outside the system. */
export interface IExposableEntity {
  uuid: string;
}

/** Entity supports soft-delete (deleted_at / deleted_by). */
export interface IDeletableEntity {
  deleted_at?: Date;
  deleted_by?: string;
}

/**
 * Entity has audit stamps (created_at/by, updated_at/by, version).
 * Does NOT imply soft-delete — auditable and deletable are independent
 * capabilities; compose with `IAuditableEntity & IDeletableEntity` where
 * both are required (the Dal write-path signatures already do this).
 */
export interface IAuditableEntity {
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
  version: number;
}

/** Entity supports cloning (cloned_from stores UUID of source record). */
export interface IClonableEntity {
  cloned_from?: string;
}
