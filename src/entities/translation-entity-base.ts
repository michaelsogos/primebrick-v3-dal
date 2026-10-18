import "reflect-metadata";

import {
  Entity,
  Column,
  Key,
  Unique,
  AuditTrail,
} from "../meta/entity-decorators.js";
import { Auditable, Deletable, EntityBase } from "./entity-base.js";

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
 * Composite unique: (key, language) — non-partial index: a soft-deleted row
 * still reserves the key; recreating it surfaces a conflict (ERR05 → restore),
 * never a deleted+live duplicate.
 *
 * Plus standard audit columns (created_at/by, updated_at/by, version, deleted_at/by).
 */
@Entity("translations")
@AuditTrail()
export abstract class TranslationEntityBase
  extends Deletable(Auditable(EntityBase)) {
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
}
