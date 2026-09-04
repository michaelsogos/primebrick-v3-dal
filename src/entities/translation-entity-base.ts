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
 * TranslationEntityBase — standard i18n translations table entity.
 *
 * Schema = module boundary. Each module creates a concrete subclass with its
 * own schema. The DAL's Repository resolves the schema natively via
 * getQualifiedTableName(entity) — no raw SQL, no string interpolation.
 *
 * BE creates entity classes for all modules it manages:
 *   @Entity("translations", "public")
 *   export class AppTranslationEntity extends TranslationEntityBase {}
 *
 *   @Entity("translations", "system")
 *   export class SystemTranslationEntity extends TranslationEntityBase {}
 *
 *   @Entity("translations", "emailsender")
 *   export class EmailsenderTranslationEntity extends TranslationEntityBase {}
 *
 * The BE's central CRUD handler maps module code → entity class → Repository.
 * US microservices do NOT create entity classes — the BE manages their schemas.
 *
 * Columns:
 *   key       varchar(255) NOT NULL — full dot-path (e.g. 'app.auth.login.title')
 *   language  varchar(10)  NOT NULL — BCP 47 tag (e.g. 'it-IT')
 *   value     text         NOT NULL — translated string
 *
 * Composite unique: (key, language) — partial index WHERE deleted_at IS NULL.
 *
 * Plus standard audit columns (created_at/by, updated_at/by, version, deleted_at/by).
 */
@Entity("translations")
@AuditTrail()
export abstract class TranslationEntityBase implements IAuditableEntity {
  @Key()
  @Column({ pgType: "bigint" })
  id!: bigint;

  @Unique()
  @Column({ pgType: "uuid" })
  uuid!: string;

  /** Full dot-path translation key (e.g. 'app.auth.login.title'). */
  @Unique("translations_key_language_uidx", 0)
  @Column({ length: 255, nullable: false })
  key!: string;

  /** BCP 47 language tag (e.g. 'it-IT', 'en-GB'). */
  @Unique("translations_key_language_uidx", 1)
  @Column({ length: 10, nullable: false })
  language!: string;

  /** Translated string value. */
  @Column({ nullable: false })
  value!: string;

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
