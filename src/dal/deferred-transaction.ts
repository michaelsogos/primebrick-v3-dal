/**
 * Deferred fluent transaction — `dal.beginTransaction()`.
 *
 * Repository-shaped buffer: `tx.add(entity, row)` / `tx.update(entity, u)` /
 * `tx.delete(entity, match)` / `tx.find(entity, …)` queue operations WITHOUT
 * touching the pool. `commit()` compiles every buffered statement into ONE
 * data-modifying CTE chain and executes it as a single parameterized
 * statement — atomicity comes from PostgreSQL itself (a single statement is
 * an implicit transaction: no BEGIN/COMMIT/ROLLBACK, no rollback path).
 *
 * Each op's existing single-statement shape (`WITH guard/matched/raised…,
 * w AS (UPDATE … RETURNING) SELECT * FROM w`) is captured at buffer time by
 * running the real `Repository` against a rejecting queryable — the compiled
 * SQL is therefore *identical* to the direct-execution path (same guards,
 * same params, same RETURNING). At commit, per-op CTE branches are namespaced
 * (`s0_matched`, `s0_guard`, …), each op's terminal SELECT is wrapped as
 * `__rN AS (…)`, and the final SELECT aggregates every branch as
 * `jsonb_agg(to_jsonb(…))` columns. Params are renumbered into one global
 * `$n` space.
 *
 * Inter-op data flow — `Deferred<T>.ref("field")` produces a
 * `DeferredFieldRef` marker; when a later op's payload/match value carries
 * the marker, its `$n` placeholder is rewritten to a scalar subquery
 * `(SELECT "field" FROM "__rN")` reading the earlier branch's RETURNING row
 * (server-side, fully typed — no JSON fidelity loss). Refs may only point at
 * EARLIER ops (PG CTEs reference backward).
 *
 * Atomic zero-row abort — ops that must write/read exactly one row
 * (`update`/`delete`/`restore`/`hardDelete`, `add` in raise mode, `find*` with
 * `throwIfNotFound`) get an in-statement abort branch:
 * `WHERE NOT EXISTS (SELECT 1 FROM "__abN")` → `pg_raise(ERR01|ERR03|ERR04)`.
 * `matched` (always emitted by write ops) disambiguates ERR01 (row exists,
 * version stale) from ERR03 (row gone), like the direct path.
 *
 * Limits (v1, enforced eagerly):
 * - No `options.audit` — the audit delta needs the pre-write row read, which
 *   cannot be deferred; keep `dal.transaction(fn)` for audited writes.
 * - No `*Many`/`clone`/`truncate` — they are internally multi-statement
 *   (own tx) or non-CTE. `findAll` with `stream: true` is rejected too.
 * - No mid-flow reads: buffered values are unknowable before commit — express
 *   data flow with `ref()` or SQL-side conditions (`WHERE EXISTS (…)`).
 *   Genuinely conditional TS logic stays in `dal.transaction(fn)`.
 * - Sibling branches see the SAME snapshot — a later op cannot `find` what an
 *   earlier buffered write inserted; carry values via `ref()` instead.
 * - Result rows cross the statement boundary as jsonb → rehydrated by entity
 *   meta (bigint → BigInt, date-like → Date, jsonb/arrays native). `bytea`
 *   and high-precision `numeric` inside RETURNING lose wire fidelity —
 *   acceptable (same limits as JSON transport); use `dal.transaction` if a
 *   write must return those columns.
 */

import type { QueryResult } from "pg";

import type { EntityClass } from "../meta/entity-meta.js";
import { getColumnName, getEntityPersistenceMeta } from "../meta/entity-meta.js";
import type { EntityPersistenceMeta } from "../meta/entity-decorators.js";
import {
  columnHintsFromMetaColumn,
  effectivePgStorageType,
  pgValueToJsValue,
} from "../meta/column-pg-io.js";
import type { FieldProjector, FieldRef } from "../query/dsl.js";
import { quoteIdent } from "../query/query-builder.js";
import {
  Repository,
  REPO_INTERNAL,
  buildReturningClause,
  pickReturningRow,
  type Queryable,
} from "../repository/repository.js";
import type {
  AuditableWriteOptions,
  FindByIdOptions,
  FindByUUIDOptions,
  FindOptions,
  MatchByOptions,
  PaginatedEntity,
  VectorSearchOptions,
  WriteOptions,
} from "../types/types.js";
import { DalErrorCodes } from "../errors/error-codes.js";
import { ValidationError } from "../errors/errors.js";
import type { IAuditableEntity, IDeletableEntity } from "../types/entities.js";

