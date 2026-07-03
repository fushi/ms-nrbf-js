import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deserialize } from "./deserialize.js";
import { PrimitiveTypeEnumeration } from "./enums.js";
import { BinaryArrayTypeEnumeration, BinaryTypeEnumeration, PrimitiveTypeEnumeration as PTE } from "./enums.js";
import type { NrbfArray, NrbfMethodCall, NrbfMethodReturn, NrbfObject } from "./types.js";

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

  it("throws when the root objectId is never defined in the stream", () => {
    // rootId=5, but only id=1 is defined — objects.get(5) is undefined
    const stream = buf(header(5), [0x06, ...i32(1), ...lps("x")], END);
    expect(() => deserialize(stream)).toThrow(/Root object/);
  });

  it("throws on an unresolved forward reference after stream end", () => {
    // Array element references id=99 which is never defined → fixup can't resolve
    const stream = buf(
      header(1),
      [0x10, ...i32(1), ...i32(1)],  // ArraySingleObject(id=1, length=1)
      [0x09, ...i32(99)],             // MemberReference to id=99 — never defined
      END,
    );
    expect(() => deserialize(stream)).toThrow(/Unresolved forward reference/);
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
    it("uses readMembersUntyped when ClassWithId follows an untyped class (no memberTypeInfo)", () => {
      // SystemClassWithMembers stores metadata without memberTypeInfo; ClassWithId must use readMembersUntyped
      const stream = buf(
        header(2),
        [0x02, ...i32(1), ...lps("Widget"), ...i32(1), ...lps("val")],  // SystemClassWithMembers(id=1)
        [0x0a],                                                           // ObjectNull for "val"
        [0x01, ...i32(2), ...i32(1)],                                    // ClassWithId(id=2, metadataId=1)
        [0x0a],                                                           // ObjectNull for "val"
        END,
      );
      const result = deserialize(stream) as NrbfObject;
      expect(result.typeName).toBe("Widget");
      expect(result.members["val"]).toBeNull();
    });

    it("omits memberTypes when ClassWithId follows a class with no primitive members", () => {
      // ClassWithMembersAndTypes has only a String member → extractMemberTypes returns undefined
      const stream = buf(
        header(2),
        [0x0c, ...i32(5), ...lps("Lib")],
        [0x05, ...i32(1), ...lps("Box"), ...i32(1), ...lps("label"), 0x01, ...i32(5)],
        [0x06, ...i32(3), ...lps("first")],   // BinaryObjectString for "label" (first instance)
        [0x01, ...i32(2), ...i32(1)],          // ClassWithId(id=2, metadataId=1)
        [0x06, ...i32(4), ...lps("second")],   // BinaryObjectString for "label" (second instance)
        END,
      );
      const result = deserialize(stream) as NrbfObject;
      expect(result.typeName).toBe("Box");
      expect(result.libraryName).toBe("Lib");
      expect(result.memberTypes).toBeUndefined();
      expect(result.members["label"]).toBe("second");
    });

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

    it("handles three ClassWithId instances in an array — each gets independent member values", () => {
      // ArraySingleObject(id=1, len=3): first element = SCWMT Point(id=2), next two = ClassWithId
      const stream = buf(
        header(1),
        [0x10, ...i32(1), ...i32(3)],
        [
          0x04, ...i32(2), ...lps("Point"), ...i32(2), ...lps("x"), ...lps("y"),
          0x00, 0x00, 0x08, 0x08,
          ...i32(10), ...i32(20),                                         // id=2: x=10, y=20
        ],
        [0x01, ...i32(3), ...i32(2), ...i32(30), ...i32(40)],            // id=3: x=30, y=40
        [0x01, ...i32(4), ...i32(2), ...i32(50), ...i32(60)],            // id=4: x=50, y=60
        END,
      );
      const result = deserialize(stream) as NrbfObject[];
      expect(result).toHaveLength(3);
      expect(result[0]!.typeName).toBe("Point");
      expect(result[0]!.members["x"]).toBe(10);
      expect(result[0]!.members["y"]).toBe(20);
      expect(result[1]!.members["x"]).toBe(30);
      expect(result[1]!.members["y"]).toBe(40);
      expect(result[2]!.members["x"]).toBe(50);
      expect(result[2]!.members["y"]).toBe(60);
    });

    it("propagates memberTypes from the class definition to all ClassWithId instances", () => {
      // SCWMT "Range" with Byte and Int32 members, followed by a ClassWithId with different values
      const stream = buf(
        header(1),
        [0x10, ...i32(1), ...i32(2)],
        [
          0x04, ...i32(2), ...lps("Range"), ...i32(2), ...lps("lo"), ...lps("hi"),
          0x00, 0x00, 0x02, 0x08,                // BinaryType: Primitive, Primitive; PT: Byte(2), Int32(8)
          0xff,                                   // lo = 255 (Byte, 1 byte)
          ...i32(100),                            // hi = 100 (Int32)
        ],
        [0x01, ...i32(3), ...i32(2), 0x01, ...i32(200)],  // ClassWithId: lo=1, hi=200
        END,
      );
      const result = deserialize(stream) as NrbfObject[];
      expect(result[0]!.typeName).toBe("Range");
      expect(result[0]!.memberTypes?.["lo"]).toBe(PrimitiveTypeEnumeration.Byte);
      expect(result[0]!.memberTypes?.["hi"]).toBe(PrimitiveTypeEnumeration.Int32);
      expect(result[1]!.memberTypes?.["lo"]).toBe(PrimitiveTypeEnumeration.Byte);
      expect(result[1]!.memberTypes?.["hi"]).toBe(PrimitiveTypeEnumeration.Int32);
      expect(result[1]!.members["lo"]).toBe(1);
      expect(result[1]!.members["hi"]).toBe(200);
    });

    it("propagates libraryName from BinaryLibrary + ClassWithMembersAndTypes to ClassWithId", () => {
      // BinaryLibrary must appear at top level (before the array), not interleaved with elements
      const stream = buf(
        header(1),
        [0x0c, ...i32(5), ...lps("MyLib, Version=1.0.0.0")],
        [0x10, ...i32(1), ...i32(2)],
        [0x05, ...i32(2), ...lps("Dto"), ...i32(1), ...lps("id"), 0x00, 0x08, ...i32(5), ...i32(99)],
        [0x01, ...i32(3), ...i32(2), ...i32(42)],
        END,
      );
      const result = deserialize(stream) as NrbfObject[];
      expect(result[0]!.typeName).toBe("Dto");
      expect(result[0]!.libraryName).toBe("MyLib, Version=1.0.0.0");
      expect(result[0]!.members["id"]).toBe(99);
      expect(result[1]!.typeName).toBe("Dto");
      expect(result[1]!.libraryName).toBe("MyLib, Version=1.0.0.0");
      expect(result[1]!.members["id"]).toBe(42);
    });
  });

  describe("array element MemberReferences", () => {
    it("resolves a forward MemberReference in an array element via fixup", () => {
      // Array(id=1) has one element: MemberRef to id=2, which is defined AFTER the array
      const stream = buf(
        header(1),
        [0x10, ...i32(1), ...i32(1)],          // ArraySingleObject(id=1, length=1)
        [0x09, ...i32(2)],                      // MemberReference(idRef=2) — forward ref
        [0x06, ...i32(2), ...lps("forward")],   // BinaryObjectString(id=2) — defined later
        END,
      );
      expect(deserialize(stream)).toEqual(["forward"]);
    });

    it("resolves a back MemberReference in an array element directly", () => {
      // Shared string is defined before the array; array elements reference it by id
      const stream = buf(
        header(1),
        [0x06, ...i32(3), ...lps("shared")],   // BinaryObjectString(id=3) — defined first
        [0x10, ...i32(1), ...i32(2)],           // ArraySingleObject(id=1, length=2)
        [0x09, ...i32(3)],                      // MemberReference(idRef=3) — back ref
        [0x09, ...i32(3)],                      // MemberReference(idRef=3) — back ref
        END,
      );
      expect(deserialize(stream)).toEqual(["shared", "shared"]);
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
  // readRecord edge cases (record types encountered at top-level stream loop)
  // ---------------------------------------------------------------------------

  describe("readRecord edge cases", () => {
    it("handles ObjectNullMultiple256 at top level (reads and discards)", () => {
      const stream = buf(
        header(1),
        [0x0d, 0x02],                         // ObjectNullMultiple256, nullCount=2
        [0x06, ...i32(1), ...lps("ok")],      // BinaryObjectString — the actual root
        END,
      );
      expect(deserialize(stream)).toBe("ok");
    });

    it("handles ObjectNullMultiple at top level (reads and discards)", () => {
      const stream = buf(
        header(1),
        [0x0e, ...i32(300)],                  // ObjectNullMultiple, nullCount=300
        [0x06, ...i32(1), ...lps("ok")],
        END,
      );
      expect(deserialize(stream)).toBe("ok");
    });

    it("throws on an unhandled record type", () => {
      const stream = buf(header(1), [99]);
      expect(() => deserialize(stream)).toThrow(/Unhandled record type/);
    });

    it("handles a MemberReference at top level when target is already registered", () => {
      const stream = buf(
        header(1),
        [0x06, ...i32(1), ...lps("hello")],  // BinaryObjectString id=1 (root)
        [0x09, ...i32(1)],                    // MemberReference to id=1 (top-level, return discarded)
        END,
      );
      expect(deserialize(stream)).toBe("hello");
    });

    it("throws when a top-level MemberReference targets an unknown objectId", () => {
      const stream = buf(
        header(1),
        [0x06, ...i32(1), ...lps("hello")],  // BinaryObjectString id=1
        [0x09, ...i32(99)],                   // MemberReference to id=99 (not registered)
        END,
      );
      expect(() => deserialize(stream)).toThrow(/objectId=99/);
    });
  });

  // ---------------------------------------------------------------------------
  // BinaryMethodCall — ArgsIsArray call-array path
  // ---------------------------------------------------------------------------

  describe("BinaryMethodCall — ArgsIsArray call-array path", () => {
    // StringValueWithCode: PrimitiveTypeEnumeration.String (0x12) + LPS
    function svwc(s: string): number[] { return [0x12, ...lps(s)]; }

    it("deserializes mixed-type args and populates argTypes", () => {
      // messageEnum: ArgsIsArray (0x04) | NoContext (0x10) = 0x14
      // arg[0]: BinaryObjectString → type=undefined; arg[1]: MemberPrimitiveTyped Int32 → type=PTE.Int32
      const stream = buf(
        header(1),
        [0x15, ...i32(0x14), ...svwc("DoWork"), ...svwc("IWorker")],
        [0x10, ...i32(2), ...i32(2)],            // ArraySingleObject id=2, length=2
        [0x06, ...i32(3), ...lps("payload")],    // arg[0]: BinaryObjectString
        [0x08, 0x08, ...i32(42)],                // arg[1]: MemberPrimitiveTyped Int32 42
        END,
      );
      const result = deserialize(stream) as NrbfMethodCall;
      expect(result.kind).toBe("MethodCall");
      expect(result.methodName).toBe("DoWork");
      expect(result.typeName).toBe("IWorker");
      expect(result.args).toEqual(["payload", 42]);
      expect(result.argTypes).toEqual([undefined, PTE.Int32]);
    });

    it("handles ObjectNull arg — argTypes not set when no typed args present", () => {
      // messageEnum: ArgsIsArray (0x04) | NoContext (0x10) = 0x14
      const stream = buf(
        header(1),
        [0x15, ...i32(0x14), ...svwc("NullArg"), ...svwc("ISvc")],
        [0x10, ...i32(2), ...i32(1)],
        [0x0a],                                  // arg[0]: ObjectNull
        END,
      );
      const result = deserialize(stream) as NrbfMethodCall;
      expect(result.args).toEqual([null]);
      expect(result.argTypes).toBeUndefined();
    });

    it("handles ContextInArray flag — last array element becomes callContext", () => {
      // messageEnum: ArgsIsArray (0x04) | ContextInArray (0x40) = 0x44
      // argCount = length(2) - hasCtx(1) = 1
      const stream = buf(
        header(1),
        [0x15, ...i32(0x44), ...svwc("WithCtx"), ...svwc("ISvc")],
        [0x10, ...i32(2), ...i32(2)],
        [0x08, 0x08, ...i32(7)],                 // arg[0]: MemberPrimitiveTyped Int32 7
        [0x06, ...i32(3), ...lps("my-context")], // ctx: BinaryObjectString
        END,
      );
      const result = deserialize(stream) as NrbfMethodCall;
      expect(result.args).toEqual([7]);
      expect(result.argTypes).toEqual([PTE.Int32]);
      expect(result.callContext).toBe("my-context");
    });

    it("handles GenericMethod flag — extra array element becomes genericTypeArguments", () => {
      // messageEnum: ArgsIsArray (0x04) | NoContext (0x10) | GenericMethod (0x8000) = 0x8014
      // argCount = length(2) - hasGeneric(1) = 1
      const stream = buf(
        header(1),
        [0x15, ...i32(0x8014), ...svwc("GenericCall"), ...svwc("ISvc")],
        [0x10, ...i32(2), ...i32(2)],
        [0x06, ...i32(3), ...lps("arg-val")],    // arg[0]: BinaryObjectString
        // generic: ArraySingleString(id=4, length=1) with one type-name string
        [0x11, ...i32(4), ...i32(1), 0x06, ...i32(5), ...lps("System.Int32")],
        END,
      );
      const result = deserialize(stream) as NrbfMethodCall;
      expect(result.args).toEqual(["arg-val"]);
      expect(result.genericTypeArguments).toEqual(["System.Int32"]);
    });

    it("handles MethodSignatureInArray flag — extra element becomes methodSignature", () => {
      // messageEnum: ArgsIsArray (0x04) | NoContext (0x10) | MethodSignatureInArray (0x80) = 0x94
      // argCount = length(2) - hasSig(1) = 1
      const stream = buf(
        header(1),
        [0x15, ...i32(0x94), ...svwc("SigMethod"), ...svwc("ISvc")],
        [0x10, ...i32(2), ...i32(2)],
        [0x08, 0x08, ...i32(1)],                 // arg[0]: MemberPrimitiveTyped Int32 1
        // sig: ArraySingleString(id=3, length=2)
        [0x11, ...i32(3), ...i32(2),
         0x06, ...i32(4), ...lps("System.Int32"),
         0x06, ...i32(5), ...lps("System.String")],
        END,
      );
      const result = deserialize(stream) as NrbfMethodCall;
      expect(result.args).toEqual([1]);
      expect(result.methodSignature).toEqual(["System.Int32", "System.String"]);
    });

    it("handles PropertiesInArray flag — extra element becomes messageProperties", () => {
      // messageEnum: ArgsIsArray (0x04) | NoContext (0x10) | PropertiesInArray (0x100) = 0x114
      // argCount = length(2) - hasProps(1) = 1
      const stream = buf(
        header(1),
        [0x15, ...i32(0x114), ...svwc("Props"), ...svwc("ISvc")],
        [0x10, ...i32(2), ...i32(2)],
        [0x08, 0x01, 0x01],                      // arg[0]: MemberPrimitiveTyped Boolean true
        // props: ArraySingleObject(id=3, length=2)
        [0x10, ...i32(3), ...i32(2),
         0x06, ...i32(4), ...lps("k"),
         0x06, ...i32(5), ...lps("v")],
        END,
      );
      const result = deserialize(stream) as NrbfMethodCall;
      expect(result.args).toEqual([true]);
      expect(result.messageProperties).toEqual(["k", "v"]);
    });

    it("resolves a forward-referenced arg via fixup after stream end", () => {
      // MemberReference in call array pointing to id=99 which is defined AFTER the call array.
      // messageEnum: ArgsIsArray (0x04) | NoContext (0x10) = 0x14
      const stream = buf(
        header(1),
        [0x15, ...i32(0x14), ...svwc("FwdRef"), ...svwc("ISvc")],
        [0x10, ...i32(2), ...i32(1)],
        [0x09, ...i32(99)],                      // arg[0]: MemberReference to id=99 (forward ref)
        [0x06, ...i32(99), ...lps("late-arg")],  // id=99 defined after call array
        END,
      );
      const result = deserialize(stream) as NrbfMethodCall;
      expect(result.args).toEqual(["late-arg"]);
    });

    it("resolves a back-referenced arg (MemberReference to already-registered object)", () => {
      // Covers readReferenceableValueWithType line 170: `return [existing, undefined]`.
      // A BinaryObjectString is registered before the MethodCall, then referenced
      // inside the call array — existing !== undefined so the early return fires.
      // messageEnum: ArgsIsArray (0x04) | NoContext (0x10) = 0x14
      const stream = buf(
        header(1),
        [0x06, ...i32(3), ...lps("pre-defined")],  // id=3 registered before method call
        [0x15, ...i32(0x14), ...svwc("BackRef"), ...svwc("ISvc")],
        [0x10, ...i32(2), ...i32(1)],
        [0x09, ...i32(3)],                          // arg[0]: MemberReference to id=3 (already registered)
        END,
      );
      const result = deserialize(stream) as NrbfMethodCall;
      expect(result.args).toEqual(["pre-defined"]);
      expect(result.argTypes).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // BinaryMethodCall — ArgsInArray call-array path
  // ---------------------------------------------------------------------------

  describe("BinaryMethodCall — ArgsInArray call-array path", () => {
    function svwc(s: string): number[] { return [0x12, ...lps(s)]; }

    it("deserializes args from a nested sub-array (element 0 of call array)", () => {
      // messageEnum: ArgsInArray (0x08) | NoContext (0x10) = 0x18
      // Call array element 0 is itself an array containing the args.
      const stream = buf(
        header(1),
        [0x15, ...i32(0x18), ...svwc("DoWork"), ...svwc("ISvc")],
        [0x10, ...i32(2), ...i32(1)],            // outer call array: objectId=2, length=1
        // element 0: args sub-array ArraySingleObject(id=3, length=2)
        [0x10, ...i32(3), ...i32(2),
         0x06, ...i32(4), ...lps("hello"),
         0x06, ...i32(5), ...lps("world")],
        END,
      );
      const result = deserialize(stream) as NrbfMethodCall;
      expect(result.kind).toBe("MethodCall");
      expect(result.args).toEqual(["hello", "world"]);
    });

    it("handles GenericMethod flag after args sub-array", () => {
      // messageEnum: ArgsInArray (0x08) | NoContext (0x10) | GenericMethod (0x8000) = 0x8018
      const stream = buf(
        header(1),
        [0x15, ...i32(0x8018), ...svwc("Generic"), ...svwc("ISvc")],
        [0x10, ...i32(2), ...i32(2)],            // call array length=2
        // element 0: args sub-array with one int
        [0x10, ...i32(3), ...i32(1), 0x08, 0x08, ...i32(99)],
        // element 1: generic type args ArraySingleString(id=4, length=1)
        [0x11, ...i32(4), ...i32(1), 0x06, ...i32(5), ...lps("System.Int32")],
        END,
      );
      const result = deserialize(stream) as NrbfMethodCall;
      expect(result.args).toEqual([99]);
      expect(result.genericTypeArguments).toEqual(["System.Int32"]);
    });

    it("handles MethodSignatureInArray flag after args sub-array", () => {
      // messageEnum: ArgsInArray (0x08) | NoContext (0x10) | MethodSignatureInArray (0x80) = 0x98
      const stream = buf(
        header(1),
        [0x15, ...i32(0x98), ...svwc("SigMethod"), ...svwc("ISvc")],
        [0x10, ...i32(2), ...i32(2)],
        // element 0: args sub-array
        [0x10, ...i32(3), ...i32(1), 0x06, ...i32(4), ...lps("arg")],
        // element 1: signature ArraySingleString(id=5, length=2)
        [0x11, ...i32(5), ...i32(2),
         0x06, ...i32(6), ...lps("System.String"),
         0x06, ...i32(7), ...lps("System.Int32")],
        END,
      );
      const result = deserialize(stream) as NrbfMethodCall;
      expect(result.args).toEqual(["arg"]);
      expect(result.methodSignature).toEqual(["System.String", "System.Int32"]);
    });

    it("handles ContextInArray flag after args sub-array", () => {
      // messageEnum: ArgsInArray (0x08) | ContextInArray (0x40) = 0x48
      const stream = buf(
        header(1),
        [0x15, ...i32(0x48), ...svwc("WithCtx"), ...svwc("ISvc")],
        [0x10, ...i32(2), ...i32(2)],
        // element 0: args sub-array
        [0x10, ...i32(3), ...i32(1), 0x08, 0x08, ...i32(7)],
        // element 1: context string
        [0x06, ...i32(4), ...lps("ctx-value")],
        END,
      );
      const result = deserialize(stream) as NrbfMethodCall;
      expect(result.args).toEqual([7]);
      expect(result.callContext).toBe("ctx-value");
    });

    it("handles PropertiesInArray flag after args sub-array", () => {
      // messageEnum: ArgsInArray (0x08) | NoContext (0x10) | PropertiesInArray (0x100) = 0x118
      const stream = buf(
        header(1),
        [0x15, ...i32(0x118), ...svwc("Props"), ...svwc("ISvc")],
        [0x10, ...i32(2), ...i32(2)],
        // element 0: args sub-array
        [0x10, ...i32(3), ...i32(1), 0x08, 0x01, 0x01],  // MemberPrimitiveTyped Boolean true
        // element 1: properties array
        [0x10, ...i32(4), ...i32(1), 0x06, ...i32(5), ...lps("prop")],
        END,
      );
      const result = deserialize(stream) as NrbfMethodCall;
      expect(result.args).toEqual([true]);
      expect(result.messageProperties).toEqual(["prop"]);
    });

    it("drains extra elements when call array length exceeds processed entries", () => {
      // messageEnum: ArgsInArray (0x08) | NoContext (0x10) = 0x18
      // Call array length=2 but only 1 flag element — drain loop must consume element 1.
      const stream = buf(
        header(1),
        [0x15, ...i32(0x18), ...svwc("Extra"), ...svwc("ISvc")],
        [0x10, ...i32(2), ...i32(2)],
        // element 0: args sub-array
        [0x10, ...i32(3), ...i32(1), 0x06, ...i32(4), ...lps("x")],
        // element 1: extra (drained by while loop)
        [0x0a],                                  // ObjectNull
        END,
      );
      const result = deserialize(stream) as NrbfMethodCall;
      expect(result.args).toEqual(["x"]);
    });

    it("resolves a forward-referenced args sub-array via fixup", () => {
      // Element 0 is a MemberReference to an array defined after the call array.
      // messageEnum: ArgsInArray (0x08) | NoContext (0x10) = 0x18
      const stream = buf(
        header(1),
        [0x15, ...i32(0x18), ...svwc("FwdRef"), ...svwc("ISvc")],
        [0x10, ...i32(2), ...i32(1)],
        [0x09, ...i32(99)],                      // element 0: MemberReference to id=99 (forward ref)
        // id=99 defined after call array
        [0x10, ...i32(99), ...i32(1), 0x06, ...i32(100), ...lps("late")],
        END,
      );
      const result = deserialize(stream) as NrbfMethodCall;
      expect(result.args).toEqual(["late"]);
    });
  });

  // ---------------------------------------------------------------------------
  // BinaryMethodReturn — call-array forward-ref fixup callbacks
  // Each test places a MemberReference in the call array pointing to an object
  // defined AFTER the array, so the fixup callback (not the immediate path) runs.
  // ---------------------------------------------------------------------------

  describe("BinaryMethodReturn — call-array forward-ref fixup callbacks", () => {
    it("ReturnValueInArray forward-ref (line 667 callback)", () => {
      // messageEnum: ReturnValueInArray (0x1000) | NoContext (0x10) = 0x1010
      const stream = buf(
        header(1),
        [0x16, ...i32(0x1010)],                  // BinaryMethodReturn
        [0x10, ...i32(2), ...i32(1)],            // call array: objectId=2, length=1
        [0x09, ...i32(99)],                      // element 0: MemberReference to id=99
        [0x06, ...i32(99), ...lps("late-ret")],  // id=99 defined after call array
        END,
      );
      const result = deserialize(stream) as NrbfMethodReturn;
      expect(result.kind).toBe("MethodReturn");
      expect(result.returnValue).toBe("late-ret");
    });

    it("ArgsInArray forward-ref (lines 674–675 callback)", () => {
      // messageEnum: ArgsInArray (0x08) | NoContext (0x10) = 0x18
      // Element 0 is a MemberReference to an array defined after the call array.
      const stream = buf(
        header(1),
        [0x16, ...i32(0x18)],
        [0x10, ...i32(2), ...i32(1)],
        [0x09, ...i32(99)],                      // forward ref to args sub-array
        // id=99: ArraySingleObject with one element
        [0x10, ...i32(99), ...i32(1), 0x06, ...i32(100), ...lps("out-arg")],
        END,
      );
      const result = deserialize(stream) as NrbfMethodReturn;
      expect(result.args).toEqual(["out-arg"]);
    });

    it("ExceptionInArray forward-ref (line 682 callback)", () => {
      // messageEnum: ExceptionInArray (0x2000) | NoContext (0x10) = 0x2010
      const stream = buf(
        header(1),
        [0x16, ...i32(0x2010)],
        [0x10, ...i32(2), ...i32(1)],
        [0x09, ...i32(99)],                      // forward ref to exception object
        [0x06, ...i32(99), ...lps("err-msg")],   // id=99 defined after
        END,
      );
      const result = deserialize(stream) as NrbfMethodReturn;
      expect(result.exception).toBe("err-msg" as unknown as NrbfObject);
    });

    it("ContextInArray forward-ref (line 688 callback)", () => {
      // messageEnum: ContextInArray (0x40) | NoReturnValue (0x200) = 0x240
      const stream = buf(
        header(1),
        [0x16, ...i32(0x240)],
        [0x10, ...i32(2), ...i32(1)],
        [0x09, ...i32(99)],                      // forward ref to context
        [0x06, ...i32(99), ...lps("late-ctx")],
        END,
      );
      const result = deserialize(stream) as NrbfMethodReturn;
      expect(result.callContext).toBe("late-ctx");
    });

    it("PropertiesInArray forward-ref (line 694 callback)", () => {
      // messageEnum: PropertiesInArray (0x100) | NoContext (0x10) | NoReturnValue (0x200) = 0x310
      const stream = buf(
        header(1),
        [0x16, ...i32(0x310)],
        [0x10, ...i32(2), ...i32(1)],
        [0x09, ...i32(99)],                      // forward ref to properties array
        [0x10, ...i32(99), ...i32(1), 0x06, ...i32(100), ...lps("prop")],
        END,
      );
      const result = deserialize(stream) as NrbfMethodReturn;
      expect(result.messageProperties).toEqual(["prop"]);
    });

    it("drain-loop forward-ref (lines 700–701 callback)", () => {
      // Call array length=2 but only ReturnValueInArray accounts for 1 element;
      // the second element hits the drain loop as a forward ref.
      // messageEnum: ReturnValueInArray (0x1000) | NoContext (0x10) = 0x1010
      const stream = buf(
        header(1),
        [0x16, ...i32(0x1010)],
        [0x10, ...i32(2), ...i32(2)],            // length=2
        [0x06, ...i32(3), ...lps("ret")],        // element 0: return value (immediate)
        [0x09, ...i32(99)],                      // element 1: drain, forward ref
        [0x06, ...i32(99), ...lps("extra")],     // id=99 defined after
        END,
      );
      const result = deserialize(stream) as NrbfMethodReturn;
      expect(result.returnValue).toBe("ret");    // drain element is consumed but not exposed
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

      // Matrix (rectangular BinaryArray — now returned as NrbfArray with full dimension info)
      const matrix = root.members["Matrix"] as NrbfArray;
      expect(matrix.arrayType).toBe(BinaryArrayTypeEnumeration.RectangularOffset);
      expect(matrix.elements).toEqual([11, 12, 13, 21, 22, 23]);
      expect(matrix.elementBinaryType).toBe(BinaryTypeEnumeration.Primitive);
      expect(matrix.elementPrimitiveType).toBe(PTE.Int32);

      // Sparse arrays: nulls filled by ObjectNullMultiple/ObjectNullMultiple256
      const sparse = root.members["SparseSmall"] as (string | null)[];
      expect(sparse[0]).toBe("first");
      expect(sparse[10]).toBe("Beta");
      expect(sparse[11]).toBe("last");
      expect(sparse[1]).toBeNull();
    });

    it("return_value_inline_null.nrbf — ReturnValueInline with Null ValueWithCode", () => {
      const result = deserialize(readFileSync(join(fixturesDir, "return_value_inline_null.nrbf"))) as NrbfMethodReturn;
      expect(result.kind).toBe("MethodReturn");
      expect(result.returnValue).toBeNull();
      expect(result.args).toBeUndefined();
      expect(result.callContext).toBeUndefined();
    });

    it("exception_in_array.nrbf — ExceptionInArray path in MethodReturnCallArray", () => {
      const result = deserialize(readFileSync(join(fixturesDir, "exception_in_array.nrbf"))) as NrbfMethodReturn;
      expect(result.kind).toBe("MethodReturn");
      expect(result.exception).toMatchObject({
        typeName: "System.Exception",
        libraryName: "mscorlib",
        members: { _message: "test error" },
      });
      expect(result.returnValue).toBeUndefined();
      expect(result.args).toBeUndefined();
    });

    it("context_in_array_call.nrbf — ContextInArray-only path in MethodCallArray", () => {
      const result = deserialize(readFileSync(join(fixturesDir, "context_in_array_call.nrbf"))) as NrbfMethodCall;
      expect(result.kind).toBe("MethodCall");
      expect(result.methodName).toBe("Ping");
      expect(result.typeName).toBe("IService");
      expect(result.args).toBeUndefined();
      expect(result.callContext).toMatchObject({
        typeName: "System.Runtime.Remoting.Messaging.LogicalCallContext",
        libraryName: "mscorlib",
        members: { id: "ctx-42" },
      });
    });

    it("return_and_context_in_array.nrbf — ReturnValueInArray + ContextInArray path", () => {
      const result = deserialize(readFileSync(join(fixturesDir, "return_and_context_in_array.nrbf"))) as NrbfMethodReturn;
      expect(result.kind).toBe("MethodReturn");
      expect(result.returnValue).toMatchObject({ typeName: "Result", members: { code: 42, message: "ok" } });
      expect(result.callContext).toMatchObject({
        typeName: "System.Runtime.Remoting.Messaging.LogicalCallContext",
        members: { id: "r-ctx" },
      });
    });
  });
});
