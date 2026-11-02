import { describe, it, expect } from "vitest";
import "reflect-metadata";

import { Entity, Key, Column, withColumnConstraints } from "../src/index.js";
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