// ─── Deferred handles ───────────────────────────────────────────────────────

/**
 * Opaque marker produced by `Deferred.ref("field")` — embeddable in a later
 * op's payload/match values. At compile time the `$n` it would occupy is
 * rewritten to `(SELECT "field" FROM "__rN")` over the source op's RETURNING
 * branch. Never a bound parameter — survives `jsValueToPgParam` untouched.
 */
export class DeferredFieldRef<V = unknown> {
  private readonly __deferredFieldRefBrand!: V;

  /** @internal */
  constructor(
    /** @internal */ readonly opIndex: number,
    /** @internal */ readonly field: string,
  ) {}
}

/**
 * Handle for a buffered operation's future result. NOT a Promise — awaiting
 * it pre-commit would deadlock (commit is never reached), so it deliberately
 * exposes no `then`. Read `.value` only after `await tx.commit()`.
 */
export class Deferred<T> {
  private readonly __deferredBrand!: T;

  private _settled = false;
  private _value: T | undefined;
  private _error: unknown;

  /** @internal */
  constructor(
    /** @internal */ readonly opIndex: number,
  ) {}

  /** Reference a RETURNING/SELECT column of this op for use in a LATER op. */
  ref<K extends keyof T & string>(field: K): DeferredFieldRef<T[K]> {
    return new DeferredFieldRef<T[K]>(this.opIndex, field);
  }

  /** True once commit() resolved (or rejected) this op. */
  get settled(): boolean {
    return this._settled;
  }

  /** The materialized op result — throws if accessed before commit settles it. */
  get value(): T {
    if (!this._settled) {
      throw new ValidationError(
        "Deferred.value accessed before commit() — buffered ops materialize only after the transaction statement succeeds",
      );
    }
    if (this._error !== undefined) throw this._error;
    return this._value as T;
  }

  /** @internal */
  _resolve(v: T): void {
    this._settled = true;
    this._value = v;
  }

  /** @internal */
  _reject(e: unknown): void {
    this._settled = true;
    this._error = e;
  }
}

// ─── Statement capture ─────────────────────────────────────────────────────

type CapturedSql = { text: string; values: unknown[] };

/**
 * Sentinel rejection used to halt a Repository method at its `db.query` call
 * — carries the fully-built statement. Not an error condition.
 */
class CaptureSignal extends Error {
  constructor(readonly sql: CapturedSql) {
    super("__deferred_capture__");
    this.name = "CaptureSignal";
  }
}

type DeferredOpKind =
  | "add"
  | "update"
  | "delete"
  | "restore"
  | "hardDelete"
  | "find"
  | "findByUUID"
  | "findById"
  | "findAll"
  | "findByPage"
  | "count"
  | "vectorSearch";

const WRITE_KINDS: ReadonlySet<DeferredOpKind> = new Set([
  "add",
  "update",
  "delete",
  "restore",
  "hardDelete",
]);

interface DeferredOp {
  index: number;
  kind: DeferredOpKind;
  entity: EntityClass;
  entityName: string;
  /** Resolves to the captured statement; rejects on build-time errors. */
  captured: Promise<CapturedSql>;
  deferred: Deferred<unknown>;
  /** Emitted output keys (RETURNING aliases / SELECT aliases) — ref validation. */
  emittedKeys(): Set<string>;
  /** Post-merge result shaping (rehydrate + pick). */
  finalize(rows: Array<Record<string, unknown>>): unknown;
  /** Abort spec: emit a pg_raise guard when the branch yields zero rows. */
  abort: { kind: "matched" } | { kind: "fixed"; code: string } | null;
}

