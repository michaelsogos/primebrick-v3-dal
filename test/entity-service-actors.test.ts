import "dotenv/config";
import "reflect-metadata";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { Dal } from "../src/dal/dal.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import { setupTestSchema, truncateTestTables } from "./helpers/setup.js";

/**
 * Audit-actor query contract — `created_by`/`updated_by`/`deleted_by` are
 * fully queryable (filterable + searchable + sortable), and their searchable
 * / sortable surface is the user_profile JOIN's `display_name` (projected as
 * `*_by_name`), not the raw actor value:
 *
 *  - `?search=` on an actor key resolves `COALESCE("creator".display_name,
 *    base.created_by::text)` — ILIKE never hits a non-text operand (42883).
 *  - `sort_key=created_by` orders by the projected `created_by_name` alias.
 *  - explicit `filters[i][field]=<nontext> ILIKE` renders `CAST(.. AS text)`.
 */
describe("EntityService — audit actor search/sort via user_profile join", () => {
  let dal: Dal;
  const MARIO_UUID = "11111111-2222-3333-4444-555555555555";
  const ALBERTO_UUID = "66666666-7777-8888-9999-000000000000";

  beforeAll(async () => {
    dal = new Dal({
      connectionString: process.env.DATABASE_URL!,
      schemas: ["public"],
      max: 5,
      statementTimeoutMs: 30000,
      applicationName: "dal-test-actors",
    });
    await setupTestSchema();
    await dal.getPool().query(
      `INSERT INTO user_profiles (uuid, idp_code, display_name) VALUES
         ($1, 'mario', 'Mario Rossi'),
         ($2, 'alberto', 'Alberto Bianchi')
       ON CONFLICT (uuid) DO UPDATE SET display_name = EXCLUDED.display_name`,
      [MARIO_UUID, ALBERTO_UUID],
    );
  });

  afterAll(async () => {
    await dal.close();
  });

  beforeEach(async () => {
    await truncateTestTables();
  });

  const svc = () =>
    dal.entityService<SimpleTestEntity>({
      entity: SimpleTestEntity as never,
      actor: () => "test",
      list: {
        searchableKeys: ["name", "created_by"],
        filterableKeys: new Set(["name", "version"]),
      },
    });

  async function seedActors(): Promise<void> {
    const pool = dal.getPool();
    await pool.query(
      `INSERT INTO dal_test_simple (name, created_by, updated_by) VALUES
         ('row-mario', $1, $1),
         ('row-alberto', $2, $2),
         ('row-system', 'system', 'system')`,
      [MARIO_UUID, ALBERTO_UUID],
    );
  }

  it("search on created_by matches the joined display_name", async () => {
    await seedActors();
    const res = await svc().list({ search: "mario" });
    expect(res.rows.map((r) => r.name)).toEqual(["row-mario"]);
    const none = await svc().list({ search: "luigi" });
    expect(none.rows).toHaveLength(0);
  });

  it("search on created_by falls back to the raw actor value", async () => {
    await seedActors();
    const res = await svc().list({ search: "system" });
    expect(res.rows.map((r) => r.name)).toEqual(["row-system"]);
  });

  it("sort_key=created_by orders by the projected created_by_name", async () => {
    await seedActors();
    const res = await svc().list({ sort_key: "created_by", sort_dir: "asc" });
    // 'Alberto Bianchi' < 'Mario Rossi' < 'system' (COALESCE raw fallback)
    expect(res.rows.map((r) => r.name)).toEqual(["row-alberto", "row-mario", "row-system"]);
    const desc = await svc().list({ sort_key: "created_by", sort_dir: "desc" });
    expect(desc.rows.map((r) => r.name)).toEqual(["row-system", "row-mario", "row-alberto"]);
  });

  it("rows carry the projected created_by_name", async () => {
    await seedActors();
    const res = await svc().list({ sort_key: "name", sort_dir: "asc" });
    const mario = res.rows.find((r) => r.name === "row-mario") as Record<string, unknown>;
    expect(mario.created_by_name).toBe("Mario Rossi");
    const sys = res.rows.find((r) => r.name === "row-system") as Record<string, unknown>;
    expect(sys.created_by_name).toBe("system"); // COALESCE fallback
  });

  it("explicit ILIKE filter on the numeric version column renders a text cast (no 42883)", async () => {
    await seedActors();
    const res = await svc().list({ filters: [{ field: "version", op: "ILIKE", value: "%1%" }] });
    expect(res.rows.length).toBe(3);
  });
});

