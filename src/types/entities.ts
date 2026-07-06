/** Entity has a public UUID safe to expose outside the system. */
export interface IExposableEntity {
  uuid: string;
}

/** Entity supports soft-delete (deleted_at / deleted_by). */
export interface IDeletableEntity {
  deleted_at?: Date;
  deleted_by?: string;
}

/** Entity has full audit trail (created_at/by, updated_at/by, version) + soft-delete. */
export interface IAuditableEntity extends IDeletableEntity {
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
