import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import {
  Repository,
  AuditLogEntity,
  AuditAction,
  Project,
  Filter,
  Sort,
  field,
  buildAuditTrailJoins,
  type AuditPort,
  type AuditParams,
} from "../src/index.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";
import { TestUserEntity } from "./entities/test-user-entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

/**
 * Comprehensive tests for:
 * 1. clone() method
 * 2. Audit-on-all-writes (update, delete, restore, hardDelete, upsert)
 * 3. AuditLogEntity + tableName override
 * 4. buildAuditTrailJoins
 */

// In-memory audit collector for testing
class TestAuditPort implements AuditPort {
  entries: AuditParams[] = [];
  async writeAudit(params: AuditParams): Promise<void> {
    this.entries.push(params);
  }
  reset(): void {
    this.entries = [];
  }
}

describe("Repository — clone operation", () => {
  let pool: Pool;
  let repo: Repository;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestSchema();
    repo = new Repository(pool);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  beforeEach(async () => {
    await truncateTestTables();
  });

  it("clone: creates a new record with new UUID and cloned_from set", async () => {
    const source = await repo.add(SimpleTestEntity, { name: "Original" }, { actor: "creator" });
    const cloned = await repo.clone(SimpleTestEntity, source.uuid, { actor: "cloner" });

    expect(cloned).toBeDefined();
    expect(cloned.uuid).not.toBe(source.uuid);
    expect(cloned.name).toBe("Original");
    expect(cloned.cloned_from).toBe(source.uuid);
  });

  it("clone: resets audit fields (version=1, created_by=actor)", async () => {
    const source = await repo.add(SimpleTestEntity, { name: "Src" }, { actor: "user1" });
    // Update to bump version
    await repo.update(SimpleTestEntity, { name: "Updated", uuid: source.uuid, version: source.version }, { actor: "user2", matchBy: "uuid" });
    // Clone
    const cloned = await repo.clone(SimpleTestEntity, source.uuid, { actor: "cloner" });

    expect(cloned.version).toBe(1);
    expect(cloned.created_by).toBe("cloner");
    expect(cloned.updated_by).toBe("cloner");
  });

  it("clone: resets deletable fields (deleted_at=null, deleted_by=null)", async () => {
    const source = await repo.add(SimpleTestEntity, { name: "To Clone" }, { actor: "u" });
    // Soft-delete the source
    await repo.delete(SimpleTestEntity, { uuid: source.uuid, version: source.version }, { actor: "u", matchBy: "uuid" });
    // Clone the soft-deleted source
    const cloned = await repo.clone(SimpleTestEntity, source.uuid, { actor: "cloner" });

    expect(cloned.deleted_at).toBeNull();
    expect(cloned.deleted_by).toBeNull();
  });

  it("clone: throws NotFoundError for non-existent UUID", async () => {
    await expect(
      repo.clone(SimpleTestEntity, "00000000-0000-0000-0000-000000000000", { actor: "u" }),
    ).rejects.toThrow();
  });
});

