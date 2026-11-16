import "reflect-metadata";
import { describe, it, expect } from "vitest";

import {
  Entity,
  Column,
  Key,
  AuditTrail,
  AuditableField,
  AuditableFieldType,
  Partition,
  Retention,
  buildEntitySnapshot,
  buildSqlPatchFromMetaDiff,
  type SchemaMetaDiffV2,
  type UUID,
} from "../src/index.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";

/**
 * F2 — audit DDL shape + retention wiring in emitted patches.
 *
 * Contract:
 * - every `{table}_audit` is emitted uuid-PK `("uuid","changed_at")`,
 *   `uuidv7()` default, surrogate `id` eradicated; `entity_id` only while
 *   the parent still carries a surrogate bigint PK;
 * - every audit table gets a `part_config` retention UPDATE — default
 *   `"12 months"`, `@AuditTrail({retention})` overrides;
 * - domain `@Partition` + `@Retention` emit `part_config.retention` from
 *   the RETENTION decorator (partition only slices);
 * - `retention_keep_table = false` — audit is a bounded cost, not an archive.
 */

@Entity("sa_audit_default", "public")
@AuditTrail()
class SaAuditDefaultEntity {
  @Key()
  uuid!: UUID;

  @Column({ pgType: "text" })
  name!: string;

  @AuditableField(AuditableFieldType.VERSION)
  version!: number;
}

@Entity("sa_audit_custom", "public")
@AuditTrail({ retention: "6 months" })
class SaAuditCustomEntity {
  @Key()
  uuid!: UUID;

  @AuditableField(AuditableFieldType.VERSION)
  version!: number;
}

@Entity("sa_events", "public")
class SaEventsEntity {
  @Key()
  uuid!: UUID;

  @Partition({ interval: "1 month" })
  @Retention("3 months")
  @Column({ nullable: false, jsType: "instant" })
  seen_at!: Date;
}

@Entity("sa_sweep", "public")
class SaSweepEntity {
  @Key()
  uuid!: UUID;

  @Retention("1 month")
  @Column({ nullable: false, jsType: "instant" })
  seen_at!: Date;
}

const patchFor = (classes: object[]) => {
  const snap = buildEntitySnapshot(classes as never[]);
  const diff: SchemaMetaDiffV2 = {
    version: 2,
    generatedAt: new Date().toISOString(),
    onlyInEntityTables: Object.keys(snap.tables),
    onlyInDatabaseTables: [],
    tables: {},
  } as SchemaMetaDiffV2;
  return { snap, sql: buildSqlPatchFromMetaDiff(snap, diff) };
};

describe("F2 — audit table DDL (id eradicated, uuid PK)", () => {
  it("uuid-PK parent → audit table has uuid PK, no id, no entity_id", () => {
    const { sql } = patchFor([SaAuditDefaultEntity]);
    expect(sql).toContain(`"uuid" uuid NOT NULL DEFAULT uuidv7()`);
    expect(sql).toContain(`PRIMARY KEY ("uuid", "changed_at")`);
    expect(sql).not.toContain(`"id" bigint`);
    expect(sql).not.toContain(`entity_id`);
    expect(sql).toContain(`PARTITION BY RANGE ("changed_at")`);
    expect(sql).toContain(`partman.create_parent('public.sa_audit_default_audit', 'changed_at', '1 month', 'range')`);
  });

  it("surrogate-id parent → audit keeps entity_id column (legacy shape)", () => {
    const { sql } = patchFor([SimpleTestEntity]);
    expect(sql).toContain(`"entity_id" bigint NOT NULL`);
    expect(sql).toContain(`PRIMARY KEY ("uuid", "changed_at")`);
  });
});

describe("F2 — audit retention via part_config", () => {
  it("@AuditTrail() → retention '12 months', keep_table=false", () => {
    const { sql } = patchFor([SaAuditDefaultEntity]);
    expect(sql).toContain(
      `UPDATE partman.part_config SET retention = '12 months', retention_keep_table = false WHERE parent_table = 'public.sa_audit_default_audit';`,
    );
  });

  it("@AuditTrail({retention:'6 months'}) → override wins", () => {
    const { sql } = patchFor([SaAuditCustomEntity]);
    expect(sql).toContain(`retention = '6 months'`);
    expect(sql).not.toContain(`retention = '12 months'`);
  });
});

describe("F2 — domain @Partition + @Retention separation", () => {
  it("partition slices, retention expires — emitted from @Retention", () => {
    const { snap, sql } = patchFor([SaEventsEntity]);
    expect(snap.tables["public.sa_events"].partition?.column).toBe("seen_at");
    expect(snap.tables["public.sa_events"].retention).toEqual({ column: "seen_at", duration: "3 months" });
    expect(sql).toContain(`partman.create_parent('public.sa_events', 'seen_at', '1 month', 'range')`);
    expect(sql).toContain(`retention = '3 months'`);
  });

  it("@Retention without @Partition → row-sweep meta, no partition DDL", () => {
    const { snap, sql } = patchFor([SaSweepEntity]);
    expect(snap.tables["public.sa_sweep"].partition).toBeUndefined();
    expect(snap.tables["public.sa_sweep"].retention).toEqual({ column: "seen_at", duration: "1 month" });
    expect(sql).not.toContain(`partman.create_parent('public.sa_sweep'`);
  });
});
