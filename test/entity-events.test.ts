import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import "reflect-metadata";
import { Dal } from "../src/dal/dal.js";
import { REPO_INTERNAL, Repository } from "../src/repository/repository.js";
import {
  Entity,
  Column,
  Key,
  Unique,
  AuditableField,
  DeletableField,
  AuditableFieldType,
  DeletableFieldType,
  type UUID,
} from "../src/index.js";
import type { EntityEventDraft, EntityEventPort } from "../src/entity/events.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

/** Entity-event emission silenced entirely. */
@Entity("dal_test_simple", { events: false })
class SilentEntity {
  @Key() id!: bigint;
  @Unique() uuid!: UUID;
  @Column({ pgType: "varchar", length: 255 }) name!: string;
  @AuditableField(AuditableFieldType.CREATED_AT) created_at!: Date;
  @AuditableField(AuditableFieldType.CREATED_BY) created_by!: string;
  @AuditableField(AuditableFieldType.UPDATED_AT) updated_at!: Date;
  @AuditableField(AuditableFieldType.UPDATED_BY) updated_by!: string;
  @AuditableField(AuditableFieldType.VERSION) version!: number;
}

/** Only `update` silenced — other actions still emit. */
@Entity("dal_test_simple", { events: { except: ["update"] } })
class ExceptUpdateEntity {
  @Key() id!: bigint;
  @Unique() uuid!: UUID;
  @Column({ pgType: "varchar", length: 255 }) name!: string;
  @AuditableField(AuditableFieldType.CREATED_AT) created_at!: Date;
  @AuditableField(AuditableFieldType.CREATED_BY) created_by!: string;
  @AuditableField(AuditableFieldType.UPDATED_AT) updated_at!: Date;
  @AuditableField(AuditableFieldType.UPDATED_BY) updated_by!: string;
  @AuditableField(AuditableFieldType.VERSION) version!: number;
}

function capturePort() {
  const emitted: EntityEventDraft[] = [];
  const port: EntityEventPort = { emit: async (e) => { emitted.push(e); } };
  return { emitted, port };
}

const actorOpts = { actor: "test-actor" };
/** Audit stub — injectable so the repo loads oldRecord (before/delta)
 *  the same way production auditable writes do. */
const auditStub = { writeAudit: async () => {} };

