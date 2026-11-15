import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import "reflect-metadata";
import { Pool } from "pg";

import {
  Entity,
  Key,
  Unique,
  Column,
  Ref,
  Relation,
  Repository,
  type UUID,
} from "../src/index.js";
import { REPO_INTERNAL } from "../src/repository/repository.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

/**
 * @Relation unordered-pair conflict reporting — the `<table>_pair_uq`
 * expression index (LEAST/GREATEST + type) makes the direction-free pair
 * atomic; the add() conflict CTE then classifies the collision:
 * same-direction → ERR04 duplicate claim, reversed → ERR11 circular
 * reference (in a hierarchy read that edge would close a 2-cycle).
 */
@Entity("dal_test_rel_links")
@Relation({ parent_field: "parent_uuid", child_field: "child_uuid", type_field: "type_uuid" })
class RelLinkEntity {
  @Key() id!: bigint;
  @Unique() uuid!: UUID;
  @Column({ nullable: false }) @Ref("customer") parent_uuid!: UUID;
  @Column({ nullable: false }) @Ref("customer") child_uuid!: UUID;
  @Column({ nullable: false }) @Ref("customer_link_type") type_uuid!: UUID;
  @Column({ nullable: true }) note?: string;
}

const A = "11111111-1111-7111-8111-111111111111";
const B = "22222222-2222-7222-8222-222222222222";
const T1 = "33333333-3333-7333-8333-333333333333";
const T2 = "44444444-4444-7444-8444-444444444444";

describe("Repository — @Relation pair conflict (ERR11 circular reference)", () => {
  let pool: Pool;
  let repo: Repository;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestSchema();
    repo = new Repository(pool, REPO_INTERNAL);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  beforeEach(async () => {
    await truncateTestTables();
  });

  it("add: inserts the directed edge a→b", async () => {
    const row = await repo.add(RelLinkEntity, { parent_uuid: A, child_uuid: B, type_uuid: T1 }, {});
    expect(row.parent_uuid).toBe(A);
    expect(row.child_uuid).toBe(B);
  });

  it("add: exact same-direction duplicate raises ERR04", async () => {
    await repo.add(RelLinkEntity, { parent_uuid: A, child_uuid: B, type_uuid: T1 }, {});
    const err = await repo
      .add(RelLinkEntity, { parent_uuid: A, child_uuid: B, type_uuid: T1 }, {})
      .then(() => null)
      .catch((e) => e);
    expect(err).not.toBeNull();
    expect(err.code).toBe("ERR04");
    const detail = err.detail ? JSON.parse(err.detail) : {};
    expect(detail.constraint).toBe("dal_test_rel_links_pair_uq");
  });

  it("add: direction-reversed duplicate raises ERR11 circular reference", async () => {
    await repo.add(RelLinkEntity, { parent_uuid: A, child_uuid: B, type_uuid: T1 }, {});
    const err = await repo
      .add(RelLinkEntity, { parent_uuid: B, child_uuid: A, type_uuid: T1 }, {})
      .then(() => null)
      .catch((e) => e);
    expect(err).not.toBeNull();
    expect(err.code).toBe("ERR11");
    const detail = err.detail ? JSON.parse(err.detail) : {};
    expect(detail.constraint).toBe("dal_test_rel_links_pair_uq_reversed");
    // keys report the STORED row's ends — the direction it was created in.
    expect(detail.keys).toMatchObject({ parent_uuid: A, child_uuid: B });
  });

  it("add: a different type on the reversed pair is a distinct claim — allowed", async () => {
    await repo.add(RelLinkEntity, { parent_uuid: A, child_uuid: B, type_uuid: T1 }, {});
    const row = await repo.add(RelLinkEntity, { parent_uuid: B, child_uuid: A, type_uuid: T2 }, {});
    expect(row.type_uuid).toBe(T2);
  });
});
