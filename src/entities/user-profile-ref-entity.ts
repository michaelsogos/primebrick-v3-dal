import "reflect-metadata";

import { Column, Entity, Key, Unique } from "../meta/entity-decorators.js";

/**
 * `UserProfileRefEntity` — read-only projection of the platform identity
 * table `public.user_profiles`, owned by the DAL so the auditable
 * display-name join is a STATIC, hardcoded statement: every auditable
 * entity read (list/get/stream/audit) LEFT JOINs this table and projects
 * `display_name` / `idp_code` — no consumer config, no per-service entity.
 *
 * `public` is a cross-app platform domain (like `custom`), not a module
 * domain: `user_profiles` is exempted from the schema-domain check via the
 * built-in `PLATFORM_SHARED_TABLES` set in `schema-domain.ts`, so the join
 * resolves legally from every service domain.
 *
 * This is NOT `UserProfileEntity`: the full entity — Casdoor sync, all
 * columns, CRUD + routes — stays owned by the backend. Only the three
 * columns the auditable join needs are projected here.
 */
@Entity("user_profiles", "public")
export class UserProfileRefEntity {
  @Key()
  @Column({ pgType: "bigint" })
  id!: bigint;

  @Unique()
  @Column({ pgType: "uuid" })
  uuid!: string;

  @Column({ length: 255, nullable: false })
  idp_code!: string;

  @Column({ length: 255, nullable: true })
  display_name?: string;
}