// ─── SQL merge helpers ─────────────────────────────────────────────────────

const CTE_HEAD_RE = /^\s*([A-Za-z_]\w*)\s+AS\s*(?:NOT\s+MATERIALIZED\s+|MATERIALIZED\s+)?\(/i;

/**
 * Split a builder-produced statement into its top-level `WITH` branch list
 * and the terminal statement. Paren-balanced and string-literal aware
 * (`'…''…'`, `"…"`, `--` and `\/\*` comments). Returns `{ ctes: [], tail }`
 * for statements without a WITH clause.
 */
function splitTopLevelCtes(text: string): { ctes: { name: string; sql: string }[]; tail: string } {
  const m = /^\s*WITH\s/i.exec(text);
  if (!m) return { ctes: [], tail: text };

  const len = text.length;
  const skipWs = (p: number): number => {
    while (p < len) {
      const ch = text[p];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { p++; continue; }
      if (ch === "-" && text[p + 1] === "-") { while (p < len && text[p] !== "\n") p++; continue; }
      if (ch === "/" && text[p + 1] === "*") { const e = text.indexOf("*/", p + 2); p = e === -1 ? len : e + 2; continue; }
      break;
    }
    return p;
  };

  const ctes: { name: string; sql: string }[] = [];
  let pos = m[0].length;

  for (;;) {
    pos = skipWs(pos);
    const start = pos;
    const head = CTE_HEAD_RE.exec(text.slice(pos));
    if (!head) break;
    const name = head[1];
    pos += head[0].length - 1; // land on the opening '('
    let depth = 0;
    for (; pos < len; pos++) {
      const ch = text[pos];
      if (ch === "'") {
        pos++;
        while (pos < len && text[pos] !== "'") pos++;
        if (text[pos + 1] === "'") pos++; // '' escape — loop keeps scanning
        continue;
      }
      if (ch === '"') {
        pos++;
        while (pos < len && text[pos] !== '"') pos++;
        continue;
      }
      if (ch === "-" && text[pos + 1] === "-") { while (pos < len && text[pos] !== "\n") pos++; continue; }
      if (ch === "/" && text[pos + 1] === "*") { const e = text.indexOf("*/", pos + 2); pos = e === -1 ? len : e + 1; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) { pos++; break; }
      }
    }
    ctes.push({ name, sql: text.slice(start, pos) });
    pos = skipWs(pos);
    if (text[pos] === ",") { pos++; continue; }
    break;
  }
  return { ctes, tail: text.slice(pos) };
}

/** Rename builder-emitted CTE names with an op-scoped prefix (`w` → `s1_w`). */
function renameCtes(fragment: string, names: readonly string[], ns: string): string {
  let out = fragment;
  for (const n of names) {
    out = out.replace(new RegExp(`\\b${n}\\b`, "g"), `${ns}${n}`);
  }
  return out;
}

/**
 * Renumber `$n` placeholders into the global merged param space. A param
 * whose bound value is a `DeferredFieldRef` is replaced in-place by a scalar
 * subquery over the source op's `__rN` branch (validated: backward-only and
 * the field must be emitted by the source op).
 */
function remapParams(
  text: string,
  localValues: readonly unknown[],
  mergedValues: unknown[],
  opIndex: number,
  ops: readonly DeferredOp[],
  indexMap: Map<number, number>,
): string {
  return text.replace(/\$(\d+)/g, (_match, num: string) => {
    const n = Number(num);
    const v = localValues[n - 1];
    if (v instanceof DeferredFieldRef) {
      if (v.opIndex >= opIndex) {
        throw new ValidationError(
          `beginTransaction: ref("${v.field}") targets op ${v.opIndex} — refs only resolve to EARLIER buffered ops`,
        );
      }
      const src = ops[v.opIndex];
      if (!src.emittedKeys().has(v.field)) {
        throw new ValidationError(
          `beginTransaction: ref("${v.field}") is not emitted by op ${v.opIndex} (${src.entityName}.${src.kind}) — add it to 'returning'/'fields'`,
        );
      }
      return `(SELECT ${quoteIdent(v.field)} FROM ${quoteIdent(`__r${v.opIndex}`)} LIMIT 1)`;
    }
    // Same local index → same global index. Builders deliberately share a
    // `$n` across CTEs (e.g. `matched`/`guard`/`upd` all reference the match
    // params) — duplicating it would leave the polymorphic-only occurrences
    // (jsonb_build_object) without an inferable type → PG 42P18.
    let gi = indexMap.get(n);
    if (gi === undefined) {
      mergedValues.push(v);
      gi = mergedValues.length;
      indexMap.set(n, gi);
    }
    return `$${gi}`;
  });
}

