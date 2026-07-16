import "reflect-metadata";

import {
  Entity,
  Column,
  Key,
  AuditTrailEntity,
} from "../meta/entity-decorators.js";

/**
 * AuditLogEntity — generic audit trail entity.
 *
 * Maps to any audit table (customers_audit, organizations_audit, user_profiles_audit, etc.)
 * via the `tableName` override option on finders/writers.
 *
 * All audit tables share the same column structure:
 *   id          bigint identity PK
 *   entity_id   bigint (the audited entity's ID)
 *   entity_uuid uuid    (the audited entity's UUID)
 *   action      text    (INSERT, UPDATE, SOFT_DELETE, HARD_DELETE, RESTORE)
 *   changed_at  timestamptz
 *   changed_by  text    (actor UUID or "system")
 *   version     integer
 *   delta       jsonb   (field-level old/new diff)
 *
 * This entity has NO @AuditableField decorators → add() does not stamp audit fields.
 * This entity has NO @AuditTrail() → add() does not write audit-of-audit.
 * The `id` column is identity PK → add() drops it, DB auto-generates.
 *
 * Usage:
 *   repo.add(AuditLogEntity, { entity_id, entity_uuid, action, ... }, { tableName: "customers_audit" })
 *   repo.findByPage(AuditLogEntity, projections, { tableName: "organizations_audit", filters, ... })
 */
@Entity("audit_log")
@AuditTrailEntity({ changedByColumn: "changed_by" })
export class AuditLogEntity {
  @Key()
  @Column({ pgType: "bigint" })
  id!: bigint;

  @Column({ pgType: "bigint" })
  entity_id!: bigint;

  @Column({ pgType: "uuid" })
  entity_uuid!: string;

  @Column({ pgType: "text" })
  action!: string;

  @Column({ pgType: "timestamptz" })
  changed_at!: Date;

  @Column({ pgType: "text" })
  changed_by!: string;

  @Column({ pgType: "integer" })
  version!: number;

  @Column({ pgType: "jsonb", nullable: true })
  delta?: Record<string, { old: unknown; new: unknown }>;
}
