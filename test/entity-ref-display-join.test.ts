import "dotenv/config";
import "reflect-metadata";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { Dal, registerEntityService } from "../src/index.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import { RefSourceEntity } from "./entities/ref-source-entity.js";
import { setupTestSchema, truncateTestTables } from "./helpers/setup.js";

/**
 * `@Ref` display-join contract — a ref column whose target entity resolves
 * in the registry gets an automatic LEFT JOIN projecting `{key}_name` off
 * the target's OWN materialized display template (`"${display_field}"` or
 * the authored `display_name` expression):
 *
 *  - list rows carry `target_uuid_name` alongside the raw `target_uuid`.
 *  - a missing/unregistered target SKIPS the join — raw value, no boot
 *    failure (the cross-domain contract: SQL joins never leave the domain;
 *    the FE still renders the uuid and drills through the target service's
 *    own endpoint).
 *  - `sort_key=<ref>` orders on the projected `{key}_name` alias.
 *  - `search_in=<ref>` ILIKEs `COALESCE(<display expr>, <col>::text)`.
 */
describe("EntityService — @Ref automatic display joins", () => {
  let dal: Dal;

  beforeAll(async () => {
    dal = new Dal({
      connectionString: process.env.DATABASE_URL!,
      schemas: ["public"],
      max: 5,
      statementTimeoutMs: 30000,
      applicationName: "dal-test-refjoin",
    });
    await setupTestSchema();
    // The route layer normally feeds this through
    // `DomainService.registerRefDisplay(resolveDisplayTemplate(meta))` —
    // tests register the materialized template directly.
    registerEntityService({ entity: SimpleTestEntity, display: "${name}" });
  });

  afterAll(async () => {
    await dal.close();
  });

  beforeEach(async () => {
    await truncateTestTables();
  });

  const svc = () =>
    dal.entityService<RefSourceEntity>({
      entity: RefSourceEntity as never,
      list: {
        searchableKeys: ["label"],
        filterableKeys: new Set(["label"]),
        defaultSort: { key: "label", dir: "asc" },
      },
    });

  async function seed() {
    const targets = await svc();
    const t1 = await dal
      .entityService<SimpleTestEntity>({ entity: SimpleTestEntity as never, list: { searchableKeys: ["name"], filterableKeys: new Set(["name"]) } })
      .create({ name: "Ref Alpha" } as never);
    const t2 = await dal
      .entityService<SimpleTestEntity>({ entity: SimpleTestEntity as never, list: { searchableKeys: ["name"], filterableKeys: new Set(["name"]) } })
      .create({ name: "Ref Zulu" } as never);
    const s1 = await targets.create({ label: "s1", target_uuid: t1.uuid, ghost_uuid: t1.uuid } as never);
    const s2 = await targets.create({ label: "s2", target_uuid: t2.uuid } as never);
    const s3 = await targets.create({ label: "s3" } as never);
    return { t1, t2, s1, s2, s3 };
  }

  it("list projects {key}_name off the target's display template", async () => {
    const { t1, s1 } = await seed();
    const row = (await svc().list({})).rows.find((r) => r.uuid === s1.uuid);
    expect(row?.target_uuid).toBe(t1.uuid);
    expect((row as Record<string, unknown>)?.target_uuid_name).toBe("Ref Alpha");
  });

  it("null ref and missing target degrade to NULL _name — FE falls back to uuid", async () => {
    const { t1, s1, s2, s3 } = await seed();
    const rows = (await svc().list({})).rows;
    const named = rows.find((r) => r.uuid === s2.uuid);
    const empty = rows.find((r) => r.uuid === s3.uuid);
    const withGhost = rows.find((r) => r.uuid === s1.uuid);
    expect((named as Record<string, unknown>)?.target_uuid_name).toBe("Ref Zulu");
    expect((empty as Record<string, unknown>)?.target_uuid_name).toBeNull();
    // ghost_uuid: ref to a name that never registers — join skipped, no projection.
    expect((withGhost as Record<string, unknown>)?.ghost_uuid_name).toBeUndefined();
    expect(withGhost?.ghost_uuid).toBe(t1.uuid);
  });

  it("sort_key=<ref> orders on the joined {key}_name surface", async () => {
    await seed();
    const asc = await svc().list({ sort_key: "target_uuid", sort_dir: "asc" });
    const names = asc.rows.map((r) => (r as Record<string, unknown>).target_uuid_name);
    // NULL last-or-first is DB-defined — assert relative order of the two names.
    const idx = [names.indexOf("Ref Alpha"), names.indexOf("Ref Zulu")];
    expect(idx[0]).toBeGreaterThanOrEqual(0);
    expect(idx[0]).toBeLessThan(idx[1]);
  });

  it("search_in=<ref> ILIKEs the joined display expression", async () => {
    await seed();
    const res = await svc().list({ search: "zulu", search_in: ["target_uuid"] });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.label).toBe("s2");
  });
});
