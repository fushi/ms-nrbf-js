import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deserialize } from "./deserialize.js";
import { serialize } from "./serialize.js";
import { PrimitiveTypeEnumeration, RecordTypeEnumeration } from "./enums.js";
import type { DateTime, NrbfMethodCall, NrbfMethodReturn, NrbfObject, NrbfValue } from "./types.js";

const fixturesDir = join(fileURLToPath(import.meta.url), "..", "__fixtures__");

function roundTrip(value: NrbfValue): NrbfValue {
  return deserialize(serialize(value)) as NrbfValue;
}

describe("serialize", () => {
  describe("circular references", () => {
    it("handles mutual object references via MemberReference", () => {
      const nodeA: NrbfObject = { typeName: "Node", libraryName: "Lib", members: { value: 1, peer: null } };
      const nodeB: NrbfObject = { typeName: "Node", libraryName: "Lib", members: { value: 2, peer: nodeA } };
      nodeA.members["peer"] = nodeB;

      const result = deserialize(serialize(nodeA)) as NrbfObject;
      expect(result.members["value"]).toBe(1);
      const peer = result.members["peer"] as NrbfObject;
      expect(peer.members["value"]).toBe(2);
      // Back-reference resolves to the same deserialized object
      expect(peer.members["peer"]).toBe(result);
    });

    it("handles self-reference", () => {
      const node: NrbfObject = { typeName: "Node", members: { value: 42, self: null } };
      node.members["self"] = node;

      const result = deserialize(serialize(node)) as NrbfObject;
      expect(result.members["value"]).toBe(42);
      expect(result.members["self"]).toBe(result);
    });
  });

  it("throws for bare primitives as root", () => {
    expect(() => serialize(42)).toThrow(TypeError);
    expect(() => serialize(null)).toThrow(TypeError);
    expect(() => serialize(true)).toThrow(TypeError);
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

    it("emits ClassWithId byte for the second instance (not a fresh SystemClassWithMembersAndTypes)", () => {
      const p1: NrbfObject = { typeName: "Point", members: { x: 1, y: 2 } };
      const p2: NrbfObject = { typeName: "Point", members: { x: 3, y: 4 } };
      const buf = serialize([p1, p2]);
      // Layout: header(17) + BinaryArray(Single,SystemClass)(21) + SCWMT Point(31) = 69
      // BinaryArray: 1(type)+4(id)+1(arrayType)+4(rank)+4(len)+1(binaryType)+6(LPS"Point") = 21
      // SCWMT Point: 1+4+6+4+2+2+1+1+1+1+4+4 = 31
      expect(buf[69]).toBe(RecordTypeEnumeration.ClassWithId);
      expect(buf.readInt32LE(70)).toBe(3); // objectId for p2
      expect(buf.readInt32LE(74)).toBe(2); // metadataId = p1's objectId
    });

    it("emits ClassWithId for every instance beyond the first (3 instances)", () => {
      const make = (x: number): NrbfObject => ({ typeName: "Point", members: { x, y: 0 } });
      const buf = serialize([make(1), make(2), make(3)]);
      // ClassWithId(p2) at offset 69; ClassWithId(p3) = 69 + 1+4+4+4+4 = 69 + 17 = 86
      expect(buf[69]).toBe(RecordTypeEnumeration.ClassWithId);
      expect(buf[86]).toBe(RecordTypeEnumeration.ClassWithId);
    });

    it("each ClassWithId instance carries independent member values", () => {
      const points = [1, 2, 3, 4, 5].map(
        (n): NrbfObject => ({ typeName: "Point", members: { x: n, y: n * 10 } }),
      );
      const result = roundTrip(points) as NrbfObject[];
      expect(result).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(result[i]!.members["x"]).toBe(i + 1);
        expect(result[i]!.members["y"]).toBe((i + 1) * 10);
      }
    });

    it("reuses metadata for library-class instances (ClassWithMembersAndTypes → ClassWithId)", () => {
      const make = (n: number): NrbfObject => ({ typeName: "Dto", libraryName: "MyLib", members: { id: n } });
      const result = roundTrip([make(1), make(2), make(3)]) as NrbfObject[];
      for (let i = 0; i < 3; i++) {
        expect(result[i]!.typeName).toBe("Dto");
        expect(result[i]!.libraryName).toBe("MyLib");
        expect(result[i]!.members["id"]).toBe(i + 1);
      }
    });

    it("ClassWithId preserves memberTypes on round-trip", () => {
      const make = (n: number): NrbfObject => ({
        typeName: "Range",
        memberTypes: { lo: PrimitiveTypeEnumeration.Byte, hi: PrimitiveTypeEnumeration.Int32 },
        members: { lo: n, hi: n * 100 },
      });
      const result = roundTrip([make(1), make(2)]) as NrbfObject[];
      expect(result[0]!.memberTypes?.["lo"]).toBe(PrimitiveTypeEnumeration.Byte);
      expect(result[1]!.memberTypes?.["lo"]).toBe(PrimitiveTypeEnumeration.Byte);
      expect(result[1]!.members["lo"]).toBe(2);
      expect(result[1]!.members["hi"]).toBe(200);
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

  describe("Char round-trip", () => {
    function charObj(c: string): NrbfObject {
      return { typeName: "T", memberTypes: { c: PrimitiveTypeEnumeration.Char }, members: { c } };
    }

    it("round-trips ASCII char preserving Char type", () => {
      const result = roundTrip(charObj("A")) as NrbfObject;
      expect(result.members["c"]).toBe("A");
      expect(result.memberTypes?.["c"]).toBe(PrimitiveTypeEnumeration.Char);
    });

    it("round-trips 2-byte UTF-8 char (é)", () => {
      const result = roundTrip(charObj("é")) as NrbfObject;
      expect(result.members["c"]).toBe("é");
      expect(result.memberTypes?.["c"]).toBe(PrimitiveTypeEnumeration.Char);
    });

    it("round-trips 3-byte UTF-8 char (€)", () => {
      const result = roundTrip(charObj("€")) as NrbfObject;
      expect(result.members["c"]).toBe("€");
      expect(result.memberTypes?.["c"]).toBe(PrimitiveTypeEnumeration.Char);
    });

    it("without memberTypes hint, char is serialized as String (not Char)", () => {
      const obj: NrbfObject = { typeName: "T", members: { c: "A" } };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members["c"]).toBe("A");
      // No Char hint → inferred as String
      expect(result.memberTypes?.["c"]).toBeUndefined();
    });
  });

  describe("Decimal round-trip", () => {
    function decObj(d: string): NrbfObject {
      return { typeName: "T", memberTypes: { d: PrimitiveTypeEnumeration.Decimal }, members: { d } };
    }

    it("round-trips a positive decimal", () => {
      const result = roundTrip(decObj("12.34")) as NrbfObject;
      expect(result.members["d"]).toBe("12.34");
      expect(result.memberTypes?.["d"]).toBe(PrimitiveTypeEnumeration.Decimal);
    });

    it("round-trips a negative decimal", () => {
      const result = roundTrip(decObj("-9999999999999999.9999")) as NrbfObject;
      expect(result.members["d"]).toBe("-9999999999999999.9999");
      expect(result.memberTypes?.["d"]).toBe(PrimitiveTypeEnumeration.Decimal);
    });

    it("round-trips zero decimal", () => {
      const result = roundTrip(decObj("0")) as NrbfObject;
      expect(result.members["d"]).toBe("0");
      expect(result.memberTypes?.["d"]).toBe(PrimitiveTypeEnumeration.Decimal);
    });
  });

  describe("TimeSpan round-trip", () => {
    function tsObj(ts: bigint): NrbfObject {
      return { typeName: "T", memberTypes: { ts: PrimitiveTypeEnumeration.TimeSpan }, members: { ts } };
    }

    it("round-trips 1 second (10_000_000 ticks)", () => {
      const result = roundTrip(tsObj(10_000_000n)) as NrbfObject;
      expect(result.members["ts"]).toBe(10_000_000n);
      expect(result.memberTypes?.["ts"]).toBe(PrimitiveTypeEnumeration.TimeSpan);
    });

    it("round-trips negative TimeSpan (-1 tick)", () => {
      const result = roundTrip(tsObj(-1n)) as NrbfObject;
      expect(result.members["ts"]).toBe(-1n);
      expect(result.memberTypes?.["ts"]).toBe(PrimitiveTypeEnumeration.TimeSpan);
    });

    it("round-trips zero TimeSpan", () => {
      const result = roundTrip(tsObj(0n)) as NrbfObject;
      expect(result.members["ts"]).toBe(0n);
      expect(result.memberTypes?.["ts"]).toBe(PrimitiveTypeEnumeration.TimeSpan);
    });

    it("without memberTypes hint, bigint is inferred as Int64 (not TimeSpan)", () => {
      const obj: NrbfObject = { typeName: "T", members: { ts: 10_000_000n } };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members["ts"]).toBe(10_000_000n);
      expect(result.memberTypes?.["ts"]).toBe(PrimitiveTypeEnumeration.Int64);
    });
  });

  describe("DateTime round-trip", () => {
    function dtObj(dt: DateTime): NrbfObject {
      return { typeName: "T", members: { dt } };
    }

    it("round-trips UTC DateTime (kind=1)", () => {
      const result = roundTrip(dtObj({ ticks: 638_000_000_000_000_000n, kind: 1 })) as NrbfObject;
      const dt = result.members["dt"] as DateTime;
      expect(dt.ticks).toBe(638_000_000_000_000_000n);
      expect(dt.kind).toBe(1);
      expect(result.memberTypes?.["dt"]).toBe(PrimitiveTypeEnumeration.DateTime);
    });

    it("round-trips Local DateTime (kind=2)", () => {
      const result = roundTrip(dtObj({ ticks: 0n, kind: 2 })) as NrbfObject;
      const dt = result.members["dt"] as DateTime;
      expect(dt.ticks).toBe(0n);
      expect(dt.kind).toBe(2);
    });

    it("round-trips Unspecified DateTime (kind=0) with arbitrary ticks", () => {
      const result = roundTrip(dtObj({ ticks: 123_456_789n, kind: 0 })) as NrbfObject;
      const dt = result.members["dt"] as DateTime;
      expect(dt.ticks).toBe(123_456_789n);
      expect(dt.kind).toBe(0);
    });

    it("round-trips max ticks (62-bit all-ones)", () => {
      const maxTicks = 0x3fffffffffffffffn;
      const result = roundTrip(dtObj({ ticks: maxTicks, kind: 0 })) as NrbfObject;
      expect((result.members["dt"] as DateTime).ticks).toBe(maxTicks);
    });

    it("DateTime is auto-inferred without memberTypes hint", () => {
      const obj: NrbfObject = { typeName: "T", members: { dt: { ticks: 1n, kind: 1 } } };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.memberTypes?.["dt"]).toBe(PrimitiveTypeEnumeration.DateTime);
    });
  });

  describe("BinaryArray(Single) for uniform class arrays", () => {
    it("emits BinaryArray(Single, Class) for library class arrays", () => {
      // Header(17) + BinaryLibrary("Lib")(9) + ClassWithMembersAndTypes header(30) = 56
      // ClassWithMembersAndTypes header: type(1)+objectId(4)+name(1+9)+memberCount(4)+memberName(1+5)+typeInfo(1)+libraryId(4)=30
      const obj: NrbfObject = {
        typeName: "Container",
        libraryName: "Lib",
        members: {
          items: [
            { typeName: "Item", libraryName: "Lib", members: { n: 1 } },
            { typeName: "Item", libraryName: "Lib", members: { n: 2 } },
          ] as NrbfValue[],
        },
      };
      const buf = serialize(obj);
      expect(buf[56]).toBe(RecordTypeEnumeration.BinaryArray);
    });

    it("emits BinaryArray(Single, SystemClass) for system class arrays", () => {
      // Header(17) + SystemClassWithMembersAndTypes header(28) = 45
      // SystemClassWithMembersAndTypes: type(1)+objectId(4)+name(1+12)+memberCount(4)+memberName(1+5)+typeInfo(1)=29
      // Wait: no libraryId for SystemClass, so: 1+4+(1+12)+4+(1+5)+1 = 29 bytes
      // Total: 17 + 29 = 46
      const obj: NrbfObject = {
        typeName: "SysContainer",
        members: {
          items: [
            { typeName: "SysItem", members: { v: 1 } },
            { typeName: "SysItem", members: { v: 2 } },
          ] as NrbfValue[],
        },
      };
      const buf = serialize(obj);
      // Header(17) + SystemClassWithMembersAndTypes: type(1)+objectId(4)+(1+12)+"SysContainer"+(4)+memberCount+(1+5)+"items"+typeInfo(1) = 46
      expect(buf[46]).toBe(RecordTypeEnumeration.BinaryArray);
    });

    it("falls back to ArraySingleObject for mixed class types", () => {
      const obj: NrbfObject = {
        typeName: "Container",
        libraryName: "Lib",
        members: {
          items: [
            { typeName: "Foo", libraryName: "Lib", members: {} },
            { typeName: "Bar", libraryName: "Lib", members: {} },
          ] as NrbfValue[],
        },
      };
      const buf = serialize(obj);
      expect(buf[56]).toBe(RecordTypeEnumeration.ArraySingleObject);
    });

    it("falls back to ArraySingleObject when nulls are mixed in", () => {
      const obj: NrbfObject = {
        typeName: "Container",
        libraryName: "Lib",
        members: {
          items: [
            { typeName: "Item", libraryName: "Lib", members: {} },
            null,
          ] as NrbfValue[],
        },
      };
      const buf = serialize(obj);
      expect(buf[56]).toBe(RecordTypeEnumeration.ArraySingleObject);
    });

    it("round-trips library class array preserving element values", () => {
      const obj: NrbfObject = {
        typeName: "Container",
        libraryName: "Lib",
        members: {
          items: [
            { typeName: "Item", libraryName: "Lib", members: { n: 10 } },
            { typeName: "Item", libraryName: "Lib", members: { n: 20 } },
          ] as NrbfValue[],
        },
      };
      const result = deserialize(serialize(obj)) as NrbfObject;
      const items = result.members["items"] as NrbfObject[];
      expect(items).toHaveLength(2);
      expect(items[0]!.typeName).toBe("Item");
      expect(items[0]!.libraryName).toBe("Lib");
      expect(items[0]!.members["n"]).toBe(10);
      expect(items[1]!.members["n"]).toBe(20);
    });

    it("round-trips system class array preserving element values", () => {
      const obj: NrbfObject = {
        typeName: "SysContainer",
        members: {
          items: [
            { typeName: "SysItem", members: { v: 42 } },
            { typeName: "SysItem", members: { v: 99 } },
          ] as NrbfValue[],
        },
      };
      const result = deserialize(serialize(obj)) as NrbfObject;
      const items = result.members["items"] as NrbfObject[];
      expect(items).toHaveLength(2);
      expect(items[0]!.members["v"]).toBe(42);
      expect(items[1]!.members["v"]).toBe(99);
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

    it("byte-exact round-trip of sample.nrbf", () => {
      const buf = readFileSync(join(fixturesDir, "sample.nrbf"));
      const reserialized = serialize(deserialize(buf));
      expect(reserialized).toEqual(buf);
    });

    it("byte-exact round-trip of method_call.nrbf", () => {
      const buf = readFileSync(join(fixturesDir, "method_call.nrbf"));
      const reserialized = serialize(deserialize(buf));
      expect(reserialized).toEqual(buf);
    });

    it("byte-exact round-trip of method_return.nrbf", () => {
      const buf = readFileSync(join(fixturesDir, "method_return.nrbf"));
      const reserialized = serialize(deserialize(buf));
      expect(reserialized).toEqual(buf);
    });

    it("round-trip of object_graph.nrbf preserves structure and values", () => {
      const buf = readFileSync(join(fixturesDir, "object_graph.nrbf"));
      const root = deserialize(serialize(deserialize(buf))) as NrbfObject;

      expect(root.typeName).toBe("GraphRoot");
      const nodeA = root.members["NodeA"] as NrbfObject;
      const nodeB = root.members["NodeB"] as NrbfObject;
      expect(nodeA.typeName).toBe("Node");
      expect(nodeA.members["Value"]).toBe(100);
      expect(nodeA.members["Tag"]).toBe("Alpha");
      expect(nodeA.members["Peer"]).toBe(nodeB);

      expect(nodeB.typeName).toBe("Node");
      expect(nodeB.members["Value"]).toBe(200);
      expect(nodeB.members["Tag"]).toBe("Beta");
      expect(nodeB.members["Peer"]).toBe(nodeA);

      const ver = root.members["Version"] as NrbfObject;
      expect(ver.typeName).toBe("System.Version");
      expect(ver.members["_Major"]).toBe(4);
      expect(ver.members["_Minor"]).toBe(8);

      expect(root.members["Matrix"]).toEqual([11, 12, 13, 21, 22, 23]);

      const sparse = root.members["SparseSmall"] as (string | null)[];
      expect(sparse[0]).toBe("first");
      expect(sparse[10]).toBe("Beta");
      expect(sparse[11]).toBe("last");
      expect(sparse[1]).toBeNull();
    });

    it("byte-exact round-trip of return_value_inline_null.nrbf", () => {
      const buf = readFileSync(join(fixturesDir, "return_value_inline_null.nrbf"));
      const reserialized = serialize(deserialize(buf));
      expect(reserialized).toEqual(buf);
    });

    it("byte-exact round-trip of exception_in_array.nrbf", () => {
      const buf = readFileSync(join(fixturesDir, "exception_in_array.nrbf"));
      const reserialized = serialize(deserialize(buf));
      expect(reserialized).toEqual(buf);
    });

    it("byte-exact round-trip of context_in_array_call.nrbf", () => {
      const buf = readFileSync(join(fixturesDir, "context_in_array_call.nrbf"));
      const reserialized = serialize(deserialize(buf));
      expect(reserialized).toEqual(buf);
    });

    it("byte-exact round-trip of return_and_context_in_array.nrbf", () => {
      const buf = readFileSync(join(fixturesDir, "return_and_context_in_array.nrbf"));
      const reserialized = serialize(deserialize(buf));
      expect(reserialized).toEqual(buf);
    });
  });

  describe("ArraySingleObject with primitive elements", () => {
    it("round-trips a mixed primitive+null array", () => {
      expect(roundTrip([42, null])).toEqual([42, null]);
    });

    it("round-trips a mixed boolean+null+string array", () => {
      expect(roundTrip([true, null, "x"])).toEqual([true, null, "x"]);
    });
  });

  describe("string-array class member", () => {
    it("round-trips a class with a string array member", () => {
      const obj: NrbfObject = { typeName: "T", members: { tags: ["a", "b", "c"] } };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members["tags"]).toEqual(["a", "b", "c"]);
    });
  });

  describe("NrbfMethodCall", () => {
    function roundTripCall(call: NrbfMethodCall): NrbfMethodCall {
      return deserialize(serialize(call)) as NrbfMethodCall;
    }

    it("round-trips args containing an NrbfObject (ArgsIsArray path)", () => {
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "M",
        typeName: "T",
        args: [{ typeName: "Inner", members: { x: 1 } }],
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ typeName: "Inner", members: { x: 1 } }]);
    });

    it("round-trips mixed primitive and NrbfObject args", () => {
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "Process",
        typeName: "IService",
        args: [42, "text", { typeName: "Payload", members: { value: true } }],
      };
      const result = roundTripCall(call);
      expect(result.methodName).toBe("Process");
      expect(result.args?.[0]).toBe(42);
      expect(result.args?.[1]).toBe("text");
      expect(result.args?.[2]).toMatchObject({ typeName: "Payload", members: { value: true } });
    });

    it("round-trips NrbfObject args with a library name", () => {
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "Send",
        typeName: "IService",
        args: [{ typeName: "Msg", libraryName: "MyLib, Version=1.0.0.0", members: { id: 7 } }],
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ typeName: "Msg", libraryName: "MyLib, Version=1.0.0.0", members: { id: 7 } }]);
    });

    it("round-trips methodName and typeName", () => {
      const call: NrbfMethodCall = { kind: "MethodCall", methodName: "DoWork", typeName: "IService" };
      const result = roundTripCall(call);
      expect(result.kind).toBe("MethodCall");
      expect(result.methodName).toBe("DoWork");
      expect(result.typeName).toBe("IService");
      expect(result.args).toBeUndefined();
      expect(result.callContext).toBeUndefined();
    });

    it("round-trips with string and int args", () => {
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "PerformAction",
        typeName: "IMyService, AdvancedDemo, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null",
        args: ["payload-data", 7],
      };
      const result = roundTripCall(call);
      expect(result.methodName).toBe("PerformAction");
      expect(result.args).toEqual(["payload-data", 7]);
    });

    it("round-trips with callContext", () => {
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "Ping",
        typeName: "IService",
        callContext: "ctx-value",
      };
      const result = roundTripCall(call);
      expect(result.callContext).toBe("ctx-value");
    });

    it("round-trips NrbfObject callContext alone (ContextInArray path)", () => {
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "M",
        typeName: "T",
        callContext: { typeName: "System.Runtime.Remoting.Messaging.LogicalCallContext", libraryName: "mscorlib", members: { id: "call-42" } },
      };
      const result = roundTripCall(call);
      expect(result.callContext).toMatchObject({ typeName: "System.Runtime.Remoting.Messaging.LogicalCallContext", members: { id: "call-42" } });
    });

    it("round-trips NrbfObject args and NrbfObject callContext together", () => {
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "M",
        typeName: "T",
        args: [{ typeName: "Arg", members: { x: 1 } }],
        callContext: { typeName: "System.Runtime.Remoting.Messaging.LogicalCallContext", libraryName: "mscorlib", members: { id: "ctx" } },
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ typeName: "Arg", members: { x: 1 } }]);
      expect(result.callContext).toMatchObject({ typeName: "System.Runtime.Remoting.Messaging.LogicalCallContext", members: { id: "ctx" } });
    });

    it("round-trips with callContext and args", () => {
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "Ping",
        typeName: "IService",
        callContext: "ctx",
        args: [true, 42n],
      };
      const result = roundTripCall(call);
      expect(result.callContext).toBe("ctx");
      expect(result.args).toEqual([true, 42n]);
    });

    it("round-trips fixture method_call.nrbf", () => {
      const original = deserialize(readFileSync(join(fixturesDir, "method_call.nrbf"))) as NrbfMethodCall;
      const result = roundTripCall(original);
      expect(result.kind).toBe(original.kind);
      expect(result.methodName).toBe(original.methodName);
      expect(result.typeName).toBe(original.typeName);
      expect(result.args).toEqual(original.args);
      expect(result.callContext).toEqual(original.callContext);
    });

    it("round-trips genericTypeArguments without args (GenericMethod only)", () => {
      const typeArg = { typeName: "System.UnitySerializationHolder", libraryName: "mscorlib", members: { Data: "System.Int32", UnityType: 9 } };
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "M`1",
        typeName: "IService",
        genericTypeArguments: [typeArg],
      };
      const result = roundTripCall(call);
      expect(result.genericTypeArguments).toHaveLength(1);
      expect(result.genericTypeArguments![0]).toMatchObject({ typeName: "System.UnitySerializationHolder", members: { Data: "System.Int32", UnityType: 9 } });
    });

    it("round-trips genericTypeArguments with complex args (ArgsIsArray + GenericMethod)", () => {
      const typeArg = { typeName: "System.UnitySerializationHolder", libraryName: "mscorlib", members: { Data: "MyLib.Payload", UnityType: 4 } };
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "Send`1",
        typeName: "IService",
        args: [{ typeName: "Payload", libraryName: "MyLib", members: { value: 99 } }],
        genericTypeArguments: [typeArg],
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ typeName: "Payload", members: { value: 99 } }]);
      expect(result.genericTypeArguments).toHaveLength(1);
      expect(result.genericTypeArguments![0]).toMatchObject({ members: { Data: "MyLib.Payload" } });
    });

    it("round-trips genericTypeArguments with methodSignature (GenericMethod + MethodSignatureInArray)", () => {
      const makeHolder = (data: string) => ({ typeName: "System.UnitySerializationHolder", libraryName: "mscorlib", members: { Data: data, UnityType: 9 } });
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "Process`1",
        typeName: "IWorker",
        args: [{ typeName: "Item", libraryName: "Lib", members: { id: 7 } }],
        genericTypeArguments: [makeHolder("System.String")],
        methodSignature: [makeHolder("Lib.Item")],
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ members: { id: 7 } }]);
      expect(result.genericTypeArguments).toHaveLength(1);
      expect(result.genericTypeArguments![0]).toMatchObject({ members: { Data: "System.String" } });
      expect(result.methodSignature).toHaveLength(1);
      expect(result.methodSignature![0]).toMatchObject({ members: { Data: "Lib.Item" } });
    });

    it("round-trips methodSignature without args (MethodSignatureInArray only)", () => {
      const sigEntry = { typeName: "System.UnitySerializationHolder", libraryName: "mscorlib", members: { Data: "System.String", UnityType: 9 } };
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "Greet",
        typeName: "IService",
        methodSignature: [sigEntry],
      };
      const result = roundTripCall(call);
      expect(result.methodSignature).toHaveLength(1);
      expect(result.methodSignature![0]).toMatchObject({ typeName: "System.UnitySerializationHolder", members: { Data: "System.String", UnityType: 9 } });
    });

    it("round-trips methodSignature with complex args (ArgsIsArray + MethodSignatureInArray)", () => {
      const sigEntry = { typeName: "System.UnitySerializationHolder", libraryName: "mscorlib", members: { Data: "MyLib.Payload", UnityType: 4 } };
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "Send",
        typeName: "IService",
        args: [{ typeName: "Payload", libraryName: "MyLib", members: { value: 42 } }],
        methodSignature: [sigEntry],
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ typeName: "Payload", members: { value: 42 } }]);
      expect(result.methodSignature).toHaveLength(1);
      expect(result.methodSignature![0]).toMatchObject({ typeName: "System.UnitySerializationHolder", members: { Data: "MyLib.Payload", UnityType: 4 } });
    });

    it("round-trips methodSignature with object callContext (MethodSignatureInArray + ContextInArray)", () => {
      const sigEntry = { typeName: "System.UnitySerializationHolder", libraryName: "mscorlib", members: { Data: "System.Int32", UnityType: 9 } };
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "M",
        typeName: "T",
        methodSignature: [sigEntry],
        callContext: { typeName: "System.Runtime.Remoting.Messaging.LogicalCallContext", libraryName: "mscorlib", members: { id: "ctx-99" } },
      };
      const result = roundTripCall(call);
      expect(result.methodSignature).toHaveLength(1);
      expect(result.methodSignature![0]).toMatchObject({ members: { Data: "System.Int32" } });
      expect(result.callContext).toMatchObject({ members: { id: "ctx-99" } });
    });

    it("round-trips methodSignature with complex args, object callContext, and messageProperties", () => {
      const makeSig = (data: string) => ({ typeName: "System.UnitySerializationHolder", libraryName: "mscorlib", members: { Data: data, UnityType: 9 } });
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "Process",
        typeName: "IWorker",
        args: [
          { typeName: "Item", libraryName: "Lib", members: { id: 1 } },
          { typeName: "Options", libraryName: "Lib", members: { flag: true } },
        ],
        methodSignature: [makeSig("Lib.Item"), makeSig("Lib.Options")],
        callContext: { typeName: "System.Runtime.Remoting.Messaging.LogicalCallContext", libraryName: "mscorlib", members: { traceId: "abc" } },
        messageProperties: [{ typeName: "Prop", libraryName: "Lib", members: { key: "val" } }],
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ members: { id: 1 } }, { members: { flag: true } }]);
      expect(result.methodSignature).toHaveLength(2);
      expect(result.methodSignature![0]).toMatchObject({ members: { Data: "Lib.Item" } });
      expect(result.methodSignature![1]).toMatchObject({ members: { Data: "Lib.Options" } });
      expect(result.callContext).toMatchObject({ members: { traceId: "abc" } });
      expect(result.messageProperties).toMatchObject([{ members: { key: "val" } }]);
    });
  });

  describe("NrbfMethodReturn", () => {
    function roundTripReturn(ret: NrbfMethodReturn): NrbfMethodReturn {
      return deserialize(serialize(ret)) as NrbfMethodReturn;
    }

    it("round-trips with no return value (void)", () => {
      const ret: NrbfMethodReturn = { kind: "MethodReturn" };
      const result = roundTripReturn(ret);
      expect(result.kind).toBe("MethodReturn");
      expect(result.returnValue).toBeUndefined();
      expect(result.args).toBeUndefined();
      expect(result.callContext).toBeUndefined();
    });

    it("round-trips with a string return value", () => {
      const ret: NrbfMethodReturn = { kind: "MethodReturn", returnValue: "success" };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toBe("success");
    });

    it("round-trips with a numeric return value", () => {
      const ret: NrbfMethodReturn = { kind: "MethodReturn", returnValue: 99 };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toBe(99);
    });

    it("round-trips with null return value", () => {
      const ret: NrbfMethodReturn = { kind: "MethodReturn", returnValue: null };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toBeNull();
    });

    it("round-trips with args", () => {
      const ret: NrbfMethodReturn = { kind: "MethodReturn", returnValue: "done", args: [1, "extra"] };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toBe("done");
      expect(result.args).toEqual([1, "extra"]);
    });

    it("round-trips with callContext", () => {
      const ret: NrbfMethodReturn = { kind: "MethodReturn", returnValue: 1, callContext: "ctx" };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toBe(1);
      expect(result.callContext).toBe("ctx");
    });

    it("round-trips NrbfObject callContext alone (ContextInArray path)", () => {
      const ret: NrbfMethodReturn = {
        kind: "MethodReturn",
        callContext: { typeName: "System.Runtime.Remoting.Messaging.LogicalCallContext", libraryName: "mscorlib", members: { id: "r-42" } },
      };
      const result = roundTripReturn(ret);
      expect(result.callContext).toMatchObject({ typeName: "System.Runtime.Remoting.Messaging.LogicalCallContext", members: { id: "r-42" } });
    });

    it("round-trips complex return value and NrbfObject callContext together", () => {
      const ret: NrbfMethodReturn = {
        kind: "MethodReturn",
        returnValue: { typeName: "Result", members: { code: 0 } },
        callContext: { typeName: "System.Runtime.Remoting.Messaging.LogicalCallContext", libraryName: "mscorlib", members: { id: "r-ctx" } },
      };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toMatchObject({ typeName: "Result", members: { code: 0 } });
      expect(result.callContext).toMatchObject({ members: { id: "r-ctx" } });
    });

    it("round-trips fixture method_return.nrbf", () => {
      const original = deserialize(readFileSync(join(fixturesDir, "method_return.nrbf"))) as NrbfMethodReturn;
      const result = roundTripReturn(original);
      expect(result.kind).toBe(original.kind);
      expect(result.returnValue).toEqual(original.returnValue);
      expect(result.callContext).toEqual(original.callContext);
      expect(result.args).toEqual(original.args);
    });

    it("round-trips NrbfObject return value (ReturnValueInArray path)", () => {
      const ret: NrbfMethodReturn = {
        kind: "MethodReturn",
        returnValue: { typeName: "Result", members: { code: 0, message: "ok" } },
      };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toMatchObject({ typeName: "Result", members: { code: 0, message: "ok" } });
    });

    it("round-trips NrbfObject return value with a library name", () => {
      const ret: NrbfMethodReturn = {
        kind: "MethodReturn",
        returnValue: { typeName: "Resp", libraryName: "Svc, Version=2.0.0.0", members: { status: 200 } },
      };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toMatchObject({ typeName: "Resp", libraryName: "Svc, Version=2.0.0.0", members: { status: 200 } });
    });

    it("round-trips complex args in MethodReturn (ArgsInArray path)", () => {
      const ret: NrbfMethodReturn = {
        kind: "MethodReturn",
        returnValue: "done",
        args: [{ typeName: "OutParam", members: { val: 99 } }],
      };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toBe("done");
      expect(result.args).toMatchObject([{ typeName: "OutParam", members: { val: 99 } }]);
    });

    it("round-trips complex return value and complex args together", () => {
      const ret: NrbfMethodReturn = {
        kind: "MethodReturn",
        returnValue: { typeName: "R", members: { n: 1 } },
        args: [{ typeName: "A", members: { n: 2 } }],
      };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toMatchObject({ typeName: "R", members: { n: 1 } });
      expect(result.args).toMatchObject([{ typeName: "A", members: { n: 2 } }]);
    });

    it("round-trips exception alone (ExceptionInArray path)", () => {
      const ret: NrbfMethodReturn = {
        kind: "MethodReturn",
        exception: { typeName: "System.Exception", libraryName: "mscorlib", members: { _message: "boom" } },
      };
      const result = roundTripReturn(ret);
      expect(result.exception).toMatchObject({ typeName: "System.Exception", members: { _message: "boom" } });
      expect(result.returnValue).toBeUndefined();
      expect(result.args).toBeUndefined();
    });

    it("round-trips exception with NrbfObject callContext", () => {
      const ret: NrbfMethodReturn = {
        kind: "MethodReturn",
        exception: { typeName: "System.InvalidOperationException", libraryName: "mscorlib", members: { _message: "invalid" } },
        callContext: { typeName: "System.Runtime.Remoting.Messaging.LogicalCallContext", libraryName: "mscorlib", members: { id: "ex-ctx" } },
      };
      const result = roundTripReturn(ret);
      expect(result.exception).toMatchObject({ typeName: "System.InvalidOperationException", members: { _message: "invalid" } });
      expect(result.callContext).toMatchObject({ members: { id: "ex-ctx" } });
    });

    it("round-trips exception with string callContext", () => {
      const ret: NrbfMethodReturn = {
        kind: "MethodReturn",
        exception: { typeName: "System.Exception", libraryName: "mscorlib", members: { _message: "oops" } },
        callContext: "call-123",
      };
      const result = roundTripReturn(ret);
      expect(result.exception).toMatchObject({ typeName: "System.Exception", members: { _message: "oops" } });
      expect(result.callContext).toBe("call-123");
    });

    it("round-trips messageProperties alone (PropertiesInArray path)", () => {
      const entry: NrbfObject = { typeName: "DictionaryEntry", members: { _key: "priority", _value: 1 } };
      const ret: NrbfMethodReturn = { kind: "MethodReturn", messageProperties: [entry] };
      const result = roundTripReturn(ret);
      expect(result.messageProperties).toMatchObject([{ typeName: "DictionaryEntry", members: { _key: "priority", _value: 1 } }]);
      expect(result.returnValue).toBeUndefined();
    });

    it("round-trips messageProperties alongside return value and callContext", () => {
      const entry: NrbfObject = { typeName: "DictionaryEntry", members: { _key: "trace", _value: "abc" } };
      const ret: NrbfMethodReturn = {
        kind: "MethodReturn",
        returnValue: 42,
        callContext: "ctx-1",
        messageProperties: [entry],
      };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toBe(42);
      expect(result.callContext).toBe("ctx-1");
      expect(result.messageProperties).toMatchObject([{ typeName: "DictionaryEntry", members: { _key: "trace", _value: "abc" } }]);
    });

    it("round-trips messageProperties alongside exception (PropertiesInArray + ExceptionInArray)", () => {
      const entry: NrbfObject = { typeName: "DictionaryEntry", members: { _key: "reqId", _value: "x99" } };
      const ret: NrbfMethodReturn = {
        kind: "MethodReturn",
        exception: { typeName: "System.Exception", libraryName: "mscorlib", members: { _message: "fail" } },
        messageProperties: [entry],
      };
      const result = roundTripReturn(ret);
      expect(result.exception).toMatchObject({ typeName: "System.Exception", members: { _message: "fail" } });
      expect(result.messageProperties).toMatchObject([{ typeName: "DictionaryEntry", members: { _key: "reqId", _value: "x99" } }]);
    });
  });

  describe("NrbfMethodCall messageProperties", () => {
    function roundTripCall(call: NrbfMethodCall): NrbfMethodCall {
      return deserialize(serialize(call)) as NrbfMethodCall;
    }

    it("round-trips messageProperties alone (no args, no context)", () => {
      const entry: NrbfObject = { typeName: "DictionaryEntry", members: { _key: "env", _value: "prod" } };
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "Ping",
        typeName: "IService",
        messageProperties: [entry],
      };
      const result = roundTripCall(call);
      expect(result.messageProperties).toMatchObject([{ typeName: "DictionaryEntry", members: { _key: "env", _value: "prod" } }]);
      expect(result.args).toBeUndefined();
    });

    it("round-trips messageProperties with complex args (ArgsIsArray + PropertiesInArray)", () => {
      const entry: NrbfObject = { typeName: "DictionaryEntry", members: { _key: "k", _value: "v" } };
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "Send",
        typeName: "IService",
        args: [{ typeName: "Payload", members: { id: 7 } }],
        messageProperties: [entry],
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ typeName: "Payload", members: { id: 7 } }]);
      expect(result.messageProperties).toMatchObject([{ typeName: "DictionaryEntry", members: { _key: "k", _value: "v" } }]);
    });

    it("round-trips messageProperties with NrbfObject callContext (ContextInArray + PropertiesInArray)", () => {
      const entry: NrbfObject = { typeName: "DictionaryEntry", members: { _key: "tid", _value: "t1" } };
      const call: NrbfMethodCall = {
        kind: "MethodCall",
        methodName: "M",
        typeName: "T",
        callContext: { typeName: "System.Runtime.Remoting.Messaging.LogicalCallContext", libraryName: "mscorlib", members: { id: "ctx" } },
        messageProperties: [entry],
      };
      const result = roundTripCall(call);
      expect(result.callContext).toMatchObject({ members: { id: "ctx" } });
      expect(result.messageProperties).toMatchObject([{ typeName: "DictionaryEntry", members: { _key: "tid", _value: "t1" } }]);
    });
  });
});
