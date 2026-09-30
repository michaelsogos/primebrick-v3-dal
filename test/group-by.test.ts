/**
 * group-by — buildSelectQuery GROUP BY/HAVING unit tests. Pure builder (no
 * DB): verifies clause placement, auto-grouping of non-aggregate projectors
 * (correctness-by-construction), joined display columns, param safety, and
 * that COUNT(*) OVER() totals count groups (pagination-safe).
 */
import "reflect-metadata";
import { describe, it, expect } from "vitest";

import { buildSelectQuery } from "../src/query/query-builder.js";
import { Filter, field, Project, Sort } from "../src/query/dsl.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";

describe("buildSelectQuery — GROUP BY / HAVING", () => {
  it("renders no GROUP BY when groupBy is absent", () => {
    const q = buildSelectQuery({ entity: SimpleTestEntity });
    expect(q.text).not.toContain("GROUP BY");
    expect(q.text).not.toContain("HAVING");
  });

  it("auto-groups the default all-columns projection (functional-dep safe)", () => {
    const q = buildSelectQuery({
      entity: SimpleTestEntity,
      groupBy: [field(SimpleTestEntity, "id")],
    });
    const m = q.text.match(/GROUP BY (.+?)($| ORDER BY| LIMIT| HAVING)/);
    expect(m).toBeTruthy();
    const cols = m![1];
    expect(cols).toContain('"dal_test_simple"."id"');
    expect(cols).toContain('"dal_test_simple"."name"');
    expect(cols).toContain('"dal_test_simple"."uuid"');
  });

  it("auto-groups explicit field projectors; expr projectors are never grouped", () => {
    const q = buildSelectQuery({
      entity: SimpleTestEntity,
      fields: [
        Project.field(field(SimpleTestEntity, "name")),
        Project.expr("COUNT(u.id)", "member_count"),
      ],
      groupBy: [field(SimpleTestEntity, "id")],
    });
    const m = q.text.match(/GROUP BY (.+?)($| ORDER BY| LIMIT| HAVING)/);
    const cols = m![1];
    expect(cols).toContain('"dal_test_simple"."id"');
    expect(cols).toContain('"dal_test_simple"."name"');
    expect(cols).not.toContain("COUNT");
    expect(q.text).toContain('COUNT(u.id) AS "member_count"');
  });

  it("GROUP BY precedes ORDER BY/LIMIT/OFFSET and follows WHERE", () => {
    const q = buildSelectQuery({
      entity: SimpleTestEntity,
      filters: [Filter.fieldValue(field(SimpleTestEntity, "name"), "=", "x")],
      groupBy: [field(SimpleTestEntity, "id")],
      sorting: [Sort.by(field(SimpleTestEntity, "name"), "ASC")],
      limit: 25,
      offset: 50,
    });
    const iWhere = q.text.indexOf("WHERE");
    const iGroup = q.text.indexOf("GROUP BY");
    const iOrder = q.text.indexOf("ORDER BY");
    const iLimit = q.text.indexOf("LIMIT");
    expect(iWhere).toBeGreaterThan(-1);
    expect(iGroup).toBeGreaterThan(iWhere);
    expect(iOrder).toBeGreaterThan(iGroup);
    expect(iLimit).toBeGreaterThan(iOrder);
  });

  it("renders HAVING after GROUP BY with parameterized/raw aggregate predicates", () => {
    const q = buildSelectQuery({
      entity: SimpleTestEntity,
      groupBy: [field(SimpleTestEntity, "id")],
      having: [
        Filter.raw("COUNT(u.id)", ">", "0"),
        Filter.fieldValue(field(SimpleTestEntity, "name"), "=", "x", "AND"),
      ],
    });
    expect(q.text).toContain("HAVING");
    const iGroup = q.text.indexOf("GROUP BY");
    const iHaving = q.text.indexOf("HAVING");
    expect(iHaving).toBeGreaterThan(iGroup);
    expect(q.text).toContain("COUNT(u.id) > 0");
    // field_value predicates are parameterized ($n)
    expect(q.values).toContain("x");
  });

  it("respects the operand when joining multiple HAVING conditions", () => {
    const q = buildSelectQuery({
      entity: SimpleTestEntity,
      groupBy: [field(SimpleTestEntity, "id")],
      having: [
        Filter.raw("COUNT(u.id)", ">", "0"),
        Filter.raw("COUNT(u.id)", "<", "10", "OR"),
      ],
    });
    const havingPart = q.text.slice(q.text.indexOf("HAVING"));
    expect(havingPart).toContain("OR");
  });

  it("pagination total counts GROUPS: COUNT(*) OVER() sits on the grouped result", () => {
    const q = buildSelectQuery({
      entity: SimpleTestEntity,
      groupBy: [field(SimpleTestEntity, "id")],
      includeTotalRecordsWindow: true,
      limit: 25,
    });
    // window function is in the SELECT list of the grouped query → counts groups
    expect(q.text).toContain('COUNT(*) OVER() AS "_total_records"');
    expect(q.text).toContain("GROUP BY");
  });

  it("auto-groups auditable-join display columns when joins are present", () => {
    const q = buildSelectQuery({
      entity: SimpleTestEntity,
      groupBy: [field(SimpleTestEntity, "id")],
      joins: [
        {
          left: field(SimpleTestEntity, "created_by"),
          right: field(SimpleTestEntity, "uuid"),
          type: "LEFT",
          alias: "creator",
        },
      ],
    });
    const m = q.text.match(/GROUP BY (.+?)($| ORDER BY| LIMIT| HAVING)/);
    expect(m![1]).toContain('"creator".display_name');
  });
});