// ─── Rehydration (jsonb → wire-faithful JS values) ─────────────────────────

function rehydrateValue(v: unknown, col: EntityPersistenceMeta["columns"][string]): unknown {
  if (v === null || v === undefined) return v;
  const h = columnHintsFromMetaColumn(col);
  const stor = effectivePgStorageType(h);
  // jsonb encodes bigint as a JSON number — restore native BigInt like the
  // INT8 wire parser does.
  if (/^bigint$|^int8$|^bigserial$/.test(stor)) {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" || typeof v === "string") return BigInt(v);
    return v;
  }
  return pgValueToJsValue(v, h);
}

function rehydrateRow(
  meta: EntityPersistenceMeta,
  propToSql: Map<string, string>,
  rowKeyToSqlName: Map<string, string> | null,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const sqlName = rowKeyToSqlName?.get(k) ?? meta.columns[k]?.sqlName ?? propToSql.get(k) ?? k;
    const col = meta.columns[sqlName];
    out[k] = col ? rehydrateValue(v, col) : v;
  }
  return out;
}

/** Escape a JS string as a single-quoted SQL literal (same as repository's). */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

type WriteRet = { visibleKeys: string[]; rowKeyToSqlName: Map<string, string> };

function singleRowFinalizer() {
  return (
    rows: Array<Record<string, unknown>>,
    ret: WriteRet,
    meta: EntityPersistenceMeta,
    propToSql: Map<string, string>,
  ): unknown => {
    const raw = rows[0];
    if (raw === undefined) return undefined;
    return pickReturningRow(rehydrateRow(meta, propToSql, ret.rowKeyToSqlName, raw), ret.visibleKeys);
  };
}

// ─── DeferredTransaction ───────────────────────────────────────────────────

type StatementExecutor = (text: string, values: unknown[]) => Promise<QueryResult>;

/** Repository shape used internally — overloads erased to a uniform executor. */
type RepoExec = {
  add(e: EntityClass, row: unknown, o: unknown): Promise<unknown>;
  update(e: EntityClass, u: unknown, o: unknown): Promise<unknown>;
  delete(e: EntityClass, m: unknown, o: unknown): Promise<unknown>;
  restore(e: EntityClass, m: unknown, o: unknown): Promise<unknown>;
  hardDelete(e: EntityClass, m: unknown, o: unknown): Promise<unknown>;
  find(e: EntityClass, f?: unknown, o?: unknown): Promise<unknown>;
  findByUUID(e: EntityClass, u: string, o?: unknown): Promise<unknown>;
  findById(e: EntityClass, id: unknown, o?: unknown): Promise<unknown>;
  findAll(e: EntityClass, f?: unknown, o?: unknown): Promise<unknown>;
  findByPage(e: EntityClass, p: number, r: number, f?: unknown, o?: unknown): Promise<unknown>;
  count(e: EntityClass, o?: unknown): Promise<unknown>;
  vectorSearch(e: EntityClass, f: unknown, v: unknown, o?: unknown): Promise<unknown>;
};

export class DeferredTransaction {
  private readonly ops: DeferredOp[] = [];
  private state: "open" | "committed" | "discarded" = "open";
  private readonly exec: RepoExec;

