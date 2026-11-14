import "reflect-metadata";

import { Column, Entity, Key, Unique } from "../meta/entity-decorators.js";

/**
 * `ServiceRegistryRefEntity` — read-only projection of the platform
 * registry table `public.service_registry`, owned by the DAL so any
 * service may legally join the module-identity source (e.g. a schedule
 * resolving its service armer for display).
 *
 * `public` is a cross-app platform domain (like `custom`), not a module
 * domain: `service_registry` is exempted from the schema-domain check via
 * the built-in `PLATFORM_SHARED_TABLES` set in `schema-domain.ts`, so the
 * join resolves legally from every service domain — the same contract
 * `UserProfileRefEntity` enjoys for `public.user_profiles`.
 *
 * This is NOT `ServiceRegistryEntity`: the full entity — registration
 * lifecycle, all columns, admin routes — stays owned by the backend
 * (`/api/v1/system/services`). Only the three columns an identity join
 * needs are projected here.
 */
@Entity("service_registry", "public")
export class ServiceRegistryRefEntity {
  @Key()
  @Column({ pgType: "uuid" })
  uuid!: string;

  @Unique()
  @Column({ length: 100, nullable: false })
  code!: string;

  @Column({ nullable: true })
  name?: string;
}
