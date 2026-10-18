import {
  AuditableField,
  AuditableFieldType,
  DeletableField,
  DeletableFieldType,
} from "../meta/entity-decorators.js";
import type { IAuditableEntity, IDeletableEntity } from "../types/entities.js";

/**
 * Entity capability mixins — declare shared audit/deletable columns ONCE,
 * compose them per-entity instead of copy-pasting decorated fields.
 *
 * Auditable and deletable are ORTHOGONAL capabilities:
 *   - audit-only  (hard delete): `class ApiKey extends Auditable(EntityBase)`
 *   - delete-only:               `class Tag extends Deletable(EntityBase)`
 *   - both (soft delete):        `class Customer extends Deletable(Auditable(EntityBase))`
 *   - neither:                   `class Telemetry extends EntityBase`
 *
 * The concrete entity still owns `@Entity(table)` and the opt-in
 * `@AuditTrail()` (audit-log table — separate decision from audit columns).
 * Field decorators on each anonymous mixin class register on that
 * constructor; `getEntityPersistenceMeta` merges the whole prototype chain
 * parent-first (see collectMetaChain), so subclass fields always win.
 *
 * Extra per-entity capabilities (`IExposableEntity`, `IClonableEntity`, …)
 * keep their `implements` on the concrete class — they are pure type
 * contracts, not column sets.
 */
export type EntityCtor = abstract new (...args: any[]) => object;

/** Composition root — empty on purpose. `extends Mixin(EntityBase)`. */
export abstract class EntityBase {}

/**
 * Adds created_at / created_by / updated_at / updated_by / version
 * (optimistic-lock column). Does NOT add soft-delete — compose `Deletable`
 * when the entity needs it.
 */
export function Auditable<TBase extends EntityCtor>(Base: TBase) {
  abstract class AuditableEntity extends Base implements IAuditableEntity {
    @AuditableField(AuditableFieldType.CREATED_AT)
    created_at!: Date;

    @AuditableField(AuditableFieldType.CREATED_BY)
    created_by!: string;

    @AuditableField(AuditableFieldType.UPDATED_AT)
    updated_at!: Date;

    @AuditableField(AuditableFieldType.UPDATED_BY)
    updated_by!: string;

    @AuditableField(AuditableFieldType.VERSION)
    version!: number;
  }
  return AuditableEntity;
}

/** Adds deleted_at / deleted_by — soft-delete markers. */
export function Deletable<TBase extends EntityCtor>(Base: TBase) {
  abstract class DeletableEntity extends Base implements IDeletableEntity {
    @DeletableField(DeletableFieldType.DELETED_AT)
    deleted_at?: Date;

    @DeletableField(DeletableFieldType.DELETED_BY)
    deleted_by?: string;
  }
  return DeletableEntity;
}