/**
 * Self-ref display join — `cloned_from` is a `Clonable`-mixin self-ref:
 * the `clone_src` LEFT JOIN evaluates the entity's OWN display template
 * (`cfg.display`, the same `display_name` the FE uses for titles) and
 * projects `cloned_from_name`. Search/sort on `cloned_from` resolve the
 * projected name, COALESCE-falling back to the raw uuid on orphan refs.
 */
describe("EntityService — cloned_from self-join display projection", () => {
  let dal: Dal;

  beforeAll(async () => {
    dal = new Dal({
      connectionString: process.env.DATABASE_URL!,
      schemas: ["public"],
      max: 5,
      statementTimeoutMs: 30000,
      applicationName: "dal-test-clonedfrom",
    });
    await setupTestSchema();
  });

  afterAll(async () => {
    await dal.close();
  });

  beforeEach(async () => {
    await truncateTestTables();
  });

  const svc = () =>
    dal.entityService<SimpleTestEntity>({
      entity: SimpleTestEntity as never,
      actor: () => "test",
      display: "${name} (${email})",
      list: {
        searchableKeys: ["name", "cloned_from"],
        filterableKeys: new Set(["name", "version"]),
      },
    });

  async function seedClones(): Promise<{ srcUuid: string }> {
    const pool = dal.getPool();
    const srcUuid = crypto.randomUUID();
    const cloneUuid = crypto.randomUUID();
    const orphanUuid = crypto.randomUUID();
    await pool.query(
      `INSERT INTO dal_test_simple (uuid, name, email, created_by, updated_by, cloned_from) VALUES
         ($1, 'source-row', 'src@x.dev', 't', 't', NULL),
         ($2, 'the-clone', 'clone@x.dev', 't', 't', $1),
         ($3, 'orphan-clone', 'orph@x.dev', 't', 't', $4)`,
      [srcUuid, cloneUuid, orphanUuid, crypto.randomUUID()],
    );
    return { srcUuid };
  }

  it("cloned_from_name projects the evaluated display template", async () => {
    await seedClones();
    const res = await svc().list({ sort_key: "name", sort_dir: "asc" });
    const clone = res.rows.find((r) => r.name === "the-clone") as Record<string, unknown>;
    expect(clone.cloned_from_name).toBe("source-row (src@x.dev)");
    const src = res.rows.find((r) => r.name === "source-row") as Record<string, unknown>;
    expect(src.cloned_from_name).toBeNull(); // NULL cloned_from → NULL name
  });

  it("orphan cloned_from falls back to the raw uuid", async () => {
    await seedClones();
    const res = await svc().list({ sort_key: "name", sort_dir: "asc" });
    const orphan = res.rows.find((r) => r.name === "orphan-clone") as Record<string, unknown>;
    expect(orphan.cloned_from_name).toBe(orphan.cloned_from);
  });

  it("search on cloned_from resolves the projected name", async () => {
    await seedClones();
    const res = await svc().list({ search: "source-row", search_in: ["cloned_from"] });
    expect(res.rows.map((r) => r.name)).toEqual(["the-clone"]);
  });

  it("sort_key=cloned_from orders by the projected name", async () => {
    await seedClones();
    const res = await svc().list({ sort_key: "cloned_from", sort_dir: "asc" });
    // ASC puts NULLs LAST in PG; the orphan's raw-uuid fallback sorts
    // before the "source-row (...)" string (hex chars < 's').
    expect(res.rows.map((r) => r.name)).toEqual(["orphan-clone", "the-clone", "source-row"]);
  });

  it("an unknown ${key} in the display template fails at construction", () => {
    expect(() =>
      dal.entityService<SimpleTestEntity>({
        entity: SimpleTestEntity as never,
        actor: () => "test",
        display: "${name} (${nonexistent_col})",
        list: { searchableKeys: ["name"], filterableKeys: new Set(["name"]) },
      }),
    ).toThrow(/not a column/);
  });

  it("a clonable service without display skips the self-join (raw uid renders)", async () => {
    await seedClones();
    const bare = dal.entityService<SimpleTestEntity>({
      entity: SimpleTestEntity as never,
      actor: () => "test",
      list: { searchableKeys: ["name"], filterableKeys: new Set(["name"]) },
    });
    const res = await bare.list({ sort_key: "name", sort_dir: "asc" });
    const clone = res.rows.find((r) => r.name === "the-clone") as Record<string, unknown>;
    expect(clone.cloned_from_name).toBeUndefined();
    expect(clone.cloned_from).toBeTruthy();
  });
});
