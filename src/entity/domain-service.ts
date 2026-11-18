/**
 * `DomainService<TEntity>` — the sanctioned BASE CLASS for every worker
 * service that owns one entity.
 *
 * Layer contract: `CONTROLLER → WORKER SERVICE → DAL lib → DB`. The service
 * reaches data ONLY through `this.svc` (the composed generic CRUD service —
 * the same object the entity-router uses: governed writes, `svc.list`
 * wire contract, `svc.query` code-authored DSL) and `this.svcFor` for
 * rare cross-entity handles. `this.dal` is PRIVATE — the raw gateway
 * surface is not part of the subclass API.
 *
 * A subclass IS an `EntityService` — it can be handed to an entity-router
 * unchanged, and it overrides whichever methods carry domain rules. The
 * constructor takes NO data-access arguments and does NO I/O: the Dal and
 * the composed service resolve lazily on first use, so constructing (or
 * importing) a service is always safe — `getDal()` still fails fast if a
 * method runs before bootstrap. Collaborators (other services) may still
 * be ctor-injected for tests; the DAL never is.
 *
 * `buildConfig()` is the subclass seam: override it to inject extra
 * `EntityServiceConfig` fields (auditPort, actor) at service resolution
 * time — inside the lazy path, so they may themselves use `this.dal`.
 * Display-name joins are NOT part of the seam — they are a platform
 * invariant (`public.user_profiles` via `UserProfileRefEntity`).
 *
 * Do NOT introduce per-entity `*Dal`/`*Repo` wrapper classes — custom
 * queries belong as methods on the owning service, using `this.svc.list`
 * (structured/wire-safe), `this.svc.query` (code-authored DSL escapes)
 * or `this.svcFor(Entity)`.
 */

import { getDal } from "../dal/dal.js";
import type { Dal } from "../dal/dal.js";
import {
  getDictFacet,
  getEntityPersistenceMeta,
  getRelationFacet,
  hasAuditTrail,
  isClonableEntity,
} from "../meta/entity-decorators.js";
import { isAuditableEntity } from "../repository/repository.js";
import { registerEntityService } from "./entity-registry.js";
import type { Repository } from "../repository/repository.js";
import type {
  BulkItem,
  BulkUpdateItem,
  DuplicateResult,
  EntityListQuery,
  EntityListResult,
  EntityService,
  EntityGetOptions,
  EntityServiceConfig,
} from "./entity-service.js";

