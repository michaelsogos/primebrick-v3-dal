import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Entity, AuditTrail } from "../src/index.js";
import { runPartitionMaintenance } from "../src/dal/partition-maintenance.js";
import { getTestPool, closeTestPool } from "./helpers/setup.js";

/**
 * runPartitionMaintenance — audit-table fallback contract.
 *
 * Every `{entity}_audit` table is a retention surface: partman-registered
 * parents drop whole partitions, but an audit table that exists WITHOUT a
 * part_config row (e.g. user_profiles_audit predating the partition
 * convention, or an audit table on a plain table) still gets retention —
 * as a row-level sweep on `changed_at` at the declared audit retention.
 * The sweep path never depends on physical partitioning.
 *
 *   pm_sweep_target has @AuditTrail but NO partman registration → the
 *   executor must route it to `sweeps`, not `parents`.
 */
@Entity("pm_sweep_target", "public")
@AuditTrail()
class PmSweepTargetEntity {
  declare uuid: string;
  declare entity_id: number | null;
}

describe("runPartitionMaintenance — unregistered audit table → row sweep", () => {
  const pool = () => getTestPool();

  beforeAll(async () => {
    await pool().query(`
      CREATE TABLE IF NOT EXISTS pm_sweep_target_audit (
        uuid        uuid NOT NULL DEFAULT uuidv7() PRIMARY KEY,
        entity_id   bigint,
        entity_uuid uuid NOT NULL,
        action      text NOT NULL,
        changed_at  timestamptz NOT NULL DEFAULT now(),
        changed_by  text NOT NULL DEFAULT '',
        version     integer NOT NULL DEFAULT 1,
        delta       jsonb
      );
      TRUNCATE TABLE pm_sweep_target_audit;
      INSERT INTO pm_sweep_target_audit (entity_uuid, action, changed_at, changed_by, version, delta)
      VALUES
        (uuidv7(), 'UPDATE', now() - interval '2 years', 'test', 1, '{}'),
        (uuidv7(), 'UPDATE', now() - interval '1 day',   'test', 2, '{}');
    `);
    // Safety: a stale part_config row for a test table must never exist —
    // but the test database may not carry pg_partman at all (42P01-safe).
    await pool().query(`
      DO $$
      BEGIN
        IF to_regclass('partman.part_config') IS NOT NULL THEN
          DELETE FROM partman.part_config WHERE parent_table = 'public.pm_sweep_target_audit';
        END IF;
      END $$;
    `);
  });

  afterAll(async () => {
    await pool().query(`DROP TABLE IF EXISTS pm_sweep_target_audit`);
    await closeTestPool();
  });

  it("non-registered audit table sweeps rows older than the 12-month default", async () => {
    const client = await pool().connect();
    try {
      const report = await runPartitionMaintenance(client, [PmSweepTargetEntity]);
      const sweep = report.sweeps.find((s) => s.table.includes("pm_sweep_target_audit"));
      expect(sweep).toBeDefined();
      expect(sweep!.column).toBe("changed_at");
      expect(sweep!.retention).toBe("12 months");
      expect(sweep!.rows_deleted).toBe(1);
      expect(
        report.parents.find((p) => p.table.includes("pm_sweep_target_audit")),
      ).toBeUndefined();
      const remaining = await pool().query(`SELECT count(*)::int AS c FROM pm_sweep_target_audit`);
      expect(remaining.rows[0]!.c).toBe(1);
    } finally {
      client.release();
    }
  });
});
