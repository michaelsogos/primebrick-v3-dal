import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { Repository }
from "../src/index.js";
import { REPO_INTERNAL } from "../src/repository/repository.js";
import { TypeTestEntity } from "./entities/type-test-entity.js";
import {
  getTestPool,
  closeTestPool,
  setupTestSchema,
  truncateTestTables,
} from "./helpers/setup.js";

describe("Repository — type mapping matrix (TypeTestEntity)", () => {
  let pool: Pool;
  let repo: Repository;

  beforeAll(async () => {
    pool = getTestPool();
    await setupTestSchema();
    repo = new Repository(pool, REPO_INTERNAL);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  beforeEach(async () => {
    await truncateTestTables();
  });

  describe("Integer types", () => {
    it("int_col: round-trips as number", async () => {
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "11111111-1111-7111-8111-111111111111",
          int_col: 42,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.int_col).toBe(42);
      expect(typeof found!.int_col).toBe("number");
    });

    it("int_col: negative values", async () => {
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "22222222-2222-7222-8222-222222222222",
          int_col: -100,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.int_col).toBe(-100);
    });

    it("int_col: zero", async () => {
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "33333333-3333-7333-8333-333333333333",
          int_col: 0,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.int_col).toBe(0);
    });
  });

  describe("BigInt type", () => {
    it("bigint_col: returns as native bigint", async () => {
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "44444444-4444-7444-8444-444444444444",
          int_col: 1,
          bigint_col: 9007199254740993n, // Number.MAX_SAFE_INTEGER + 2
          bool_col: true,
          varchar_col: "test",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.bigint_col).toBe(9007199254740993n);
      expect(typeof found!.bigint_col).toBe("bigint");
    });

    it("bigint_col: small value still returns as bigint", async () => {
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "55555555-5555-7555-8555-555555555555",
          int_col: 1,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.bigint_col).toBe(1n);
      expect(typeof found!.bigint_col).toBe("bigint");
    });
  });

  describe("Boolean type", () => {
    it("bool_col: true round-trips", async () => {
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "66666666-6666-7666-8666-666666666666",
          int_col: 1,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.bool_col).toBe(true);
    });

    it("bool_col: false round-trips", async () => {
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "77777777-7777-7777-8777-777777777777",
          int_col: 1,
          bigint_col: 1n,
          bool_col: false,
          varchar_col: "test",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.bool_col).toBe(false);
    });
  });

  describe("String types", () => {
    it("varchar_col: round-trips as string", async () => {
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "88888888-8888-7888-8888-888888888888",
          int_col: 1,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "hello world",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.varchar_col).toBe("hello world");
    });

    it("text_col: nullable — null stays null", async () => {
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "99999999-9999-7999-8999-999999999999",
          int_col: 1,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          // text_col omitted
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.text_col == null).toBe(true);
    });

    it("text_col: non-null value", async () => {
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
          int_col: 1,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          text_col: "some text",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.text_col).toBe("some text");
    });
  });

  describe("Numeric/Decimal types", () => {
    it("numeric_col(15,2): returns as number", async () => {
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb",
          int_col: 1,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          numeric_col: 123.45,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(String(found!.numeric_col)).toBe("123.45");
      expect(found!.numeric_col.constructor.name).toBe("Decimal");
    });

    it("numeric_col(15,2): large value within safe integer range", async () => {
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "cccccccc-cccc-7ccc-8ccc-cccccccccccc",
          int_col: 1,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          numeric_col: 99999999999.99,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(String(found!.numeric_col)).toBe("99999999999.99");
    });

    it("big_numeric_col(38,0): returns as string (overflows Number)", async () => {
      const bigValue = "12345678901234567890123456789012345678";
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "dddddddd-dddd-7ddd-8ddd-dddddddddddd",
          int_col: 1,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          numeric_col: 1.0,
          big_numeric_col: bigValue,
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.big_numeric_col.constructor.name).toBe("Decimal");
      expect(String(found!.big_numeric_col)).toBe(bigValue);
    });

    it("decimal_col(10,4): returns as number", async () => {
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee",
          int_col: 1,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 123.4567,
          timestamp_col: new Date(),
          date_col: new Date(),
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(String(found!.decimal_col)).toBe("123.4567");
      expect(found!.decimal_col.constructor.name).toBe("Decimal");
    });
  });

  describe("Date/Timestamp types", () => {
    it("timestamp_col: returns as JS Date", async () => {
      const ts = new Date("2024-01-15T10:30:00.000Z");
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "ffffffff-ffff-7fff-8fff-ffffffffffff",
          int_col: 1,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: ts,
          date_col: new Date(),
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.timestamp_col).toBeInstanceOf(Date);
      expect(found!.timestamp_col!.toISOString()).toBe("2024-01-15T10:30:00.000Z");
    });

    it("date_col: returns as JS Date", async () => {
      const d = new Date("2024-06-15");
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "10101010-1010-7010-8010-101010101010",
          int_col: 1,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: d,
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.date_col).toBeInstanceOf(Date);
    });

    it("date_col: date-only storage (no time component)", async () => {
      const d = new Date("2024-06-15T23:59:59.000Z");
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "12121212-1212-7212-8212-121212121212",
          int_col: 1,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: d,
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.date_col).toBeInstanceOf(Date);
      // Use local date methods — PostgreSQL date has no timezone
      const dateVal = found!.date_col!;
      expect(dateVal.getFullYear()).toBe(2024);
      expect(dateVal.getMonth()).toBe(5); // June = month 5 (0-indexed)
      expect(dateVal.getDate()).toBe(15);
    });
  });

  describe("JSONB type", () => {
    it("jsonb_col: stores and retrieves object", async () => {
      const obj = { key: "value", nested: { a: 1 } };
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "13131313-1313-7313-8313-131313131313",
          int_col: 1,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
          jsonb_col: obj,
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.jsonb_col).not.toBeNull();
      expect((found!.jsonb_col as any).key).toBe("value");
      expect((found!.jsonb_col as any).nested.a).toBe(1);
    });

    it("jsonb_col: null when not provided", async () => {
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "14141414-1414-7414-8414-141414141414",
          int_col: 1,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
          // jsonb_col omitted
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.jsonb_col == null).toBe(true);
    });

    it("jsonb_col: array storage", async () => {
      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "15151515-1515-7515-8515-151515151515",
          int_col: 1,
          bigint_col: 1n,
          bool_col: true,
          varchar_col: "test",
          numeric_col: 1.0,
          big_numeric_col: "1",
          decimal_col: 1.0,
          timestamp_col: new Date(),
          date_col: new Date(),
          jsonb_col: [1, 2, 3] as any,
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      expect(found!.jsonb_col).toEqual([1, 2, 3]);
    });
  });

  describe("Combined / edge cases", () => {
    it("all columns together: full row round-trip", async () => {
      const ts = new Date("2024-03-20T08:15:30.000Z");
      const dateOnly = new Date("2024-03-20");
      const jsonb = { combined: true, items: [1, 2, 3] };

      const added = await repo.add(
        TypeTestEntity,
        {
          uuid: "16161616-1616-7616-8616-161616161616",
          int_col: 7,
          bigint_col: 9007199254740993n,
          bool_col: true,
          varchar_col: "full row",
          text_col: "text value",
          numeric_col: 987.65,
          big_numeric_col: "99999999999999999999999999999999999999",
          decimal_col: 12.3456,
          timestamp_col: ts,
          date_col: dateOnly,
          jsonb_col: jsonb,
        } as any,
        { actor: "test-user" }
      );

      const found = await repo.findByUUID(TypeTestEntity, added.uuid);
      expect(found).not.toBeNull();
      const row = found!;

      expect(row.uuid).toBe("16161616-1616-7616-8616-161616161616");
      expect(row.int_col).toBe(7);
      expect(typeof row.int_col).toBe("number");
      expect(row.bigint_col).toBe(9007199254740993n);
      expect(typeof row.bigint_col).toBe("bigint");
      expect(row.bool_col).toBe(true);
      expect(row.varchar_col).toBe("full row");
      expect(row.text_col).toBe("text value");
      expect(String(row.numeric_col)).toBe("987.65");
      expect(row.numeric_col.constructor.name).toBe("Decimal");
      expect(row.big_numeric_col.constructor.name).toBe("Decimal");
      expect(String(row.big_numeric_col)).toBe("99999999999999999999999999999999999999");
      expect(String(row.decimal_col)).toBe("12.3456");
      expect(row.decimal_col.constructor.name).toBe("Decimal");
      expect(row.timestamp_col).toBeInstanceOf(Date);
      expect(row.timestamp_col!.toISOString()).toBe("2024-03-20T08:15:30.000Z");
      expect(row.date_col).toBeInstanceOf(Date);
      // Use local date methods — PostgreSQL date has no timezone
      const rowDate = row.date_col!;
      expect(rowDate.getFullYear()).toBe(2024);
      expect(rowDate.getMonth()).toBe(2); // March = month 2 (0-indexed)
      expect(rowDate.getDate()).toBe(20);
      expect(row.jsonb_col).toEqual(jsonb);
    });
  });
});