describe("Repository — audit-on-all-writes", () => {
  let pool: Pool;
  let repo: Repository;
  let auditPort: TestAuditPort;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestSchema();
    repo = new Repository(pool);
    auditPort = new TestAuditPort();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  beforeEach(async () => {
    await truncateTestTables();
    auditPort.reset();
  });

  it("add: writes INSERT audit entry", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Test" },
      { actor: "creator", audit: auditPort },
    );

    expect(auditPort.entries).toHaveLength(1);
    expect(auditPort.entries[0].action).toBe(AuditAction.INSERT);
    expect(auditPort.entries[0].entityId).toBe(inserted.id);
    expect(auditPort.entries[0].entityUuid).toBe(inserted.uuid);
    expect(auditPort.entries[0].changedBy).toBe("creator");
    expect(auditPort.entries[0].version).toBe(1);
  });

  it("update: writes UPDATE audit entry with delta", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Before" },
      { actor: "u", audit: auditPort },
    );
    auditPort.reset();

    const updated = await repo.update(
      SimpleTestEntity,
      { name: "After", uuid: inserted.uuid, version: inserted.version },
      { actor: "updater", audit: auditPort, matchBy: "uuid" },
    );

    expect(auditPort.entries).toHaveLength(1);
    expect(auditPort.entries[0].action).toBe(AuditAction.UPDATE);
    expect(auditPort.entries[0].entityId).toBe(inserted.id);
    expect(auditPort.entries[0].changedBy).toBe("updater");
    expect(auditPort.entries[0].version).toBe(2);
    // Delta should include the name change
    expect(auditPort.entries[0].delta.name).toBeDefined();
    expect(auditPort.entries[0].delta.name.old).toBe("Before");
    expect(auditPort.entries[0].delta.name.new).toBe("After");
    // Delta should force-include updated_at and updated_by
    expect(auditPort.entries[0].delta.updated_at).toBeDefined();
    expect(auditPort.entries[0].delta.updated_by).toBeDefined();
  });

  it("delete: writes SOFT_DELETE audit entry", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "ToDelete" },
      { actor: "u", audit: auditPort },
    );
    auditPort.reset();

    await repo.delete(
      SimpleTestEntity,
      { uuid: inserted.uuid, version: inserted.version },
      { actor: "deleter", audit: auditPort, matchBy: "uuid" },
    );

    expect(auditPort.entries).toHaveLength(1);
    expect(auditPort.entries[0].action).toBe(AuditAction.SOFT_DELETE);
    expect(auditPort.entries[0].changedBy).toBe("deleter");
    // Delta should include deleted_at, deleted_by, updated_at, updated_by
    expect(auditPort.entries[0].delta.deleted_at).toBeDefined();
    expect(auditPort.entries[0].delta.deleted_by).toBeDefined();
  });

  it("restore: writes RESTORE audit entry", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "ToRestore" },
      { actor: "u", audit: auditPort },
    );
    const deleted = await repo.delete(
      SimpleTestEntity,
      { uuid: inserted.uuid, version: inserted.version },
      { actor: "u", audit: auditPort, matchBy: "uuid" },
    );
    auditPort.reset();

    await repo.restore(
      SimpleTestEntity,
      { uuid: inserted.uuid, version: deleted.version },
      { actor: "restorer", audit: auditPort, matchBy: "uuid" },
    );

    expect(auditPort.entries).toHaveLength(1);
    expect(auditPort.entries[0].action).toBe(AuditAction.RESTORE);
    expect(auditPort.entries[0].changedBy).toBe("restorer");
    // Delta should include deleted_at (null→null after restore) and updated_at
    expect(auditPort.entries[0].delta.deleted_at).toBeDefined();
  });

  it("hardDelete: writes HARD_DELETE audit entry with full record as delta", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "ToHardDelete" },
      { actor: "u", audit: auditPort },
    );
    auditPort.reset();

    await repo.hardDelete(
      SimpleTestEntity,
      { uuid: inserted.uuid, version: inserted.version },
      { actor: "hard-deleter", audit: auditPort, matchBy: "uuid" },
    );

    expect(auditPort.entries).toHaveLength(1);
    expect(auditPort.entries[0].action).toBe(AuditAction.HARD_DELETE);
    expect(auditPort.entries[0].entityId).toBe(inserted.id);
    expect(auditPort.entries[0].changedBy).toBe("hard-deleter");
    // Delta should have all fields with old=values, new=null
    expect(auditPort.entries[0].delta.name).toBeDefined();
    expect(auditPort.entries[0].delta.name.old).toBe("ToHardDelete");
    expect(auditPort.entries[0].delta.name.new).toBeNull();
  });

  it("upsert: writes INSERT audit entry on new row", async () => {
    const upserted = await repo.upsert(
      SimpleTestEntity,
      { name: "Upserted", uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
      { actor: "upserter", audit: auditPort, conflictTarget: "uuid" },
    );

    expect(auditPort.entries).toHaveLength(1);
    expect(auditPort.entries[0].action).toBe(AuditAction.INSERT);
    expect(auditPort.entries[0].changedBy).toBe("upserter");
  });

  it("upsert: writes UPDATE audit entry on conflict", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "Original" },
      { actor: "u", audit: auditPort },
    );
    auditPort.reset();

    await repo.upsert(
      SimpleTestEntity,
      { name: "Updated", uuid: inserted.uuid, version: inserted.version },
      { actor: "updater", audit: auditPort, conflictTarget: "uuid" },
    );

    expect(auditPort.entries).toHaveLength(1);
    expect(auditPort.entries[0].action).toBe(AuditAction.UPDATE);
    expect(auditPort.entries[0].delta.name).toBeDefined();
    expect(auditPort.entries[0].delta.name.old).toBe("Original");
    expect(auditPort.entries[0].delta.name.new).toBe("Updated");
  });

  it("no audit when no audit port provided", async () => {
    const inserted = await repo.add(
      SimpleTestEntity,
      { name: "NoAudit" },
      { actor: "u" },
    );
    // No audit port → no audit entries (we can't verify since auditPort isn't connected)
    // Just verify the operation succeeds
    expect(inserted).toBeDefined();
    expect(auditPort.entries).toHaveLength(0);
  });
});

