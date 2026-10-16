import "reflect-metadata";

import {
  Entity,
  Column,
  Key,
  Unique,
  AuditableField,
  AuditableFieldType,
  DeletableField,
  DeletableFieldType,
  AuditTrail,
} from "../meta/entity-decorators.js";
import type { IAuditableEntity } from "../types/entities.js";

/**
 * ConfigEntityBase — standard dictionary-style config table entity.
 *
 * Every Primebrick config table (BE `auth_configurations`, microservice `config`)
 * extends this base class to get the standard column set without copy-paste.
 *
 * Columns:
 *   key            varchar(100) NOT NULL UNIQUE — stable snake_case setting key
 *   value          text nullable                 — raw TEXT; null = "not set"
 *   type           varchar(50)  NOT NULL         — ConfigType (drives SDK coercion + FE widget)
 *   type_config    text nullable                 — JSONB-text extra per-type config (badge values, list API URL, etc.)
 *   label_key      varchar(100) nullable         — i18n key for the setting title
 *   description_key varchar(100) nullable        — i18n key for the explanatory text
 *   reserved       boolean NOT NULL DEFAULT false — if true: editable but not deletable
 *   group_key      varchar(100) nullable         — UI grouping key (null/empty = ungrouped, top of list)
 *
 * Plus standard audit columns (created_at/by, updated_at/by, version, deleted_at/by).
 *
 * The consumer creates a concrete subclass:
 *   @Entity("config", "public")
 *   export class ConfigEntryEntity extends ConfigEntityBase {}
 *
 * This class is DB-agnostic — it does NOT import from @primebrick/sdk.
 * The SDK's IConfigEntity interface mirrors the field names for port-level use.
 */
@Entity("config")
@AuditTrail()
export abstract class ConfigEntityBase implements IAuditableEntity {
  @Key()
  @Column({ pgType: "bigint" })
  id!: bigint;

  @Unique()
  @Column({ pgType: "uuid" })
  uuid!: string;

  /** Unique config key (e.g. "oidc_issuer_url", "enable_mfa"). Never renamed after release. */
  @Unique()
  @Column({ length: 100, nullable: false })
  key!: string;

  /** Raw TEXT value. null means "the row exists but the value is not set". */
  @Column({ nullable: true })
  value!: string | null;

  /** Config value type — drives SDK coercion and FE widget selection. */
  @Column({ length: 50, nullable: false })
  type!: string;

  /** JSONB-text extra per-type configuration (e.g. badge inline values, list API URL). */
  @Column({ nullable: true })
  type_config?: string | null;

  /** i18n key for the setting title. */
  @Column({ length: 100, nullable: true })
  label_key?: string;

  /** i18n key for the explanatory description. */
  @Column({ length: 100, nullable: true })
  description_key?: string;

  /** If true, the row is system-critical: editable but not deletable. */
  @Column({ pgType: "boolean", nullable: false, defaultSql: "false" })
  reserved!: boolean;

  /** Optional grouping key for UI display. null/empty = ungrouped (top of list). */
  @Column({ length: 100, nullable: true })
  group_key?: string | null;

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

  @DeletableField(DeletableFieldType.DELETED_AT)
  deleted_at?: Date;

  @DeletableField(DeletableFieldType.DELETED_BY)
  deleted_by?: string;
}
