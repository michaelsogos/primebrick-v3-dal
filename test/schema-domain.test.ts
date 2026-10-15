import "reflect-metadata";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Entity, Key } from "../src/index.js";
import {
  configureSchemaDomain,
  resetSchemaDomain,
  resolveEntitySchema,
  assertEntitySchemaDomain,
  getQualifiedTableName,
  getEntityPersistenceMeta,
  SchemaDomainViolationError,
} from "../src/index.js";

@Entity("widgets")
class WidgetEntity {
  @Key() id!: bigint;
  name!: string;
}

@Entity("secret_things", "other_schema")
class ForeignEntity {
  @Key() id!: bigint;
}

@Entity("be_table", "public")
class BeOwnedEntity {
  @Key() id!: bigint;
}

@Entity("translations", "emailsender")
class EmailsenderTranslationEntity {
  @Key() id!: bigint;
}

describe("schema domain — configureSchemaDomain", () => {
  afterEach(() => resetSchemaDomain());

  it("accepts a valid schema list and sets primary = [0]", () => {
    const d = configureSchemaDomain(["ai", "aux"]);
    expect(d.primary).toBe("ai");
    expect([...d.allowed]).toEqual(["ai", "aux"]);
  });

  it("throws on empty or invalid schema names", () => {
    expect(() => configureSchemaDomain([])).toThrow(SchemaDomainViolationError);
    expect(() => configureSchemaDomain(["1bad", "ok"])).toThrow(/invalid name\(s\) \[1bad\]/);
    expect(() => configureSchemaDomain(["Evil-Schema"])).toThrow(/invalid name/);
  });
});

describe("schema domain — resolveEntitySchema", () => {
  afterEach(() => resetSchemaDomain());

  it("bare entity resolves to the domain primary once configured", () => {
    configureSchemaDomain(["ai"]);
    expect(resolveEntitySchema({})).toBe("ai");
  });

  it("explicit @Entity schema outside the domain throws", () => {
    configureSchemaDomain(["ai"]);
    expect(() => resolveEntitySchema({ tableSchema: "public" })).toThrow(/outside the declared domain/);
  });

  it("without a domain the caller fallback applies (inert guard)", () => {
    expect(resolveEntitySchema({})).toBe("public");
    expect(resolveEntitySchema({ tableSchema: "whatever" })).toBe("whatever");
  });

  it("sharedTables exempt the named table in any schema, other tables still throw", () => {
    configureSchemaDomain(["public", "system"], ["translations"]);
    // shared table in a foreign schema → allowed
    expect(resolveEntitySchema({ tableSchema: "emailsender", tableName: "translations" })).toBe("emailsender");
    // a different table in the same schema → still a violation
    expect(() => resolveEntitySchema({ tableSchema: "emailsender", tableName: "email_log" })).toThrow(
      /outside the declared domain/,
    );
    // shared table in a domain schema → fine either way
    expect(resolveEntitySchema({ tableSchema: "system", tableName: "translations" })).toBe("system");
  });

  it("query path: shared-table entity qualifies to its pinned schema outside the domain", () => {
    configureSchemaDomain(["public", "system"], ["translations"]);
    expect(getQualifiedTableName(EmailsenderTranslationEntity)).toBe('"emailsender"."translations"');
    expect(() => getQualifiedTableName(ForeignEntity)).toThrow(SchemaDomainViolationError);
  });
});

describe("schema domain — query-path enforcement", () => {
  afterEach(() => resetSchemaDomain());

  it("getQualifiedTableName emits qualified refs inside the domain", () => {
    configureSchemaDomain(["ai"]);
    expect(getQualifiedTableName(WidgetEntity)).toBe('"ai"."widgets"');
  });

  it("getQualifiedTableName throws for a foreign-schema entity", () => {
    configureSchemaDomain(["ai"]);
    expect(() => getQualifiedTableName(ForeignEntity)).toThrow(SchemaDomainViolationError);
  });

  it("multi-schema domains qualify to the pinned schema when allowed", () => {
    configureSchemaDomain(["public", "system", "custom"]);
    expect(getQualifiedTableName(BeOwnedEntity)).toBe('"public"."be_table"');
    expect(getQualifiedTableName(WidgetEntity)).toBe('"public"."widgets"');
  });

  it("getEntityPersistenceMeta uses the domain primary for bare entities", () => {
    configureSchemaDomain(["ai"]);
    expect(getEntityPersistenceMeta(WidgetEntity).tableSchema).toBe("ai");
    expect(() => getEntityPersistenceMeta(ForeignEntity)).toThrow(SchemaDomainViolationError);
  });
});

describe("schema domain — assertEntitySchemaDomain (boot guard)", () => {
  afterEach(() => resetSchemaDomain());

  it("passes when every entity resolves inside the declared set", () => {
    expect(() => assertEntitySchemaDomain([WidgetEntity], ["ai"])).not.toThrow();
    expect(() => assertEntitySchemaDomain([WidgetEntity, BeOwnedEntity], ["public", "system"])).not.toThrow();
  });

  it("throws listing every violating entity", () => {
    expect(() => assertEntitySchemaDomain([WidgetEntity, ForeignEntity], ["ai"])).toThrow(
      /ForeignEntity → "other_schema"\."secret_things"/,
    );
  });

  it("ignores non-entity entries in the registry", () => {
    expect(() => assertEntitySchemaDomain([WidgetEntity, "not-a-class", 42], ["ai"])).not.toThrow();
  });
});