describe("Repository — AuditLogEntity + tableName override", () => {
  let pool: Pool;
  let repo: Repository;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestSchema();
    repo = new Repository(pool);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  beforeEach(async () => {
    await truncateTestTables();
  });

  it("add: writes to audit table via tableName override", async () => {
    const source = await repo.add(SimpleTestEntity, { name: "Source" }, { actor: "u" });

    const auditRow = await repo.add(
      AuditLogEntity,
      {
        entity_id: source.id,
        entity_uuid: source.uuid,
        action: "INSERT",
        changed_at: new Date(),
        changed_by: "u",
        version: 1,
        delta: { name: { old: null, new: "Source" } },
      },
      { tableName: "dal_test_simple_audit" },
    );

    expect(auditRow).toBeDefined();
    expect(auditRow.id).toBeGreaterThan(0n);
    expect(auditRow.entity_id).toBe(source.id);
    expect(auditRow.entity_uuid).toBe(source.uuid);
    expect(auditRow.action).toBe("INSERT");
    expect(auditRow.delta).toBeDefined();
  });

  it("find: queries audit table via tableName override with COUNT(*)", async () => {
    const source = await repo.add(SimpleTestEntity, { name: "Src" }, { actor: "u" });
    await repo.add(
      AuditLogEntity,
      { entity_id: source.id, entity_uuid: source.uuid, action: "INSERT", changed_at: new Date(), changed_by: "u", version: 1, delta: {} },
      { tableName: "dal_test_simple_audit" },
    );
    await repo.add(
      AuditLogEntity,
      { entity_id: source.id, entity_uuid: source.uuid, action: "UPDATE", changed_at: new Date(), changed_by: "u", version: 2, delta: {} },
      { tableName: "dal_test_simple_audit" },
    );

    const result = await repo.find<AuditLogEntity, { total: bigint }>(
      AuditLogEntity,
      [Project.expr("COUNT(*)", "total")],
      {
        tableName: "dal_test_simple_audit",
        filters: [Filter.fieldValue(field(AuditLogEntity, "entity_uuid"), "=", source.uuid)],
        throwIfNotFound: false,
      },
    );

    expect(result!.total).toBe(2n);
  });

  it("findByPage: queries audit table via tableName override with pagination", async () => {
    const source = await repo.add(SimpleTestEntity, { name: "Src" }, { actor: "u" });
    for (let i = 0; i < 5; i++) {
      await repo.add(
        AuditLogEntity,
        { entity_id: source.id, entity_uuid: source.uuid, action: "INSERT", changed_at: new Date(Date.now() + i * 1000), changed_by: "u", version: i + 1, delta: { i: { old: i, new: i + 1 } } },
        { tableName: "dal_test_simple_audit" },
      );
    }

    const page = await repo.findByPage<AuditLogEntity>(
      AuditLogEntity,
      1,
      3,
      [
        Project.field(field(AuditLogEntity, "id")),
        Project.field(field(AuditLogEntity, "entity_id")),
        Project.field(field(AuditLogEntity, "entity_uuid")),
        Project.field(field(AuditLogEntity, "action")),
        Project.field(field(AuditLogEntity, "changed_at")),
        Project.field(field(AuditLogEntity, "changed_by")),
        Project.field(field(AuditLogEntity, "version")),
        Project.field(field(AuditLogEntity, "delta")),
      ],
      {
        tableName: "dal_test_simple_audit",
        filters: [Filter.fieldValue(field(AuditLogEntity, "entity_uuid"), "=", source.uuid)],
        sorting: [Sort.by(field(AuditLogEntity, "changed_at"), "DESC")],
      },
    );

    expect(page.entities).toHaveLength(3);
    expect(page.total_records).toBe(5n);
    // Should be sorted DESC by changed_at
    expect(page.entities[0].version).toBeGreaterThan(page.entities[1].version);
  });

  it("count: counts audit table rows via tableName override", async () => {
    const source = await repo.add(SimpleTestEntity, { name: "Src" }, { actor: "u" });
    await repo.add(
      AuditLogEntity,
      { entity_id: source.id, entity_uuid: source.uuid, action: "INSERT", changed_at: new Date(), changed_by: "u", version: 1, delta: {} },
      { tableName: "dal_test_simple_audit" },
    );

    const total = await repo.count(AuditLogEntity, { tableName: "dal_test_simple_audit" });
    expect(total).toBe(1n);
  });
});