export abstract class DomainService<TEntity extends Record<string, unknown>>
  implements EntityService<TEntity>
{
  private _dal: Dal | undefined;
  private _svc: EntityService<TEntity> | undefined;
  private _svcFor = new Map<unknown, EntityService<never>>();

  protected constructor(protected readonly cfg: EntityServiceConfig<TEntity>) {}

  /** The gateway singleton — fails fast if bootstrap hasn't run. Resolved
   *  on first use. PRIVATE by construction: service data access goes
   *  through `this.svc` (governed CRUD + `svc.list` wire contract +
   *  `svc.query` code-authored DSL) or `this.svcFor` — the raw Dal
   *  surface is not part of the subclass API. */
  private get dal(): Dal {
    return (this._dal ??= getDal());
  }

  /** The composed generic CRUD service — same machinery as the entity-router. */
  protected get svc(): EntityService<TEntity> {
    return (this._svc ??= this.dal.entityService(this.buildConfig()));
  }

  /** Governed `EntityService` handle for ANOTHER entity — memoized.
   *  Rare: collaborator services are the norm for cross-entity work;
   *  this exists for reads/lookups into a sibling entity where a full
   *  collaborator would be ceremony (config refs, display joins). */
  protected svcFor<T2 extends Record<string, unknown>>(
    entity: EntityServiceConfig<T2>["entity"],
  ): EntityService<T2> {
    let s = this._svcFor.get(entity);
    if (!s) {
      const filterableKeys = new Set(
        Object.values(getEntityPersistenceMeta(entity).columns).map((c) => c.propertyKey),
      );
      s = this.dal.entityService({
        entity,
        list: { filterableKeys },
      }) as EntityService<never>;
      this._svcFor.set(entity, s);
    }
    return s as unknown as EntityService<T2>;
  }

  /** The entity's `dict` facet when the class carries `@Dict` — the
   *  entity-router's assembleMeta injects it into the served meta. */
  get dictFacet() {
    return getDictFacet(this.cfg.entity);
  }

  /** The entity's `relation` facet when the class carries `@Relation` —
   *  the entity-router's assembleMeta injects it into the served meta. */
  get relationFacet() {
    return getRelationFacet(this.cfg.entity);
  }

  /** `@AuditTrail()` on the entity class — the entity HAS an audit-trail
   *  table. The router derives `collaboration.enabled` from this; never
   *  restated in the decl. */
  get auditable() {
    return hasAuditTrail(this.cfg.entity);
  }

  /** `Clonable` mixin on the entity class — clone-tracking columns exist,
   *  so `/duplicate` may register. Entities without it never expose the
   *  route: a clone with no tracking columns writes an untracked copy. */
  get clonable() {
    return isClonableEntity(this.cfg.entity);
  }

  /** Ref-display registration sink — the route layer (which is DAL-free
   *  and can't reach the registry directly) feeds the entity's
   *  materialized display template, derived from the SAME authored
   *  `decl.meta` that serves `/entities/{e}/meta`. Called once at route
   *  wiring — module-load time, so the registry is complete before any
   *  `svc` builds and before the first request. Plain
   *  `EntityServiceLike` facades simply don't carry it — duck-typed. */
  registerRefDisplay(display: string | null): void {
    registerEntityService({ entity: this.cfg.entity, display });
  }

  /**
   * Subclass seam for config enrichment (auditPort / actor / userEntity
   * injection). Runs once, inside the lazy `svc` resolution — `this.dal`
   * is available here.
   */
  protected buildConfig(): EntityServiceConfig<TEntity> {
    return this.cfg;
  }

  list(query: EntityListQuery): Promise<EntityListResult<TEntity>> {
    return this.svc.list(query);
  }
  get(uuid: string, options?: EntityGetOptions & { throwIfNotFound?: true }): Promise<TEntity>;
  get(uuid: string, options: EntityGetOptions & { throwIfNotFound: false }): Promise<TEntity | null>;
  get(uuid: string, options?: EntityGetOptions): Promise<TEntity | null> {
    return this.svc.get(uuid, options as never);
  }
  exists(options?: import("../types/types.js").FindOptions): Promise<boolean> {
    return this.svc.exists(options);
  }
  query<TResult = TEntity>(
    fields?: import("../query/dsl.js").FieldProjector[] | null,
    options?: import("../types/types.js").FindOptions,
  ): Promise<TResult[]> {
    return this.svc.query<TResult>(fields, options);
  }
  find<TResult = TEntity>(
    fields?: import("../query/dsl.js").FieldProjector[] | null,
    options?: import("../types/types.js").FindOptions,
  ): Promise<TResult | null> {
    return this.svc.find<TResult>(fields, options);
  }
  create(body: Record<string, unknown>, tx?: Repository): Promise<TEntity> {
    return this.svc.create(body, tx);
  }
  update(
    uuid: string,
    body: Record<string, unknown> & { version: number },
    tx?: Repository,
  ): Promise<TEntity> {
    return this.svc.update(uuid, body, tx);
  }
  delete(uuid: string, version: number): Promise<TEntity> {
    return this.svc.delete(uuid, version);
  }
  restore(uuid: string, version: number): Promise<TEntity> {
    return this.svc.restore(uuid, version);
  }
  purge(uuid: string, version: number): Promise<TEntity> {
    return this.svc.purge(uuid, version);
  }
  duplicate(uuids: string[]): Promise<DuplicateResult> {
    return this.svc.duplicate(uuids);
  }
  bulkDelete(items: BulkItem[]): Promise<unknown> {
    return this.svc.bulkDelete(items);
  }
  bulkRestore(items: BulkItem[]): Promise<unknown> {
    return this.svc.bulkRestore(items);
  }
  bulkUpdate(items: BulkUpdateItem[]): Promise<unknown> {
    return this.svc.bulkUpdate(items);
  }
  bulkPurge(items: BulkItem[]): Promise<unknown> {
    return this.svc.bulkPurge(items);
  }
  transaction<T>(
    fn: (tx: Repository) => Promise<T>,
    options?: import("../types/types.js").TimeoutOverrideOptions,
  ): Promise<T> {
    return this.svc.transaction(fn, options);
  }
  beginTransaction(
    options?: import("../types/types.js").TimeoutOverrideOptions,
  ): import("../dal/deferred-transaction.js").DeferredTransaction {
    return this.svc.beginTransaction(options);
  }
  audit(uuid: string, page: number, limit: number): Promise<unknown> {
    return this.svc.audit(uuid, page, limit);
  }
  /** Vocabulary feed for `options_source:"audit.actors"` — present ONLY
   *  when the entity stamps audit columns (`Auditable` mixin). The
   *  entity-router registers `/audit-actors` on this capability's
   *  presence, so presence must be provable WITHOUT touching `this.svc`
   *  (the DAL resolves lazily — dereferencing it at route-registration
   *  time crashes the boot). The call itself still resolves lazily. */
  get auditActors() {
    if (!isAuditableEntity(getEntityPersistenceMeta(this.cfg.entity))) return undefined;
    return () => this.svc.auditActors!();
  }
  stream(query: EntityListQuery): AsyncGenerator<TEntity> {
    return this.svc.stream(query);
  }
}
