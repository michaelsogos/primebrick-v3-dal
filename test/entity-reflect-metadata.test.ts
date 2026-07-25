import { describe, it, expect } from "vitest";
import "reflect-metadata";

import { Entity, Key, Unique, Column } from "../src/index.js";
import { SimpleTestEntity } from "./entities/simple-test-entity.js";

describe("Entity Reflect metadata (primebrick:tableName, primebrick:keyColumn)", () => {
  it("@Entity exposes the snake_case table name via Reflect.getMetadata", () => {
    const tableName = Reflect.getMetadata("primebrick:tableName", SimpleTestEntity);
    expect(tableName).toBe("dal_test_simple");
  });

  it("@Key exposes the key column via Reflect.getMetadata", () => {
    const keyCol = Reflect.getMetadata("primebrick:keyColumn", SimpleTestEntity) as {
      propertyKey: string;
      sqlName: string;
    };
    expect(keyCol).toBeDefined();
    expect(keyCol.propertyKey).toBe("id");
    expect(keyCol.sqlName).toBe("id");
  });

  it("@Entity with no table name argument defaults to the class name", () => {
    @Entity()
    class DefaultNameEntity {
      @Key() id!: bigint;
    }
    const tableName = Reflect.getMetadata("primebrick:tableName", DefaultNameEntity);
    expect(tableName).toBe("DefaultNameEntity");
  });

  it("@Entity with explicit table name uses the explicit name", () => {
    @Entity("custom_table_name")
    class CustomEntity {
      @Key() id!: bigint;
    }
    const tableName = Reflect.getMetadata("primebrick:tableName", CustomEntity);
    expect(tableName).toBe("custom_table_name");
  });

  it("@Key with @Column({ sqlName }) exposes the sqlName, not the property key", () => {
    @Entity("test_sql_name")
    class SqlNameEntity {
      @Key()
      @Column("custom_id")
      myId!: bigint;
    }
    const keyCol = Reflect.getMetadata("primebrick:keyColumn", SqlNameEntity) as {
      propertyKey: string;
      sqlName: string;
    };
    expect(keyCol.propertyKey).toBe("myId");
    expect(keyCol.sqlName).toBe("custom_id");
  });

  it("undecorated class has no primebrick Reflect metadata", () => {
    class PlainClass {
      id!: bigint;
    }
    expect(Reflect.getMetadata("primebrick:tableName", PlainClass)).toBeUndefined();
    expect(Reflect.getMetadata("primebrick:keyColumn", PlainClass)).toBeUndefined();
  });
});
