import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deserialize } from "./deserialize.js";
import type { NrbfMethodCall, NrbfMethodReturn, NrbfObject } from "./types.js";

const fixturesDir = join(fileURLToPath(import.meta.url), "..", "__fixtures__");

// ---------------------------------------------------------------------------
// Binary building helpers
// ---------------------------------------------------------------------------

function i32(n: number): number[] {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n, 0);
  return [...b];
}

function lps(s: string): number[] {
  const encoded = Buffer.from(s, "utf8");
  const len = encoded.length;
  const prefix: number[] = len < 128 ? [len] : [(len & 0x7f) | 0x80, len >> 7];
  return [...prefix, ...encoded];
}

function header(rootId: number): number[] {
  return [0x00, ...i32(rootId), ...i32(-1), ...i32(1), ...i32(0)];
}

const END = [0x0b];

function buf(...parts: number[][]): Buffer {
  return Buffer.from(parts.flat());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deserialize", () => {
  it("throws on missing SerializationHeaderRecord", () => {
    expect(() => deserialize(Buffer.from([0x0b]))).toThrow();
  });

  describe("BinaryObjectString as root", () => {
    it("deserializes a string value", () => {
      const stream = buf(header(1), [0x06, ...i32(1), ...lps("hello")], END);
      expect(deserialize(stream)).toBe("hello");
    });

    it("deserializes empty string", () => {
      const stream = buf(header(1), [0x06, ...i32(1), ...lps("")], END);
      expect(deserialize(stream)).toBe("");
    });
  });

  describe("ArraySinglePrimitive", () => {
    it("deserializes Int32 array", () => {
      const stream = buf(
        header(1),
        [0x0f, ...i32(1), ...i32(3), 0x08, ...i32(1), ...i32(2), ...i32(3)],
        END,
      );
      expect(deserialize(stream)).toEqual([1, 2, 3]);
    });

    it("deserializes Boolean array", () => {
      const stream = buf(header(1), [0x0f, ...i32(1), ...i32(2), 0x01, 0x01, 0x00], END);
      expect(deserialize(stream)).toEqual([true, false]);
    });

    it("deserializes empty array", () => {
      const stream = buf(header(1), [0x0f, ...i32(1), ...i32(0), 0x08], END);
      expect(deserialize(stream)).toEqual([]);
    });
  });

  describe("ArraySingleObject", () => {
    it("deserializes mixed-type array", () => {
      const stream = buf(
        header(1),
        [0x10, ...i32(1), ...i32(2), 0x0a, 0x06, ...i32(2), ...lps("hi")],
        END,
      );
      expect(deserialize(stream)).toEqual([null, "hi"]);
    });

    it("handles ObjectNullMultiple256 compression", () => {
      const stream = buf(
        header(1),
        [0x10, ...i32(1), ...i32(4), 0x0d, 0x03, 0x06, ...i32(2), ...lps("x")],
        END,
      );
      expect(deserialize(stream)).toEqual([null, null, null, "x"]);
    });

    it("handles ObjectNullMultiple compression", () => {
      const stream = buf(
        header(1),
        [0x10, ...i32(1), ...i32(301), 0x0e, ...i32(300), 0x06, ...i32(2), ...lps("end")],
        END,
      );
      const result = deserialize(stream) as unknown[];
      expect(result).toHaveLength(301);
      expect(result[300]).toBe("end");
      expect(result[0]).toBeNull();
    });
  });

  describe("SystemClassWithMembersAndTypes", () => {
    function makePointStream(x: number, y: number): Buffer {
      return buf(
        header(1),
        [
          0x04, ...i32(1), ...lps("System.Drawing.Point"), ...i32(2), ...lps("x"), ...lps("y"),
          0x00, 0x00, // BinaryTypeEnum: Primitive, Primitive
          0x08, 0x08, // AdditionalInfo: Int32, Int32
          ...i32(x), ...i32(y),
        ],
        END,
      );
    }

    it("deserializes a class with primitive members", () => {
      const result = deserialize(makePointStream(10, 20)) as NrbfObject;
      expect(result.typeName).toBe("System.Drawing.Point");
      expect(result.members["x"]).toBe(10);
      expect(result.members["y"]).toBe(20);
    });

    it("deserializes a class with string member", () => {
      const stream = buf(
        header(1),
        [
          0x04, ...i32(1), ...lps("MyClass"), ...i32(1), ...lps("name"),
          0x01, // BinaryTypeEnum: String
          0x06, ...i32(2), ...lps("Alice"),
        ],
        END,
      );
      const result = deserialize(stream) as NrbfObject;
      expect(result.members["name"]).toBe("Alice");
    });

    it("deserializes a class with null member", () => {
      const stream = buf(
        header(1),
        [0x04, ...i32(1), ...lps("MyClass"), ...i32(1), ...lps("ref"), 0x02, 0x0a],
        END,
      );
      expect((deserialize(stream) as NrbfObject).members["ref"]).toBeNull();
    });
  });

  describe("ClassWithId", () => {
    it("reuses class metadata from a prior record", () => {
      const stream = buf(
        header(2),
        [
          0x04, ...i32(1), ...lps("Point"), ...i32(2), ...lps("x"), ...lps("y"),
          0x00, 0x00, 0x08, 0x08,
          ...i32(1), ...i32(2),
        ],
        [0x01, ...i32(2), ...i32(1), ...i32(3), ...i32(4)],
        END,
      );
      const result = deserialize(stream) as NrbfObject;
      expect(result.typeName).toBe("Point");
      expect(result.members["x"]).toBe(3);
      expect(result.members["y"]).toBe(4);
    });
  });

  describe("MemberReference", () => {
    it("resolves back-references to previously seen objects", () => {
      const stream = buf(
        header(1),
        [0x06, ...i32(2), ...lps("shared")],
        [
          0x04, ...i32(1), ...lps("Container"), ...i32(2), ...lps("a"), ...lps("b"),
          0x01, 0x01,
          0x09, ...i32(2),
          0x09, ...i32(2),
        ],
        END,
      );
      const result = deserialize(stream) as NrbfObject;
      expect(result.members["a"]).toBe("shared");
      expect(result.members["b"]).toBe("shared");
    });
  });

  describe("BinaryLibrary + ClassWithMembersAndTypes", () => {
    it("deserializes a non-system class with a library reference", () => {
      const stream = buf(
        header(1),
        [0x0c, ...i32(42), ...lps("MyAssembly, Version=1.0.0.0")],
        [
          0x05, ...i32(1), ...lps("MyNamespace.MyClass"), ...i32(1), ...lps("value"),
          0x00, 0x08,
          ...i32(42),
          ...i32(99),
        ],
        END,
      );
      const result = deserialize(stream) as NrbfObject;
      expect(result.typeName).toBe("MyNamespace.MyClass");
      expect(result.libraryName).toBe("MyAssembly, Version=1.0.0.0");
      expect(result.members["value"]).toBe(99);
    });
  });

  describe("nested objects", () => {
    it("deserializes a class whose member is another class", () => {
      const stream = buf(
        header(1),
        [
          0x04, ...i32(2), ...lps("Point"), ...i32(2), ...lps("x"), ...lps("y"),
          0x00, 0x00, 0x08, 0x08, ...i32(5), ...i32(6),
        ],
        [
          0x04, ...i32(1), ...lps("Wrapper"), ...i32(1), ...lps("point"),
          0x03, ...lps("Point"),
          0x09, ...i32(2),
        ],
        END,
      );
      const wrapper = deserialize(stream) as NrbfObject;
      const point = wrapper.members["point"] as NrbfObject;
      expect(point.typeName).toBe("Point");
      expect(point.members["x"]).toBe(5);
    });
  });

  // ---------------------------------------------------------------------------
  // Real binary fixtures
  // ---------------------------------------------------------------------------

  describe("fixtures", () => {
    it("sample.nrbf — SampleData class with mixed member types", () => {
      const buf = readFileSync(join(fixturesDir, "sample.nrbf"));
      const result = deserialize(buf) as NrbfObject;

      expect(result.typeName).toBe("SampleData");
      expect(result.libraryName).toBe("SampleLibrary, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null");
      expect(result.members["Name"]).toBe("Hello, World!");
      expect(result.members["Age"]).toBe(42);
      expect(result.members["IsActive"]).toBe(true);
      expect(result.members["Score"]).toBeCloseTo(3.14);
      expect(result.members["Values"]).toEqual([10, 20, 30]);
    });

    it("method_call.nrbf — BinaryMethodCall with inline args", () => {
      const result = deserialize(readFileSync(join(fixturesDir, "method_call.nrbf"))) as NrbfMethodCall;
      expect(result.kind).toBe("MethodCall");
      expect(result.methodName).toBe("PerformAction");
      expect(result.typeName).toBe("IMyService, AdvancedDemo, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null");
      expect(result.args).toEqual(["payload-data", 7]);
    });

    it("method_return.nrbf — BinaryMethodReturn with inline return value", () => {
      const result = deserialize(readFileSync(join(fixturesDir, "method_return.nrbf"))) as NrbfMethodReturn;
      expect(result.kind).toBe("MethodReturn");
      expect(result.returnValue).toBe("success");
    });

    it("object_graph.nrbf — complex graph with circular refs, nested classes, sparse arrays", () => {
      const root = deserialize(readFileSync(join(fixturesDir, "object_graph.nrbf"))) as NrbfObject;
      expect(root.typeName).toBe("GraphRoot");

      // Circular Node references: NodeA.Peer → NodeB, NodeB.Peer → NodeA
      const nodeA = root.members["NodeA"] as NrbfObject;
      const nodeB = root.members["NodeB"] as NrbfObject;
      expect(nodeA.typeName).toBe("Node");
      expect(nodeA.members["Value"]).toBe(100);
      expect(nodeA.members["Tag"]).toBe("Alpha");
      expect(nodeA.members["Peer"]).toBe(nodeB);   // forward ref resolved

      expect(nodeB.typeName).toBe("Node");
      expect(nodeB.members["Value"]).toBe(200);
      expect(nodeB.members["Tag"]).toBe("Beta");
      expect(nodeB.members["Peer"]).toBe(nodeA);   // circular back-ref

      // System.Version nested class
      const ver = root.members["Version"] as NrbfObject;
      expect(ver.typeName).toBe("System.Version");
      expect(ver.members["_Major"]).toBe(4);
      expect(ver.members["_Minor"]).toBe(8);

      // Packet
      const packet = root.members["Packet"] as NrbfObject;
      expect(packet.members["Label"]).toBe("demo-packet");
      expect(packet.members["Count"]).toBe(42);

      // Matrix (rectangular BinaryArray, flattened row-major)
      expect(root.members["Matrix"]).toEqual([11, 12, 13, 21, 22, 23]);

      // Sparse arrays: nulls filled by ObjectNullMultiple/ObjectNullMultiple256
      const sparse = root.members["SparseSmall"] as (string | null)[];
      expect(sparse[0]).toBe("first");
      expect(sparse[10]).toBe("Beta");
      expect(sparse[11]).toBe("last");
      expect(sparse[1]).toBeNull();
    });
  });
});