  /**
   * @param run executes the single merged statement (Dal wires this to a
   *   pool client — `withClient` when a `timeoutMs` override is set).
   * @internal constructed by `Dal.beginTransaction()` only.
   */
  constructor(
    private readonly run: StatementExecutor,
    bulkTimeoutMs?: number,
  ) {
    const captureQueryable = {
      query: (text: string, values?: unknown[]): Promise<never> =>
        Promise.reject(new CaptureSignal({ text, values: values ?? [] })),
    } as unknown as Queryable;
    this.exec = new Repository(captureQueryable, REPO_INTERNAL, bulkTimeoutMs) as unknown as RepoExec;
  }

  // ─── writes ────────────────────────────────────────────────────────────

  /** Buffer an insert — see `Repository.add`. `options.audit` is rejected. */
  add<TEntity extends object & IAuditableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions<TEntity>,
  ): Deferred<TResult>;
  add<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions<TEntity>,
  ): Deferred<TResult>;
  add<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    row: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions<TEntity> | AuditableWriteOptions<TEntity>,
  ): Deferred<TResult> {
    const ignore = options?.onConflict === "ignore";
    return this.register<TEntity, TResult>({
      kind: "add",
      entity,
      options,
      invoke: (exec) => exec.add(entity, row, options),
      abort: ignore ? null : { kind: "fixed", code: DalErrorCodes.ERR04 },
      finalize: singleRowFinalizer(),
    });
  }

  /** Buffer an update — see `Repository.update`. `options.audit` is rejected. */
  update<TEntity extends object & IAuditableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Deferred<TResult>;
  update<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Deferred<TResult>;
  update<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    updates: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Deferred<TResult> {
    return this.register<TEntity, TResult>({
      kind: "update",
      entity,
      options,
      invoke: (exec) => exec.update(entity, updates, options),
      abort: { kind: "matched" },
      finalize: singleRowFinalizer(),
    });
  }

  /** Buffer a soft-delete — see `Repository.delete`. `options.audit` is rejected. */
  delete<TEntity extends object & IAuditableEntity & IDeletableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Deferred<TResult>;
  delete<TEntity extends object & IDeletableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Deferred<TResult>;
  delete<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Deferred<TResult> {
    return this.register<TEntity, TResult>({
      kind: "delete",
      entity,
      options,
      invoke: (exec) => exec.delete(entity, match, options),
      abort: { kind: "matched" },
      finalize: singleRowFinalizer(),
    });
  }

  /** Buffer a restore — see `Repository.restore`. `options.audit` is rejected. */
  restore<TEntity extends object & IAuditableEntity & IDeletableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Deferred<TResult>;
  restore<TEntity extends object & IDeletableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Deferred<TResult>;
  restore<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Deferred<TResult> {
    return this.register<TEntity, TResult>({
      kind: "restore",
      entity,
      options,
      invoke: (exec) => exec.restore(entity, match, options),
      abort: { kind: "matched" },
      finalize: singleRowFinalizer(),
    });
  }

  /** Buffer a hard delete — see `Repository.hardDelete`. `options.audit` is rejected. */
  hardDelete<TEntity extends object & IAuditableEntity, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: AuditableWriteOptions & MatchByOptions<TEntity>,
  ): Deferred<TResult>;
  hardDelete<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: WriteOptions & MatchByOptions<TEntity>,
  ): Deferred<TResult>;
  hardDelete<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    match: Partial<Record<keyof TEntity & string, unknown>>,
    options: (WriteOptions | AuditableWriteOptions) & MatchByOptions<TEntity>,
  ): Deferred<TResult> {
    return this.register<TEntity, TResult>({
      kind: "hardDelete",
      entity,
      options,
      invoke: (exec) => exec.hardDelete(entity, match, options),
      abort: { kind: "matched" },
      finalize: singleRowFinalizer(),
    });
  }

  // ─── reads (single-statement; results materialize at commit) ────────────

  /** Buffer a single-row find — see `Repository.find`. */
  find<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    fields?: FieldProjector[] | null,
    options?: FindOptions,
  ): Deferred<TResult | null> {
    return this.register<TEntity, TResult | null>({
      kind: "find",
      entity,
      readFields: fields ?? null,
      invoke: (exec) => exec.find(entity, fields, options),
      abort: options?.throwIfNotFound === false ? null : { kind: "fixed", code: DalErrorCodes.ERR03 },
      finalize: (rows, _ret, meta, propToSql) => rehydrateRow(meta, propToSql, null, rows[0] ?? {}) && (rows[0] ? rehydrateRow(meta, propToSql, null, rows[0]) : null),
    });
  }

  /** Buffer a find-by-uuid — see `Repository.findByUUID`. */
  findByUUID<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    uuid: string,
    options?: FindByUUIDOptions,
  ): Deferred<TResult | null> {
    return this.register<TEntity, TResult | null>({
      kind: "findByUUID",
      entity,
      invoke: (exec) => exec.findByUUID(entity, uuid, options),
      abort: options?.throwIfNotFound === false ? null : { kind: "fixed", code: DalErrorCodes.ERR03 },
      finalize: (rows, _ret, meta, propToSql) => (rows[0] ? rehydrateRow(meta, propToSql, null, rows[0]) : null),
    });
  }

  /** Buffer a find-by-id — see `Repository.findById`. */
  findById<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    id: bigint | string,
    options?: FindByIdOptions,
  ): Deferred<TResult | null> {
    return this.register<TEntity, TResult | null>({
      kind: "findById",
      entity,
      invoke: (exec) => exec.findById(entity, id, options),
      abort: options?.throwIfNotFound === false ? null : { kind: "fixed", code: DalErrorCodes.ERR03 },
      finalize: (rows, _ret, meta, propToSql) => (rows[0] ? rehydrateRow(meta, propToSql, null, rows[0]) : null),
    });
  }

  /** Buffer a findAll — see `Repository.findAll` (`stream` rejected). */
  findAll<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    fields?: FieldProjector[] | null,
    options?: FindOptions,
  ): Deferred<TResult[]> {
    if (options?.stream) {
      throw new ValidationError("beginTransaction: findAll stream is not deferrable — omit 'stream' inside a buffered transaction");
    }
    return this.register<TEntity, TResult[]>({
      kind: "findAll",
      entity,
      readFields: fields ?? null,
      invoke: (exec) => exec.findAll(entity, fields, options),
      abort: null,
      finalize: (rows, _ret, meta, propToSql) => rows.map((r) => rehydrateRow(meta, propToSql, null, r)),
    });
  }

  /** Buffer a paged find — see `Repository.findByPage`. */
  findByPage<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    page: number,
    recordsPerPage: number,
    fields?: FieldProjector[] | null,
    options?: FindOptions,
  ): Deferred<PaginatedEntity<TResult>> {
    return this.register<TEntity, PaginatedEntity<TResult>>({
      kind: "findByPage",
      entity,
      readFields: fields ?? null,
      invoke: (exec) => exec.findByPage(entity, page, recordsPerPage, fields, options),
      abort: null,
      finalize: (rows, _ret, meta, propToSql) => {
        const total = rows[0]?._total_records;
        const entities = rows.map((r) => {
          const { _total_records: _t, ...rest } = rehydrateRow(meta, propToSql, null, r);
          return rest as TResult;
        });
        return { entities, total_records: total === undefined || total === null ? 0n : BigInt(total as number | string) };
      },
    });
  }

  /** Buffer a count — see `Repository.count`. */
  count<TEntity extends object>(
    entity: EntityClass & { new (): TEntity },
    options?: { tableName?: string },
  ): Deferred<bigint> {
    return this.register<TEntity, bigint>({
      kind: "count",
      entity,
      invoke: (exec) => exec.count(entity, options),
      abort: null,
      finalize: (rows) => {
        const n = rows[0]?.n;
        return n === undefined || n === null ? 0n : BigInt(n as number);
      },
    });
  }

  /** Buffer a pgvector search — see `Repository.vectorSearch`. */
  vectorSearch<TEntity extends object, TResult = TEntity>(
    entity: EntityClass & { new (): TEntity },
    vectorField: FieldRef<TEntity, keyof TEntity & string>,
    queryVector: number[] | string,
    options?: VectorSearchOptions<TEntity>,
  ): Deferred<Array<TResult & { similarity?: number; distance?: number }>> {
    return this.register<TEntity, Array<TResult & { similarity?: number; distance?: number }>>({
      kind: "vectorSearch",
      entity,
      readFields: options?.fields ?? null,
      invoke: (exec) => exec.vectorSearch(entity, vectorField, queryVector, options),
      abort: null,
      finalize: (rows, _ret, meta, propToSql) => rows.map((r) => rehydrateRow(meta, propToSql, null, r)),
    });
  }

  // ─── commit / discard ──────────────────────────────────────────────────

  /**
   * Compile every buffered op into ONE statement and execute it. Atomicity
   * is the statement's own: a failure anywhere (constraint, pg_raise guard,
   * abort branch, timeout) rolls back every branch — no rollback code exists
   * because none is needed. Resolves when all `Deferred` handles are
   * materialized; rejects with the first failure.
   */
  async commit(): Promise<void> {
    if (this.state !== "open") {
      throw new ValidationError(`beginTransaction: commit() on a ${this.state} transaction`);
    }
    this.state = "committed";
    try {
      const caps = await Promise.all(this.ops.map((o) => o.captured));
      if (caps.length === 0) return;

      const mergedValues: unknown[] = [];
      const cteParts: string[] = [];
      const abortNames: string[] = [];

      caps.forEach((cap, i) => {
        const op = this.ops[i];
        const { ctes, tail } = splitTopLevelCtes(cap.text);
        const names = ctes.map((c) => c.name);
        const ns = `s${i}_`;
        const indexMap = new Map<number, number>();
        for (const c of ctes) {
          cteParts.push(remapParams(renameCtes(c.sql, names, ns), cap.values, mergedValues, i, this.ops, indexMap));
        }
        const renamedTail = renameCtes(tail, names, ns);
        cteParts.push(`${quoteIdent(`__r${i}`)} AS (\n${remapParams(renamedTail, cap.values, mergedValues, i, this.ops, indexMap)}\n)`);

        const abort = this.abortSpec(op, names, ns, i);
        if (abort) abortNames.push(`__ab${i}`);
        if (abort) cteParts.push(abort);
      });

      const selectCols = this.ops.map(
        (_o, i) =>
          `(SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM ${quoteIdent(`__r${i}`)} t) AS ${quoteIdent(`__r${i}`)}`,
      );
      const where = abortNames.length
        ? `\nWHERE ${abortNames.map((n) => `NOT EXISTS (SELECT 1 FROM ${quoteIdent(n)})`).join("\n  AND ")}`
        : "";
      const sql = `WITH ${cteParts.join(",\n")}\nSELECT ${selectCols.join(",\n       ")}${where}`;

      const res = await this.run(sql, mergedValues);
      const payload = (res.rows[0] ?? {}) as Record<string, Array<Record<string, unknown>> | null>;

      this.ops.forEach((op, i) => {
        try {
          const rows = payload[`__r${i}`] ?? [];
          op.deferred._resolve(op.finalize(rows));
        } catch (err) {
          op.deferred._reject(err);
        }
      });
    } catch (err) {
      for (const op of this.ops) op.deferred._reject(err);
      throw err;
    }
  }

  /**
   * Abandon the buffer without executing anything. Nothing has run yet by
   * design — this simply invalidates the transaction and its Deferred handles.
   */
  discard(): void {
    if (this.state !== "open") return;
    this.state = "discarded";
    for (const op of this.ops) {
      void op.captured.catch(() => {});
      op.deferred._reject(new ValidationError("beginTransaction: discarded before commit"));
    }
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private register<TEntity extends object, TResult>(args: {
    kind: DeferredOpKind;
    entity: EntityClass & { new (): TEntity };
    options?: {
      audit?: unknown;
      returning?: FieldProjector[] | null;
      onConflict?: string;
    };
    readFields?: readonly FieldProjector[] | null;
    invoke: (exec: RepoExec) => Promise<unknown>;
    abort: DeferredOp["abort"];
    finalize: (
      rows: Array<Record<string, unknown>>,
      ret: WriteRet,
      meta: EntityPersistenceMeta,
      propToSql: Map<string, string>,
    ) => unknown;
  }): Deferred<TResult> {
    const { kind, entity, options, readFields, invoke, abort, finalize } = args;
    if (this.state !== "open") {
      throw new ValidationError(`beginTransaction: ${kind}() on a ${this.state} transaction`);
    }
    if (options && "audit" in options && options.audit) {
      throw new ValidationError(
        `beginTransaction: ${kind} with options.audit cannot be deferred — the audit delta needs the pre-write row. Use dal.transaction(fn) for audited writes.`,
      );
    }

    const index = this.ops.length;
    const deferred = new Deferred<TResult>(index);
    const meta = getEntityPersistenceMeta(entity);
    const propToSql = new Map<string, string>(
      Object.values(meta.columns).map((c) => [c.propertyKey, c.sqlName]),
    );

    const captured: Promise<CapturedSql> = Promise.resolve()
      .then(() => invoke(this.exec))
      .then(
        () => {
          throw new ValidationError(
            `beginTransaction: ${kind} completed without emitting a statement — unsupported op shape`,
          );
        },
        (err: unknown) => {
          if (err instanceof CaptureSignal) return err.sql;
          throw err;
        },
      );
    // Errors surface at commit(); this catch silences unhandled-rejection
    // noise when the buffer is discarded or a sibling op fails first.
    void captured.catch(() => {});

    const emittedKeys = (): Set<string> => {
      const keys = new Set<string>();
      if (WRITE_KINDS.has(kind)) {
        const ret = buildReturningClause(entity, options?.returning ?? null);
        for (const k of ret.rowKeyToSqlName.keys()) keys.add(k);
      } else if (readFields && readFields.length > 0) {
        for (const f of readFields) {
          keys.add(f.kind === "expr" ? f.alias : (f.alias ?? getColumnName(entity, f.field.key)));
        }
      } else {
        for (const c of Object.values(meta.columns)) {
          keys.add(c.propertyKey);
          keys.add(c.sqlName);
        }
        // Non-entity extras that read ops can emit.
        keys.add("_total_records");
        keys.add("similarity");
        keys.add("distance");
        keys.add("n");
      }
      return keys;
    };

    this.ops.push({
      index,
      kind,
      entity,
      entityName: meta.entityClassName,
      captured,
      deferred: deferred as Deferred<unknown>,
      emittedKeys,
      finalize: (rows) => {
        const ret: WriteRet = WRITE_KINDS.has(kind)
          ? buildReturningClause(entity, options?.returning ?? null)
          : { visibleKeys: [], rowKeyToSqlName: new Map<string, string>() };
        return finalize(rows, ret, meta, propToSql);
      },
      abort,
    });
    return deferred;
  }

  /**
   * Abort branch for ops that must yield at least one row. `matched` (always
   * emitted by write ops) disambiguates: row found but not written → ERR01
   * (version/unique guard tripped — ERR04/ERR05 raise on their own branch
   * first when they apply), row absent → ERR03.
   */
  private abortSpec(op: DeferredOp, cteNames: string[], ns: string, i: number): string | null {
    if (!op.abort) return null;
    const detail = `jsonb_build_object('entity', ${lit(op.entityName)}, 'op', ${lit(op.kind)}, 'deferred_index', ${i})::text`;
    const codeExpr =
      op.abort.kind === "matched" && cteNames.includes("matched")
        ? `(CASE WHEN EXISTS (SELECT 1 FROM ${quoteIdent(`${ns}matched`)}) THEN ${lit(DalErrorCodes.ERR01)} ELSE ${lit(DalErrorCodes.ERR03)} END)`
        : lit(op.abort.kind === "fixed" ? op.abort.code : DalErrorCodes.ERR03);
    return `${quoteIdent(`__ab${i}`)} AS (
  SELECT public.pg_raise(
    ${codeExpr},
    ${lit(`${op.kind}: required row not written for ${op.entityName} (deferred tx op ${i})`)},
    ${detail}
  ) AS _raised
  WHERE NOT EXISTS (SELECT 1 FROM ${quoteIdent(`__r${i}`)})
)`;
  }
}
