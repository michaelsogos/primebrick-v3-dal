import { describe, it, expect } from "vitest";
import "reflect-metadata";

import { Entity, Key, Unique, Column, Calculated, withColumnConstraints, EntityBase, Auditable, Deletable, type UUID, type Decimal } from "../src/index.js";
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
      kind: "virtual",
      sparkline: { endpoint: "/actions/x", request_field: "k", row_key: "k", series: [] },
    } as never);
    const out = withColumnConstraints(meta, CcRuleEntity);
    const stats = out.columns.find((c) => c.key === "run_stats");
    expect(stats?.nullable).toBeUndefined();
    expect(stats?.pg_type).toBeUndefined();
  });

  it("throws when a virtual column forces a query flag on", () => {
    const meta = baseMeta();
    meta.columns.push({
      key: "run_stats", label_key: "x.stats", type: "sparkline", order: 60,
      kind: "virtual", sortable: true,
    } as never);
    expect(() => withColumnConstraints(meta, CcRuleEntity)).toThrow(/virtual column "run_stats" forces sortable:true/);
  });

  it("throws on an options_source outside the closed vocabulary", () => {
    const meta = baseMeta();
    meta.columns[1] = { ...meta.columns[1]!, options_source: "bogus.src" } as never;
    expect(() => withColumnConstraints(meta, CcRuleEntity)).toThrow(/options_source "bogus.src" is not a declared vocabulary/);
  });

  it("throws on census options_source + allow_create:true (closed vocabulary)", () => {
    const meta = baseMeta();
    meta.columns[1] = { ...meta.columns[1]!, options_source: "census.emits", allow_create: true };
    expect(() => withColumnConstraints(meta, CcRuleEntity)).toThrow(/allow_create:true on a census options_source/);
  });

  it("accepts census options_source with allow_create absent/false", () => {
    const meta = baseMeta();
    meta.columns[1] = { ...meta.columns[1]!, options_source: "census.emits" };
    const out = withColumnConstraints(meta, CcRuleEntity);
    expect(out.columns.find((c) => c.key === "event_subject")?.options_source).toBe("census.emits");
  });

  it("throws when kind:\"calculated\" has no @Calculated prop on the class", () => {
    const meta = baseMeta();
    meta.columns.push({ key: "ghost_calc", label_key: "x.gc", type: "number", order: 60, kind: "calculated" });
    expect(() => withColumnConstraints(meta, CcRuleEntity)).toThrow(/no @Calculated property/);
  });

  it("accepts kind:\"calculated\" backed by a @Calculated prop and auto-derives undeclared ones", () => {
    @Entity("cc_calc", "job")
    class CcCalcEntity {
      @Key() id!: bigint;
      @Column({ nullable: false }) name!: string;
      @Calculated(`(SELECT 'x' WHERE {self}.id IS NOT NULL)`) ghost?: string;
      @Calculated(`(SELECT count(*) FROM job.cc_calc)` , { sqlName: "total_count" }) total?: number;
    }
    const meta: EntityMeta = {
      entity: "cc_calc", translation_key: "cc_calc", uid: "id",
      display_field: "name",
      columns: [
        { key: "name", label_key: "x.name", type: "text", order: 10 },
        { key: "total_count", label_key: "x.total", type: "number", order: 20, kind: "calculated" },
      ],
    };
    const out = withColumnConstraints(meta, CcCalcEntity);
    const byKey = Object.fromEntries(out.columns.map((c) => [c.key, c]));
    expect(byKey.total_count?.kind).toBe("calculated");
    // undeclared @Calculated prop auto-derives as a hidden calculated column
    expect(byKey.ghost).toMatchObject({ kind: "calculated", default_visible: false });
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
    expect(byKey.created_by).toMatchObject({ audited: true, default_visible: false, label_key: "system.common.fields.created_by" });
    expect(byKey.deleted_at).toMatchObject({ audited: true, default_visible: false, type: "datetime" });
    expect(byKey.uuid).toMatchObject({ order: -1, sticky: true, default_visible: false });
    expect(byKey.version).toMatchObject({ type: "number", audited: true });
    // non-declared field is auto-derived hidden-by-default
    expect(byKey.payload_map).toMatchObject({ default_visible: false });
    // derived physical props still injected
    expect(typeof byKey.created_by?.pg_type).toBe("string");
    // identity @Key → managed: server-generated, never required on create
    expect(byKey.id).toMatchObject({ managed: true, nullable: false });
    expect(byKey.uuid?.managed).toBeUndefined(); // unique ≠ key
  });

  it("manual @Key stays client-writable (no managed)", () => {
    @Entity("cc_manual", "job")
    class CcManualEntity {
      @Key({ generated: "manual" }) code!: string;
      @Column({ nullable: false }) name!: string;
    }
    const meta: EntityMeta = {
      entity: "cc_manual", translation_key: "cc_manual", uid: "code",
      display_field: "name",
      columns: [{ key: "name", label_key: "x.name", type: "text", order: 10 }],
    };
    const out = withColumnConstraints(meta, CcManualEntity);
    const code = out.columns.find((c) => c.key === "code");
    expect(code?.managed).toBeUndefined();
    expect(code?.nullable).toBe(false);
  });

  it("throws when a column authors managed (class-owned derived prop)", () => {
    const meta = baseMeta();
    meta.columns[0] = { ...meta.columns[0]!, managed: true } as never;
    expect(() => withColumnConstraints(meta, CcRuleEntity)).toThrow(/authors managed/);
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

// ── uom / unsigned contract ─────────────────────────────────────────────
describe("uom + unsigned constraints", () => {
	@Entity("cc_priced", "job")
	class CcPricedEntity {
		@Column({ nullable: false }) amount!: number; // float8 → kind number
		@Column({ length: 3, nullable: false }) amount_currency!: string; // uom sibling
		@Column({ nullable: true }) qty?: Decimal; // numeric → kind decimal
		@Column({ length: 4, nullable: true }) qty_uom?: string;
	}

	const pricedMeta = (cols: Partial<import("@primebrick/core").MetaColumn>[]): EntityMeta => ({
		entity: "cc_priced", translation_key: "cc_priced", uid: "amount",
		display_field: "amount",
		columns: cols.map((c, i) => ({
			key: "amount", label_key: "x", type: "number", order: i + 1, ...c,
		})) as import("@primebrick/core").MetaColumn[],
	}) as unknown as EntityMeta;

	it("percent uom needs no sibling field", () => {
		const meta = pricedMeta([{ uom: { kind: "percent" } }]);
		expect(() => withColumnConstraints(meta, CcPricedEntity)).not.toThrow();
	});

	it("percent uom with a declared field throws (transform-only)", () => {
		const meta = pricedMeta([{ uom: { kind: "percent", field: "amount_currency" } as never }]);
		expect(() => withColumnConstraints(meta, CcPricedEntity)).toThrow(/uom:"percent" declares a sibling field/);
	});

	it("currency uom without a physical sibling field throws", () => {
		const meta = pricedMeta([{ uom: { kind: "currency", field: "nope_currency" } }]);
		expect(() => withColumnConstraints(meta, CcPricedEntity)).toThrow(/must name a physical column/);
	});

	it("currency uom with a real sibling passes", () => {
		const meta = pricedMeta([{ uom: { kind: "currency", field: "amount_currency" } }]);
		expect(() => withColumnConstraints(meta, CcPricedEntity)).not.toThrow();
	});

	it("currency uom with a bogus source throws", () => {
		const meta = pricedMeta([{ uom: { kind: "currency", field: "amount_currency", source: "bogus" as never } }]);
		expect(() => withColumnConstraints(meta, CcPricedEntity)).toThrow(/not a declared vocabulary/);
	});

	it("custom uom requires a valid source", () => {
		const meta = pricedMeta([{ uom: { kind: "custom", field: "qty_uom", source: "nope" as never } }]);
		expect(() => withColumnConstraints(meta, CcPricedEntity)).toThrow(/no valid source/);
		const ok = pricedMeta([
			{ key: "qty", type: "number", uom: { kind: "custom", field: "qty_uom", source: { entity: "uom" } } },
		]);
		expect(() => withColumnConstraints(ok, CcPricedEntity)).not.toThrow();
	});

	it("unknown uom kind throws", () => {
		const meta = pricedMeta([{ uom: { kind: "volume" } as never }]);
		expect(() => withColumnConstraints(meta, CcPricedEntity)).toThrow(/not a declared vocabulary/);
	});

	it("uom on a non-numeric column throws", () => {
		@Entity("cc_text", "job")
		class CcTextEntity {
			@Column({ nullable: false }) name!: string;
			@Column({ length: 3, nullable: false }) name_uom!: string;
		}
		const meta: EntityMeta = {
			entity: "cc_text", translation_key: "cc_text", uid: "name",
			display_field: "name",
			columns: [{
				key: "name", label_key: "x", type: "text", order: 1,
				uom: { kind: "custom", field: "name_uom", source: { entity: "uom" } },
			} as import("@primebrick/core").MetaColumn],
		} as unknown as EntityMeta;
		expect(() => withColumnConstraints(meta, CcTextEntity)).toThrow(/non-numeric column/);
	});

	it("unsigned on a non-numeric column throws", () => {
		const meta = baseMeta();
		meta.columns[0] = { ...meta.columns[0]!, unsigned: true } as never;
		expect(() => withColumnConstraints(meta, CcRuleEntity)).toThrow(/non-numeric column/);
	});

	it("unsigned on a numeric column passes", () => {
		const meta = pricedMeta([{ unsigned: true }]);
		expect(() => withColumnConstraints(meta, CcPricedEntity)).not.toThrow();
	});

	// ── depends_on ─────────────────────────────────────────────────────
	it("depends_on.field naming a non-physical column throws", () => {
		const meta = baseMeta();
		meta.columns[0] = {
			...meta.columns[0]!,
			depends_on: { field: "ghost_pivot" },
		} as never;
		expect(() => withColumnConstraints(meta, CcRuleEntity)).toThrow(/depends_on\.field "ghost_pivot" must name a physical column/);
	});

	it("depends_on.filter_field on a non-ref column throws", () => {
		const meta = baseMeta();
		meta.columns[0] = {
			...meta.columns[0]!,
			depends_on: { field: "event_subject", filter_field: "country" },
		} as never;
		expect(() => withColumnConstraints(meta, CcRuleEntity)).toThrow(/filter_field on type "text"/);
	});

	it("depends_on.filter_field on a ref column passes", () => {
		const meta = baseMeta();
		meta.columns[0] = {
			...meta.columns[0]!,
			type: "ref",
			ref: { entity: "legal_form" },
			depends_on: { field: "event_subject", filter_field: "event_subject" },
		} as never;
		expect(() => withColumnConstraints(meta, CcRuleEntity)).not.toThrow();
	});

	it("depends_on.control_prop on a ref column throws", () => {
		const meta = baseMeta();
		meta.columns[0] = {
			...meta.columns[0]!,
			type: "ref",
			ref: { entity: "contact_type" },
			depends_on: { field: "event_subject", control_prop: "value_kind" },
		} as never;
		expect(() => withColumnConstraints(meta, CcRuleEntity)).toThrow(/control_prop on a type:"ref" column/);
	});

	it("prop-reading facets require a ref-declared pivot", () => {
		const meta = baseMeta();
		// pivot `event_subject` is a plain text column — prop reads need its ROW
		meta.columns[0] = {
			...meta.columns[0]!,
			depends_on: { field: "event_subject", control_prop: "value_kind" },
		} as never;
		expect(() => withColumnConstraints(meta, CcRuleEntity)).toThrow(/must be declared type:"ref" with ref\.entity/);
	});

	it("disabled_when.prop requires a ref-declared pivot too", () => {
		const meta = baseMeta();
		meta.columns[0] = {
			...meta.columns[0]!,
			depends_on: { field: "event_subject", disabled_when: { equals: "private" } },
		} as never;
		expect(() => withColumnConstraints(meta, CcRuleEntity)).not.toThrow();
		meta.columns[0] = {
			...meta.columns[0]!,
			depends_on: { field: "event_subject", disabled_when: { prop: "code", equals: "private" } },
		} as never;
		expect(() => withColumnConstraints(meta, CcRuleEntity)).toThrow(/must be declared type:"ref" with ref\.entity/);
	});

	it("prop facets pass when the pivot is a declared ref column", () => {
		const meta = baseMeta();
		meta.columns[1] = {
			...meta.columns[1]!,
			type: "ref",
			ref: { entity: "customer_type" },
		} as never;
		meta.columns[0] = {
			...meta.columns[0]!,
			depends_on: { field: "event_subject", disabled_when: { prop: "code", equals: "private" } },
		} as never;
		expect(() => withColumnConstraints(meta, CcRuleEntity)).not.toThrow();
	});

	// ── ref.value_field — non-uid stored values can't detail-link ──────
	it("ref.value_field with route:'detail' (default) throws", () => {
		const meta = baseMeta();
		meta.columns[0] = {
			...meta.columns[0]!,
			type: "ref",
			ref: { entity: "local_address", value_field: "id" },
		} as never;
		expect(() => withColumnConstraints(meta, CcRuleEntity)).toThrow(/cannot feed a \[param\] detail route/);
	});

	it("ref.value_field + route:'list' without filter_field throws", () => {
		const meta = baseMeta();
		meta.columns[0] = {
			...meta.columns[0]!,
			type: "ref",
			ref: { entity: "local_address", value_field: "id", route: "list" },
		} as never;
		expect(() => withColumnConstraints(meta, CcRuleEntity)).toThrow(/no filter_field/);
	});

	it("ref.value_field + route:'list' + filter_field passes", () => {
		const meta = baseMeta();
		meta.columns[0] = {
			...meta.columns[0]!,
			type: "ref",
			ref: { entity: "local_address", value_field: "id", route: "list", filter_field: "id" },
		} as never;
		expect(() => withColumnConstraints(meta, CcRuleEntity)).not.toThrow();
	});

	it("ref.value_field + route:'none' passes", () => {
		const meta = baseMeta();
		meta.columns[0] = {
			...meta.columns[0]!,
			type: "ref",
			ref: { entity: "local_address", value_field: "id", route: "none" },
		} as never;
		expect(() => withColumnConstraints(meta, CcRuleEntity)).not.toThrow();
	});
});
