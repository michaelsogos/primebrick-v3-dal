/**
 * `DomainService<TEntity>` — the sanctioned BASE CLASS for every worker
 * service that owns one entity.
 *
 * Layer contract: `CONTROLLER → WORKER SERVICE → DAL lib → DB`. The service
 * reaches data ONLY through `this.dal` (the process singleton — initialized
 * once at bootstrap by the consumer's `initDal()`) and `this.svc` (the
 * composed generic CRUD service — the same object the entity-router uses).
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
 * `EntityServiceConfig` fields (auditPort, actor, userEntity) at service
 * resolution time — inside the lazy path, so they may themselves use
 * `this.dal`.
 *
 * Do NOT introduce per-entity `*Dal`/`*Repo` wrapper classes — custom
 * queries belong as methods on the owning service, using `this.dal.*`
 * proxies (find/add/update/findByPage/transaction…).
 */

import { getDal } from "../dal/dal.js";
import type { Dal } from "../dal/dal.js";
import type { Repository } from "../repository/repository.js";
import type {
  BulkItem,
  DuplicateResult,
  EntityListQuery,
  EntityListResult,
  EntityService,
  EntityServiceConfig,
} from "./entity-service.js";

export abstract class DomainService<TEntity extends Record<string, unknown>>
  implements EntityService<TEntity>
{
  private _dal: Dal | undefined;
  private _svc: EntityService<TEntity> | undefined;

  protected constructor(protected readonly cfg: EntityServiceConfig<TEntity>) {}

  /** The gateway singleton — fails fast if bootstrap hasn't run. Resolved on first use. */
  protected get dal(): Dal {
    return (this._dal ??= getDal());
  }

  /** The composed generic CRUD service — same machinery as the entity-router. */
  protected get svc(): EntityService<TEntity> {
    return (this._svc ??= this.dal.entityService(this.buildConfig()));
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
  get(uuid: string): Promise<TEntity> {
    return this.svc.get(uuid);
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
  audit(uuid: string, page: number, limit: number): Promise<unknown> {
    return this.svc.audit(uuid, page, limit);
  }
  stream(query: EntityListQuery): AsyncGenerator<TEntity> {
    return this.svc.stream(query);
  }
}