describe("entity events — repo write path emission", () => {
  let repo: Repository;
  beforeAll(async () => {
    await setupTestSchema();
    repo = new Repository(getTestPool(), REPO_INTERNAL);
  });
  afterAll(async () => { await closeTestPool(); });
  beforeEach(async () => { await truncateTestTables(); });

  it("add emits create with after+delta, before null", async () => {
    const { emitted, port } = capturePort();
    const row = await repo.add(SimpleTestEntity, { name: "evt-a" } as any, { ...actorOpts, events: port });
    await new Promise((r) => setTimeout(r, 10));
    expect(emitted).toHaveLength(1);
    const e = emitted[0];
    expect(e.action).toBe("create");
    expect(e.entity).toBe("simple_test");
    expect(e.table).toBe("public.dal_test_simple");
    expect(e.uuid).toBe(row.uuid);
    expect(e.actor).toBe("test-actor");
    expect(e.before).toBeNull();
    expect(e.after?.["name"]).toBe("evt-a");
    expect(e.delta?.["name"]).toEqual({ old: undefined, new: "evt-a" });
  });

  it("update emits before+after+delta", async () => {
    const { emitted, port } = capturePort();
    const row = await repo.add(SimpleTestEntity, { name: "evt-b" } as any, { ...actorOpts, events: port });
    emitted.length = 0;
    await repo.update(
      SimpleTestEntity,
      { uuid: row.uuid, version: row.version, name: "evt-b2" } as any,
      { ...actorOpts, audit: auditStub, events: port },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(emitted).toHaveLength(1);
    const e = emitted[0];
    expect(e.action).toBe("update");
    expect(e.before?.["name"]).toBe("evt-b");
    expect(e.after?.["name"]).toBe("evt-b2");
    expect(e.delta?.["name"]).toEqual({ old: "evt-b", new: "evt-b2" });
  });

  it("delete emits action delete", async () => {
    const { emitted, port } = capturePort();
    const row = await repo.add(SimpleTestEntity, { name: "evt-c" } as any, { ...actorOpts, events: port });
    emitted.length = 0;
    await repo.delete(SimpleTestEntity, { uuid: row.uuid, version: row.version } as any, {
      ...actorOpts, events: port, matchBy: "uuid" as never,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(emitted[0]?.action).toBe("delete");
    expect(emitted[0]?.uuid).toBe(row.uuid);
  });

  it("events:false silences the entity entirely", async () => {
    const { emitted, port } = capturePort();
    await repo.add(SilentEntity, { name: "silent" } as any, { ...actorOpts, events: port });
    await new Promise((r) => setTimeout(r, 10));
    expect(emitted).toHaveLength(0);
  });

  it("events:{except} silences only listed actions", async () => {
    const { emitted, port } = capturePort();
    const row = await repo.add(ExceptUpdateEntity, { name: "except" } as any, { ...actorOpts, events: port });
    await new Promise((r) => setTimeout(r, 10));
    expect(emitted).toHaveLength(1); // create still emitted
    emitted.length = 0;
    await repo.update(ExceptUpdateEntity, { uuid: row.uuid, version: row.version, name: "except2" } as any, { ...actorOpts, events: port });
    await new Promise((r) => setTimeout(r, 10));
    expect(emitted).toHaveLength(0); // update silenced
  });

  it("bulk updateMany emits thin per-item events sharing a batch", async () => {
    const { emitted, port } = capturePort();
    const a = await repo.add(SimpleTestEntity, { name: "bulk-a" } as any, actorOpts);
    const b = await repo.add(SimpleTestEntity, { name: "bulk-b" } as any, actorOpts);
    await repo.updateMany(
      SimpleTestEntity,
      [
        { uuid: a.uuid, version: a.version, name: "bulk-a2" },
        { uuid: b.uuid, version: b.version, name: "bulk-b2" },
      ] as any,
      { ...actorOpts, events: port, matchBy: "uuid" as never },
    );
    await new Promise((r) => setTimeout(r, 10));
    const bulk = emitted.filter((e) => e.action === "update");
    expect(bulk).toHaveLength(2);
    expect(bulk.map((e) => e.uuid).sort()).toEqual([a.uuid, b.uuid].sort());
    for (const e of bulk) {
      expect(e.before).toBeNull();
      expect(e.after).toBeNull();
      expect(e.delta).toBeNull();
      expect(e.batch).toBe(bulk[0].batch);
    }
  });
});

describe("entity events — transaction commit safety", () => {
  let dal: Dal;
  beforeAll(async () => {
    await setupTestSchema();
    dal = new Dal({
      connectionString: process.env.DATABASE_URL!,
      schemas: ["public"],
      max: 5,
      applicationName: "dal-events-test",
    });
  });
  afterAll(async () => { await dal.close(); });
  beforeEach(async () => { await truncateTestTables(); });

  it("tx write emits only AFTER commit", async () => {
    const { emitted, port } = capturePort();
    dal.eventPort = port;
    await dal.transaction(async (tx) => {
      await tx.add(SimpleTestEntity, { name: "tx-ok" } as any, { ...actorOpts, events: port });
      expect(emitted).toHaveLength(0); // buffered, not yet published
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(emitted).toHaveLength(1);
    expect(emitted[0].action).toBe("create");
  });

  it("tx rollback discards buffered events", async () => {
    const { emitted, port } = capturePort();
    dal.eventPort = port;
    await expect(
      dal.transaction(async (tx) => {
        await tx.add(SimpleTestEntity, { name: "tx-ko" } as any, { ...actorOpts, events: port });
        throw new Error("force-rollback");
      }),
    ).rejects.toThrow("force-rollback");
    await new Promise((r) => setTimeout(r, 10));
    expect(emitted).toHaveLength(0);
  });
});
