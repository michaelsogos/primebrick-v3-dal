import { describe, it, expect } from "vitest";
import "reflect-metadata";

import { Entity, Key, Unique, Column, withColumnConstraints, EntityBase, Auditable, Deletable, type UUID } from "../src/index.js";
import type { EntityMeta } from "@primebrick/core";

@Entity("cc_rules", "job")
class CcRuleEntity {
  @Key() id!: bigint;
  @Column({ length: 200, nullable: false }) name!: string;
  @Column({ nullable: false }) event_subject!: string;
  @Column({ nullable: true }) filter?: unknown;
  @Column({ length: 10, nullable: false, defaultSql: "'user'" }) execution_context!: string;
  @Column({ nullable: false }) enabled!: boolean;
}

const baseMeta = (): EntityMeta => ({
  entity: "cc_rule",
  translation_key: "cc_rule",
  uid: "uuid",
  display_field: "name",
  columns: [
    { key: "name", label_key: "x.name", type: "text", order: 10 },
    { key: "event_subject", label_key: "x.event_subject", type: "text", order: 20 },
    { key: "filter", label_key: "x.filter", type: "text", order: 30 },
    { key: "execution_context", label_key: "x.lane", type: "badge", order: 40 },
    { key: "enabled", label_key: "x.enabled", type: "boolean", order: 50 },
  ],
});

describe("withColumnConstraints", () => {
  it("injects nullable / max_length / pg_type derived from the entity class", () => {
    const out = withColumnConstraints(baseMeta(), CcRuleEntity);
    const byKey = Object.fromEntries(out.columns.map((c) => [c.key, c]));
    expect(byKey.name).toMatchObject({ nullable: false, max_length: 200 });
    expect(byKey.event_subject).toMatchObject({ nullable: false });
    expect(byKey.event_subject?.max_length).toBeUndefined(); // text — no length
    expect(byKey.filter).toMatchObject({ nullable: true });
    expect(byKey.execution_context).toMatchObject({ nullable: false, max_length: 10 });
    for (const c of out.columns) expect(typeof c.pg_type).toBe("string");
  });

  it("throws when an authored column restates a derived prop", () => {
    const meta = baseMeta();
    meta.columns[0] = { ...meta.columns[0]!, max_length: 999 } as never;
    expect(() => withColumnConstraints(meta, CcRuleEntity)).toThrow(/restates derived prop/);
  });

  it("throws on a non-virtual column key missing from the entity class", () => {
    const meta = baseMeta();
    meta.columns.push({ key: "ghost_field", label_key: "x.ghost", type: "text", order: 60 });
    expect(() => withColumnConstraints(meta, CcRuleEntity)).toThrow(/no matching column/);
  });

  it("lets explicitly-virtual columns through untouched", () => {
    const meta = baseMeta();
    meta.columns.push({
      key: "run_stats", label_key: "x.stats", type: "sparkline", order: 60,
      sparkline: { endpoint: "/actions/x", request_field: "k", row_key: "k", series: [] },
    } as never);
    const out = withColumnConstraints(meta, CcRuleEntity);
    const stats = out.columns.find((c) => c.key === "run_stats");
    expect(stats?.nullable).toBeUndefined();
    expect(stats?.pg_type).toBeUndefined();
  });
});

// ── Class → meta completeness (auto-derivation) ────────────────────────────

@Entity("cc_jobs", "job")
class CcJobEntity extends Deletable(Auditable(EntityBase)) {
  @Key() id!: bigint;
  @Unique() uuid!: UUID;
  @Column({ nullable: false }) name!: string;
  @Column({ nullable: true }) payload_map?: unknown;
}

const auditableMeta = (): EntityMeta => ({
  entity: "cc_job",
  translation_key: "cc_job",
  entities_ns: "job",
  uid: "uuid",
  display_field: "name",
  columns: [
    { key: "name", label_key: "job.entities.cc_job.fields.name", type: "text", order: 10 },
  ],
});

describe("withColumnConstraints — class→meta auto-derivation", () => {
  it("auto-derives every physical column missing from meta (audit, delete, uuid, version)", () => {
    const out = withColumnConstraints(auditableMeta(), CcJobEntity);
    const keys = out.columns.map((c) => c.key);
    for (const k of ["uuid", "id", "name", "created_at", "created_by", "updated_at", "updated_by", "version", "deleted_at", "deleted_by", "payload_map"]) {
      expect(keys, `missing ${k}`).toContain(k);
    }
    const byKey = Object.fromEntries(out.columns.map((c) => [c.key, c]));
    // system cols: hidden-by-default, audited group, i18n key by convention
    expect(byKey.created_by).toMatchObject({ audited: true, default_visible: false, label_key: "job.entities.cc_job.fields.created_by" });
    expect(byKey.deleted_at).toMatchObject({ audited: true, default_visible: false, type: "datetime" });
    expect(byKey.uuid).toMatchObject({ order: -1, sticky: true, default_visible: false });
    expect(byKey.version).toMatchObject({ type: "number", audited: true });
    // non-declared field is auto-derived hidden-by-default
    expect(byKey.payload_map).toMatchObject({ default_visible: false });
    // derived physical props still injected
    expect(typeof byKey.created_by?.pg_type).toBe("string");
  });

  it("`hidden: true` suppresses a physical column entirely (no emission, no derivation)", () => {
    const meta = auditableMeta();
    meta.columns.push({ key: "payload_map", label_key: "x", type: "text", order: 20, hidden: true });
    const out = withColumnConstraints(meta, CcJobEntity);
    expect(out.columns.map((c) => c.key)).not.toContain("payload_map");
  });

  it("authored column wins over derivation (dedupe by key)", () => {
    const meta = auditableMeta();
    meta.columns.push({ key: "created_at", label_key: "custom.label", type: "datetime", order: 70, default_visible: true });
    const out = withColumnConstraints(meta, CcJobEntity);
    const createdAt = out.columns.filter((c) => c.key === "created_at");
    expect(createdAt).toHaveLength(1);
    expect(createdAt[0]).toMatchObject({ label_key: "custom.label", order: 70, default_visible: true });
  });
});
