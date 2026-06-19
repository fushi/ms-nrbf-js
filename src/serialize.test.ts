import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deserialize } from "./deserialize.js";
import { serialize } from "./serialize.js";
import { PrimitiveTypeEnumeration } from "./enums.js";
import type { NrbfObject, NrbfValue } from "./types.js";

const fixturesDir = join(fileURLToPath(import.meta.url), "..", "__fixtures__");

function roundTrip(value: NrbfValue): NrbfValue {
  return deserialize(serialize(value)) as NrbfValue;
}

describe("serialize", () => {
  it("throws for bare primitives as root", () => {
    expect(() => serialize(42 as unknown as NrbfValue)).toThrow(TypeError);
    expect(() => serialize(null)).toThrow(TypeError);
    expect(() => serialize(true as unknown as NrbfValue)).toThrow(TypeError);
  });

  describe("string root", () => {
    it("round-trips a string", () => {
      expect(roundTrip("hello")).toBe("hello");
    });

    it("round-trips an empty string", () => {
      expect(roundTrip("")).toBe("");
    });

    it("round-trips a UTF-8 string", () => {
      expect(roundTrip("héllo 🌍")).toBe("héllo 🌍");
    });
  });

  describe("ArraySinglePrimitive", () => {
    it("round-trips an Int32 array", () => {
      expect(roundTrip([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it("round-trips a Boolean array", () => {
      expect(roundTrip([true, false, true])).toEqual([true, false, true]);
    });

    it("round-trips an Int64 (bigint) array", () => {
      expect(roundTrip([1n, 2n, 9007199254740993n])).toEqual([1n, 2n, 9007199254740993n]);
    });

    it("round-trips an empty array", () => {
      expect(roundTrip([])).toEqual([]);
    });
  });

  describe("ArraySingleString", () => {
    it("round-trips a string array", () => {
      expect(roundTrip(["a", "b", "c"])).toEqual(["a", "b", "c"]);
    });

    it("round-trips a string array with nulls", () => {
      expect(roundTrip(["a", null, "c"])).toEqual(["a", null, "c"]);
    });
  });

  describe("ArraySingleObject", () => {
    it("round-trips a mixed array", () => {
      expect(roundTrip([null, "x", null])).toEqual([null, "x", null]);
    });
  });

  describe("SystemClassWithMembersAndTypes", () => {
    it("round-trips a class with primitive members", () => {
      const obj: NrbfObject = { typeName: "Point", members: { x: 10, y: 20 } };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.typeName).toBe("Point");
      expect(result.members["x"]).toBe(10);
      expect(result.members["y"]).toBe(20);
    });

    it("round-trips a class with a string member", () => {
      const obj: NrbfObject = { typeName: "Person", members: { name: "Alice", age: 30 } };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members["name"]).toBe("Alice");
      expect(result.members["age"]).toBe(30);
    });

    it("round-trips a class with a null member", () => {
      const obj: NrbfObject = { typeName: "Container", members: { value: null } };
      expect((roundTrip(obj) as NrbfObject).members["value"]).toBeNull();
    });

    it("round-trips a class with a Double member", () => {
      const obj: NrbfObject = { typeName: "Stats", members: { ratio: 3.14, count: 7 } };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members["ratio"]).toBeCloseTo(3.14);
      expect(result.members["count"]).toBe(7);
    });

    it("round-trips a class with an array member", () => {
      const obj: NrbfObject = { typeName: "Wrapper", members: { items: [1, 2, 3] } };
      expect((roundTrip(obj) as NrbfObject).members["items"]).toEqual([1, 2, 3]);
    });

    it("round-trips a class with a nested object member", () => {
      const inner: NrbfObject = { typeName: "Point", members: { x: 5, y: 6 } };
      const outer: NrbfObject = { typeName: "Line", members: { start: inner } };
      const result = roundTrip(outer) as NrbfObject;
      const start = result.members["start"] as NrbfObject;
      expect(start.typeName).toBe("Point");
      expect(start.members["x"]).toBe(5);
    });
  });

  describe("ClassWithMembersAndTypes (library class)", () => {
    it("round-trips a class with a libraryName", () => {
      const obj: NrbfObject = {
        typeName: "MyApp.Config",
        libraryName: "MyApp, Version=1.0.0.0",
        members: { timeout: 30, debug: false },
      };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.typeName).toBe("MyApp.Config");
      expect(result.libraryName).toBe("MyApp, Version=1.0.0.0");
      expect(result.members["timeout"]).toBe(30);
      expect(result.members["debug"]).toBe(false);
    });
  });

  describe("ClassWithId", () => {
    it("reuses class metadata for multiple instances of the same type", () => {
      const p1: NrbfObject = { typeName: "Point", members: { x: 1, y: 2 } };
      const p2: NrbfObject = { typeName: "Point", members: { x: 3, y: 4 } };
      const result = roundTrip([p1, p2]) as NrbfObject[];
      expect(result[0]!.members["x"]).toBe(1);
      expect(result[1]!.members["x"]).toBe(3);
    });
  });

  describe("MemberReference (shared objects)", () => {
    it("writes a MemberReference when the same object appears twice", () => {
      const shared: NrbfObject = { typeName: "Tag", members: { label: "hot" } };
      const container: NrbfObject = { typeName: "Container", members: { a: shared, b: shared } };
      const result = roundTrip(container) as NrbfObject;
      expect((result.members["a"] as NrbfObject).members["label"]).toBe("hot");
      expect((result.members["b"] as NrbfObject).members["label"]).toBe("hot");
    });
  });

  describe("memberTypes type fidelity", () => {
    function typedObj(memberTypes: NrbfObject["memberTypes"], members: NrbfObject["members"]): NrbfObject {
      return { typeName: "T", memberTypes, members };
    }

    it("round-trips Single without promoting to Double", () => {
      const obj = typedObj({ v: PrimitiveTypeEnumeration.Single }, { v: 1.5 });
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members["v"]).toBeCloseTo(1.5, 4);
      expect(result.memberTypes?.["v"]).toBe(PrimitiveTypeEnumeration.Single);
    });

    it("round-trips UInt32 > Int32.MaxValue without promoting to Double", () => {
      const obj = typedObj({ v: PrimitiveTypeEnumeration.UInt32 }, { v: 4_294_967_295 });
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members["v"]).toBe(4_294_967_295);
      expect(result.memberTypes?.["v"]).toBe(PrimitiveTypeEnumeration.UInt32);
    });

    it("round-trips Byte without widening to Int32", () => {
      const obj = typedObj({ v: PrimitiveTypeEnumeration.Byte }, { v: 255 });
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members["v"]).toBe(255);
      expect(result.memberTypes?.["v"]).toBe(PrimitiveTypeEnumeration.Byte);
    });

    it("round-trips SByte without widening to Int32", () => {
      const obj = typedObj({ v: PrimitiveTypeEnumeration.SByte }, { v: -128 });
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members["v"]).toBe(-128);
      expect(result.memberTypes?.["v"]).toBe(PrimitiveTypeEnumeration.SByte);
    });

    it("round-trips Int16 without widening to Int32", () => {
      const obj = typedObj({ v: PrimitiveTypeEnumeration.Int16 }, { v: -32768 });
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members["v"]).toBe(-32768);
      expect(result.memberTypes?.["v"]).toBe(PrimitiveTypeEnumeration.Int16);
    });

    it("round-trips UInt16 without widening to Int32", () => {
      const obj = typedObj({ v: PrimitiveTypeEnumeration.UInt16 }, { v: 65535 });
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members["v"]).toBe(65535);
      expect(result.memberTypes?.["v"]).toBe(PrimitiveTypeEnumeration.UInt16);
    });

    it("round-trips PrimitiveArray of Single with correct element type", () => {
      const obj = typedObj({ vals: PrimitiveTypeEnumeration.Single }, { vals: [1.5, 2.5, 3.5] });
      const result = roundTrip(obj) as NrbfObject;
      const vals = result.members["vals"] as number[];
      expect(vals[0]).toBeCloseTo(1.5, 4);
      expect(vals[2]).toBeCloseTo(3.5, 4);
      expect(result.memberTypes?.["vals"]).toBe(PrimitiveTypeEnumeration.Single);
    });

    it("deserialized objects carry memberTypes that survive re-serialization", () => {
      // Round-trip the sample fixture and verify memberTypes propagates
      const buf = readFileSync(join(fixturesDir, "sample.nrbf"));
      const first = deserialize(buf) as NrbfObject;
      expect(first.memberTypes?.["Age"]).toBe(PrimitiveTypeEnumeration.Int32);
      expect(first.memberTypes?.["IsActive"]).toBe(PrimitiveTypeEnumeration.Boolean);
      expect(first.memberTypes?.["Score"]).toBe(PrimitiveTypeEnumeration.Double);
      expect(first.memberTypes?.["Values"]).toBe(PrimitiveTypeEnumeration.Int32);

      const second = deserialize(serialize(first)) as NrbfObject;
      expect(second.memberTypes?.["Age"]).toBe(PrimitiveTypeEnumeration.Int32);
      expect(second.memberTypes?.["Score"]).toBe(PrimitiveTypeEnumeration.Double);
    });
  });

  describe("fixture round-trip", () => {
    it("round-trips sample.nrbf without data loss", () => {
      const original = deserialize(readFileSync(join(fixturesDir, "sample.nrbf"))) as NrbfObject;
      const result = roundTrip(original) as NrbfObject;

      expect(result.typeName).toBe(original.typeName);
      expect(result.libraryName).toBe(original.libraryName);
      expect(result.members["Name"]).toBe("Hello, World!");
      expect(result.members["Age"]).toBe(42);
      expect(result.members["IsActive"]).toBe(true);
      expect(result.members["Score"]).toBeCloseTo(3.14);
      expect(result.members["Values"]).toEqual([10, 20, 30]);
    });
  });
});
