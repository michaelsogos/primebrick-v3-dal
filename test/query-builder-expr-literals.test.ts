/**
 * renderExprOperand — `?` inside single-quoted SQL literals must NOT be
 * treated as a parameter marker. Regex-heavy @Calculated expressions
 * (`'^(?:trigger|rule):(.+)$'`, `'^jobs\.schedule\.[^.]+\.'`) carry `?`
 * characters inside literals; a naive marker count consumed them as
 * params and threw `more '?' markers than params` on the read path.
 * `''` escapes inside literals are handled too.
 */
import "reflect-metadata";
import { describe, it, expect } from "vitest";

import { buildSelectQuery } from "../src/query/query-builder.js";
import { Project, field, Filter } from "../src/query/dsl.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";

describe("buildSelectQuery — '?' inside SQL string literals", () => {
  it("leaves '?:' non-capture groups and regex literals verbatim, binds real markers", () => {
    const q = buildSelectQuery({
      entity: SimpleTestEntity,
      fields: [
        { kind: "field", field: field(SimpleTestEntity, "uuid" as never) },
        Project.expr(
          `COALESCE(SUBSTRING(name FROM '^(?:trigger|rule):(.+)$'), 'it''s literal ? ok', name)`,
          "actor_name",
        ),
      ],
    });
    // The literal survives byte-for-byte — '?:' and '?' untouched.
    expect(q.text).toContain(`'^(?:trigger|rule):(.+)$'`);
    expect(q.text).toContain(`'it''s literal ? ok'`);
    // And consumed zero params — nothing matched outside literals.
    expect(q.values).toHaveLength(0);
  });

  it("binds real '?' markers around literals in order", () => {
    const q = buildSelectQuery({
      entity: SimpleTestEntity,
      filters: [
        Filter.expr(
          { sql: `COALESCE(x, 'prefix ? suffix')` },
          "ILIKE",
          { sql: "? ESCAPE '#'", params: ["needle"] },
        ),
      ],
    });
    expect(q.text).toContain(`'prefix ? suffix'`);
    expect(q.values).toEqual(["needle"]);
  });
});
