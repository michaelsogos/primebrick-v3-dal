import "dotenv/config";
import "reflect-metadata";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { Dal, PageOutOfRangeError, ValidationError } from "../src/index.js";
import type { EntityMeta } from "@primebrick/core";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import { RefSourceEntity } from "./entities/ref-source-entity.js";
import { setupTestSchema, truncateTestTables } from "./helpers/setup.js";

/**
 * `list.meta` derivation contract — when the resolved EntityMeta is supplied,
 * the wire sets derive from it and `searchableKeys`/`filterableKeys` act as
 * optional narrowings (the `sortableKeys` pattern):
 *
 *  - `search_in` fails closed on keys outside the derived scope (the silent
 *    no-op that used to return every row is dead).
 *  - `filters[i][field]` fails closed on served-`filterable:false` columns.
 *  - Authored keys narrow the derived universe — they can no longer widen it
 *    past the served contract.
 *  - Without `meta` the legacy path requires the key arrays at construction.
 */
describe("EntityService — list.meta wire-set derivation", () => {
  let dal: Dal;

  const meta = {
    columns: [
      { key: "uuid", label_key: "x", type: "text" },
      { key: "name", label_key: "x", type: "text" },
      { key: "email", label_key: "x", type: "text" },
      { key: "description", label_key: "x", type: "text", searchable: false },
      { key: "version", label_key: "x", type: "number", filterable: false },
      { key: "created_by", label_key: "x", type: "text" },
      { key: "updated_by", label_key: "x", type: "text" },
      { key: "created_at", label_key: "x", type: "datetime" },
      { key: "updated_at", label_key: "x", type: "datetime" },
    ],
  } as unknown as EntityMeta;

  const svc = (list?: object) =>
    dal.entityService<SimpleTestEntity>({
      entity: SimpleTestEntity as never,
      actor: () => "test",
      list: { meta, ...list },
    });

  beforeAll(async () => {
    dal = new Dal({
      connectionString: process.env.DATABASE_URL!,
      schemas: ["public"],
      max: 5,
      statementTimeoutMs: 30000,
      applicationName: "dal-test-meta-derivation",
    });
    await setupTestSchema();
  });

  afterAll(async () => {
    await dal.close();
  });

  beforeEach(async () => {
    await truncateTestTables();
    await dal.add(SimpleTestEntity, { name: "Mario", email: "mario@x.it" }, { actor: "test" });
    await dal.add(SimpleTestEntity, { name: "Luigi", description: "mario mentioned" }, { actor: "test" });
  });

  it("derives the default search scope from served-searchable text columns", async () => {
    const hit = await svc().list({ search: "Mario" });
    expect(hit.rows.length).toBe(1);
    expect(hit.rows[0].name).toBe("Mario");
  });

  it("search_in on a served-searchable column filters", async () => {
    const hit = await svc().list({ search: "mario@x", search_in: ["email"] });
    expect(hit.rows.length).toBe(1);
  });

  it("search_in accepts the comma-joined wire form (FE canonical)", async () => {
    // The FE serializes the scope as ONE comma-joined param
    // (`search_in=email,name`) — schema-less routers pass it through as a
    // single string; it must split, not be read as one invalid key.
    const hit = await svc().list({
      search: "mario@x",
      search_in: "email,name" as unknown as string[],
    });
    expect(hit.rows.length).toBe(1);
  });

  it("search_in comma-joined rejects invalid keys fail-closed", async () => {
    await expect(
      svc().list({
        search: "mario",
        search_in: "email,description" as unknown as string[],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("search_in on served-searchable:false → ValidationError", async () => {
    await expect(
      svc().list({ search: "mario", search_in: ["description"] }),
    ).rejects.toThrow(ValidationError);
  });

  it("search_in on a non-text-physical column → ValidationError", async () => {
    await expect(
      svc().list({ search: "1", search_in: ["version"] }),
    ).rejects.toThrow(ValidationError);
  });

  it("filters on a served-filterable column pass", async () => {
    const hit = await svc().list({
      filters: [{ field: "description", op: "ILIKE", value: "mario" }],
    });
    expect(hit.rows.length).toBe(1);
    expect(hit.rows[0].name).toBe("Luigi");
  });

  it("filters on served-filterable:false → ValidationError", async () => {
    await expect(
      svc().list({ filters: [{ field: "version", op: "=", value: "1" }] }),
    ).rejects.toThrow(ValidationError);
  });

  it("uuid stays filterable + searchable by construction", async () => {
    const row = (await svc().list({})).rows[0];
    const hit = await svc().list({
      filters: [{ field: "uuid", op: "=", value: row.uuid }],
    });
    expect(hit.rows.length).toBe(1);
    const hitSearch = await svc().list({ search: row.uuid, search_in: ["uuid"] });
    expect(hitSearch.rows.length).toBe(1);
  });

  it("authored searchableKeys narrow the derived scope", async () => {
    const narrow = svc({ searchableKeys: ["name"] });
    const hit = await narrow.list({ search: "Mario" });
    expect(hit.rows.length).toBe(1);
    await expect(
      narrow.list({ search: "mario@x", search_in: ["email"] }),
    ).rejects.toThrow(ValidationError);
  });

  it("authored filterableKeys narrow the derived allowlist", async () => {
    const narrow = svc({ filterableKeys: new Set(["name"]) });
    await expect(
      narrow.list({ filters: [{ field: "description", op: "ILIKE", value: "mario" }] }),
    ).rejects.toThrow(ValidationError);
  });

  it("legacy path: keys without meta still build and work", async () => {
    const legacy = dal.entityService<SimpleTestEntity>({
      entity: SimpleTestEntity as never,
      actor: () => "test",
      list: { searchableKeys: ["name"], filterableKeys: new Set(["name"]) },
    });
    const hit = await legacy.list({ search: "Mario" });
    expect(hit.rows.length).toBe(1);
    // strictness applies globally — an unknown key is a 400, not a silent no-op
    await expect(
      legacy.list({ search: "x", search_in: ["email"] }),
    ).rejects.toThrow(ValidationError);
  });

  it("missing both meta and searchableKeys → construction-time error", () => {
    expect(() =>
      dal.entityService<SimpleTestEntity>({
        entity: SimpleTestEntity as never,
        actor: () => "test",
        list: { filterableKeys: new Set(["name"]) },
      }),
    ).toThrow(ValidationError);
  });

  it("missing both meta and filterableKeys → construction-time error", () => {
    expect(() =>
      dal.entityService<SimpleTestEntity>({
        entity: SimpleTestEntity as never,
        actor: () => "test",
        list: { searchableKeys: ["name"] },
      }),
    ).toThrow(ValidationError);
  });
});

/** Wire envelope guards — on schema-less services `q` arrives raw:
 *  strings/floats/garbage must fail closed as 400 here, never reach SQL
 *  and escape as a PG cast-error 500. */
describe("EntityService — wire envelope guards", () => {
  let dal: Dal;

  const meta = {
    columns: [
      { key: "uuid", label_key: "x", type: "text" },
      { key: "name", label_key: "x", type: "text" },
      { key: "created_at", label_key: "x", type: "datetime" },
      { key: "version", label_key: "x", type: "number" },
      { key: "created_by", label_key: "x", type: "text" },
      { key: "updated_by", label_key: "x", type: "text" },
    ],
  } as unknown as EntityMeta;

  const svc = (list?: object) =>
    dal.entityService<SimpleTestEntity>({
      entity: SimpleTestEntity as never,
      actor: () => "test",
      list: { meta, ...list },
    });

  beforeAll(async () => {
    dal = new Dal({
      connectionString: process.env.DATABASE_URL!,
      schemas: ["public"],
      max: 5,
      statementTimeoutMs: 30000,
      applicationName: "dal-test-envelope-guards",
    });
    await setupTestSchema();
  });

  afterAll(async () => {
    await dal.close();
  });

  beforeEach(async () => {
    await truncateTestTables();
    await dal.add(SimpleTestEntity, { name: "Mario" }, { actor: "test" });
  });

  it("page/page_size: non-numeric, float and <1 → ValidationError (not a PG 500)", async () => {
    await expect(svc().list({ page: "abc" as never })).rejects.toThrow(ValidationError);
    await expect(svc().list({ page_size: "abc" as never })).rejects.toThrow(ValidationError);
    await expect(svc().list({ page: 1.5 })).rejects.toThrow(ValidationError);
    await expect(svc().list({ page: 0 })).rejects.toThrow(ValidationError);
    await expect(svc().list({ page_size: 0 })).rejects.toThrow(ValidationError);
    await expect(svc().list({ page_size: -5 })).rejects.toThrow(ValidationError);
    const ok = await svc().list({ page: "1" as never, page_size: "10" as never });
    expect(ok.rows.length).toBe(1);
  });

  it("deleted_records outside the enum → ValidationError (no silent default)", async () => {
    await expect(
      svc().list({ deleted_records: "BOGUS" as never }),
    ).rejects.toThrow(ValidationError);
    const ok = await svc().list({ deleted_records: "excluded" as never });
    expect(ok.rows.length).toBe(1);
  });

  it("filter value typed check — temporal", async () => {
    await expect(
      svc().list({ filters: [{ field: "created_at", op: ">", value: "not-a-date" }] }),
    ).rejects.toThrow(ValidationError);
    const ok = await svc().list({ filters: [{ field: "created_at", op: "<", value: "2099-01-01" }] });
    expect(ok.rows.length).toBe(1);
  });

  it("filter value typed check — skipped when the meta can't prove the type", async () => {
    // SimpleTestEntity's uuid column carries only inferredPgType="text" —
    // the validator deliberately does not over-reject what it cannot
    // prove. Real entities declare pgType:"uuid" (job_schedule does) —
    // the strict uuid check is locked by the live wire-attack E2E.
    const hit = await svc().list({ filters: [{ field: "name", op: "=", value: "Mario" }] });
    expect(hit.rows.length).toBe(1);
  });

  it("filter value typed check — integer", async () => {
    const s2 = svc();
    await expect(
      s2.list({ filters: [{ field: "version", op: "=", value: "not-a-number" }] }),
    ).rejects.toThrow(ValidationError);
    const ok = await s2.list({ filters: [{ field: "version", op: ">=", value: "1" }] });
    expect(ok.rows.length).toBe(1);
  });

  it("IN-list elements are each type-checked", async () => {
    await expect(
      svc().list({ filters: [{ field: "version", op: "IN", value: ["1", "bogus"] }] }),
    ).rejects.toThrow(ValidationError);
    const ok = await svc().list({ filters: [{ field: "version", op: "IN", value: ["1", "2"] }] });
    expect(ok.rows.length).toBe(1);
  });

  it("ILIKE bypasses the typed check — the builder casts to text", async () => {
    const hit = await svc().list({ filters: [{ field: "uuid", op: "ILIKE", value: "%-%" }] });
    expect(hit.rows.length).toBe(1);
  });
});

/** `auditActors` capability — present iff the entity stamps audit
 *  columns (`Auditable` mixin), never gated on the audit-trail table. */
describe("EntityService — auditActors capability", () => {
  let dal: Dal;

  beforeAll(async () => {
    dal = new Dal({
      connectionString: process.env.DATABASE_URL!,
      schemas: ["public"],
      max: 5,
      statementTimeoutMs: 30000,
      applicationName: "dal-test-audit-actors-cap",
    });
    await setupTestSchema();
  });

  afterAll(async () => {
    await dal.close();
  });

  it("present when audit columns exist", async () => {
    const s = dal.entityService<SimpleTestEntity>({
      entity: SimpleTestEntity as never,
      actor: () => "test",
      list: { searchableKeys: ["name"], filterableKeys: new Set(["name"]) },
    });
    expect(typeof s.auditActors).toBe("function");
    expect(Array.isArray(await s.auditActors!())).toBe(true);
  });

  it("absent on a non-auditable entity", () => {
    const s = dal.entityService<RefSourceEntity>({
      entity: RefSourceEntity as never,
      actor: () => "test",
      list: { searchableKeys: ["name"], filterableKeys: new Set(["name"]) },
    });
    expect(s.auditActors).toBeUndefined();
  });
});

describe("EntityService — page out of range", () => {
  let dal: Dal;

  beforeAll(async () => {
    dal = new Dal({
      connectionString: process.env.DATABASE_URL!,
      schemas: ["public"],
      max: 5,
      statementTimeoutMs: 30000,
      applicationName: "dal-test-page-oor",
    });
    await setupTestSchema();
  });

  afterAll(async () => {
    await dal.close();
  });

  const svc = () =>
    dal.entityService<SimpleTestEntity>({
      entity: SimpleTestEntity as never,
      actor: () => "test",
      list: { searchableKeys: ["name"], filterableKeys: new Set(["name"]) },
    });

  beforeEach(async () => {
    await truncateTestTables();
    await dal.add(SimpleTestEntity, { name: "Mario" }, { actor: "test" });
    await dal.add(SimpleTestEntity, { name: "Luigi" }, { actor: "test" });
  });

  it("page beyond last on a non-empty filter → PageOutOfRangeError", async () => {
    // 2 rows, page_size default 25 → last_page 1: page 2+ is a violation,
    // not data to fabricate.
    const err = await svc()
      .list({ page: 99 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(PageOutOfRangeError);
    expect((err as PageOutOfRangeError).detail).toEqual({
      page: 99,
      last_page: 1,
      total: 2,
    });
  });

  it("empty result set is legit on any page → no error, total 0", async () => {
    const r = await svc().list({ search: "zzz_no_match", page: 7 });
    expect(r.rows.length).toBe(0);
    expect(r.total).toBe(0n);
  });

  it("in-range empty tail page still returns rows + real total", async () => {
    const r = await svc().list({ page: 2, page_size: 1 });
    expect(r.rows.length).toBe(1);
    expect(r.total).toBe(2n);
  });
});
