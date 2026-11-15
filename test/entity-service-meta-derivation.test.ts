import "dotenv/config";
import "reflect-metadata";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { Dal, ValidationError } from "../src/index.js";
import type { EntityMeta } from "@primebrick/core";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
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
