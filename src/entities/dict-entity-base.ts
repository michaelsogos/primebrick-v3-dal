import "reflect-metadata";

import {
  Entity,
  Column,
  Key,
  Unique,
  AuditTrail,
  Dict,
} from "../meta/entity-decorators.js";
import { Auditable, Deletable, EntityBase } from "./entity-base.js";
import type { UUID } from "../types/uuid.js";

/**
 * DictEntityBase — standard dictionary/enum-table entity.
 *
 * Every Primebrick dict table (lookup/enum vocabularies: customer_types,
 * contact_types, account_kinds…) extends this base to get the shared
 * column set without copy-paste AND the `@Dict` marker — the class-level
 * flag that propagates through the prototype chain (`collectMetaChain`
 * parent-first, subclass wins) so `getDictFacet(ConcreteEntity)` resolves
 * it without ever instantiating. The served meta `dict` facet and the
 * `kind:"dict"` page archetype derive from this ONE declaration point.
 *
 * Columns carried by the base:
 *   uuid  uuid PK (uuidv7) — wire uid AND row identity
 *   code  varchar(50) NOT NULL UNIQUE — stable business key
 *   sort  int NOT NULL — dictionary ordering (order_field convention)
 *
 * `label_key` is deliberately NOT on the base: ISO/seed-managed dicts
 * (legal_forms) carry `name_local` as their label instead — declare
 * `label_key` per-entity when the rows are i18n-keyed.
 *
 * The consumer creates a concrete subclass:
 *   @Entity("customer_types", "crm")
 *   @Cached(300_000)              // sdk-side decorator — stays per-class
 *   export class CustomerTypeEntity extends DictEntityBase {}
 *   // + extras: label_key, value_kind, category, min_size, …
 *
 * ConfigEntityBase remains its own base (divergent `key`/`value`/`type`
 * columns); re-basing it onto DictEntityBase — with the `key`→`code`
 * rename — is the config-entry migration step's decision.
 *
 * This class is DB-agnostic — it does NOT import from @primebrick/sdk.
 */
@Entity("dict")
@AuditTrail()
@Dict()
export abstract class DictEntityBase
  extends Deletable(Auditable(EntityBase)) {
  @Key()
  @Column({ pgType: "uuid" })
  uuid!: UUID;

  /** Stable business key (e.g. "private", "email"). Unique per table. */
  @Unique()
  @Column({ length: 50, nullable: false })
  code!: string;

  /** Dictionary ordering — the `order_field` convention the dict page's
   *  reorder CTAs mutate; persists through the atomic bulk save. */
  @Column({ pgType: "int4", nullable: false })
  sort!: number;
}