describe("Repository — buildAuditTrailJoins", () => {
  let pool: Pool;
  let repo: Repository;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestSchema();
    repo = new Repository(pool);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  beforeEach(async () => {
    await truncateTestTables();
  });

  it("buildAuditTrailJoins: returns joins and projections", () => {
    const { joins, projections } = buildAuditTrailJoins(AuditLogEntity, TestUserEntity);

    expect(joins).toHaveLength(1);
    expect(joins[0].type).toBe("LEFT");
    expect(joins[0].alias).toBe("creator");
    expect(joins[0].options?.castRightTo).toBe("uuid");
    expect(joins[0].options?.castLeftTo).toBe("uuid");

    expect(projections).toHaveLength(2);
    expect(projections[0]).toEqual({ kind: "expr", expr: "creator.display_name", alias: "changed_by_display_name" });
    expect(projections[1]).toEqual({ kind: "expr", expr: "creator.idp_code", alias: "changed_by_idp_code" });
  });

  it("buildAuditTrailJoins: resolves display_name via LEFT JOIN", async () => {
    // Create a user
    const user = await repo.add(
      TestUserEntity,
      { display_name: "John Doe", idp_code: "john.doe" },
      { actor: "system" },
    );

    // Create an entity
    const source = await repo.add(SimpleTestEntity, { name: "Src" }, { actor: "u" });

    // Write an audit row with changed_by = user's uuid
    await repo.add(
      AuditLogEntity,
      {
        entity_id: source.id,
        entity_uuid: source.uuid,
        action: "INSERT",
        changed_at: new Date(),
        changed_by: user.uuid,
        version: 1,
        delta: {},
      },
      { tableName: "dal_test_simple_audit" },
    );

    // Query with buildAuditTrailJoins
    const { joins, projections: joinProjections } = buildAuditTrailJoins(AuditLogEntity, TestUserEntity);
    const result = await repo.findByPage<AuditLogEntity>(
      AuditLogEntity,
      1,
      10,
      [
        Project.field(field(AuditLogEntity, "id")),
        Project.field(field(AuditLogEntity, "entity_uuid")),
        Project.field(field(AuditLogEntity, "action")),
        Project.field(field(AuditLogEntity, "changed_by")),
        Project.field(field(AuditLogEntity, "version")),
        Project.field(field(AuditLogEntity, "delta")),
        ...joinProjections,
      ],
      {
        tableName: "dal_test_simple_audit",
        joins,
        filters: [Filter.fieldValue(field(AuditLogEntity, "entity_uuid"), "=", source.uuid)],
        sorting: [Sort.by(field(AuditLogEntity, "changed_at"), "DESC")],
      },
    );

    expect(result.entities).toHaveLength(1);
    const row = result.entities[0] as any;
    expect(row.changed_by).toBe(user.uuid);
    expect(row.changed_by_display_name).toBe("John Doe");
    expect(row.changed_by_idp_code).toBe("john.doe");
  });

  it("buildAuditTrailJoins: returns null display_name for non-UUID changed_by (system)", async () => {
    const source = await repo.add(SimpleTestEntity, { name: "Src" }, { actor: "u" });

    // Write an audit row with changed_by = "system" (not a UUID)
    await repo.add(
      AuditLogEntity,
      {
        entity_id: source.id,
        entity_uuid: source.uuid,
        action: "INSERT",
        changed_at: new Date(),
        changed_by: "system",
        version: 1,
        delta: {},
      },
      { tableName: "dal_test_simple_audit" },
    );

    const { joins, projections: joinProjections } = buildAuditTrailJoins(AuditLogEntity, TestUserEntity);
    const result = await repo.findByPage<AuditLogEntity>(
      AuditLogEntity,
      1,
      10,
      [
        Project.field(field(AuditLogEntity, "id")),
        Project.field(field(AuditLogEntity, "changed_by")),
        ...joinProjections,
      ],
      {
        tableName: "dal_test_simple_audit",
        joins,
        filters: [Filter.fieldValue(field(AuditLogEntity, "entity_uuid"), "=", source.uuid)],
      },
    );

    expect(result.entities).toHaveLength(1);
    const row = result.entities[0] as any;
    expect(row.changed_by).toBe("system");
    // The regex guardrail should prevent the join from matching → null
    expect(row.changed_by_display_name).toBeNull();
    expect(row.changed_by_idp_code).toBeNull();
  });
});
