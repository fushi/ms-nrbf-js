import {
  BinaryTypeEnumeration,
  PrimitiveTypeEnumeration,
  RecordTypeEnumeration,
} from "./enums.js";
import { BinaryWriter } from "./writer.js";
import type {
  DateTime,
  MemberTypeEntry,
  NrbfObject,
  NrbfValue,
  PrimitiveValue,
} from "./types.js";

// ---------------------------------------------------------------------------
// Type inference helpers
// ---------------------------------------------------------------------------

function isDateTime(v: unknown): v is DateTime {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    "ticks" in v &&
    "kind" in v
  );
}

function isNrbfObject(v: unknown): v is NrbfObject {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    "typeName" in v &&
    "members" in v
  );
}

// Map an NrbfValue to the PrimitiveTypeEnumeration that describes it.
// Returns undefined when the value is a string, object, or array.
function inferPrimitiveType(v: NrbfValue): PrimitiveTypeEnumeration | undefined {
  if (v === null) return PrimitiveTypeEnumeration.Null;
  if (typeof v === "boolean") return PrimitiveTypeEnumeration.Boolean;
  if (typeof v === "bigint") return PrimitiveTypeEnumeration.Int64;
  if (isDateTime(v)) return PrimitiveTypeEnumeration.DateTime;
  if (typeof v === "number") {
    return Number.isInteger(v) && v >= -2_147_483_648 && v <= 2_147_483_647
      ? PrimitiveTypeEnumeration.Int32
      : PrimitiveTypeEnumeration.Double;
  }
  return undefined;
}

// If every element of `arr` has the same primitive type, return it. Otherwise undefined.
function uniformPrimitiveType(arr: NrbfValue[]): PrimitiveTypeEnumeration | undefined {
  if (arr.length === 0) return undefined;
  const first = inferPrimitiveType(arr[0] ?? null);
  if (first === undefined || first === PrimitiveTypeEnumeration.Null) return undefined;
  return arr.every((el) => inferPrimitiveType(el) === first) ? first : undefined;
}

// ---------------------------------------------------------------------------
// Per-class metadata tracked during serialization
// ---------------------------------------------------------------------------

interface ClassSerializeMeta {
  firstObjectId: number;
  memberNames: string[];
  memberTypeEntries: MemberTypeEntry[];
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

class Serializer {
  private readonly w = new BinaryWriter();
  private nextId = 1;
  private readonly objectIds = new WeakMap<object, number>();
  private readonly classMeta = new Map<string, ClassSerializeMeta>();
  private readonly libraryIds = new Map<string, number>();

  run(value: NrbfValue): Buffer {
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      isDateTime(value)
    ) {
      throw new TypeError(
        "serialize: root value must be a string, NrbfObject, or array — bare primitives have no objectId",
      );
    }

    // Pre-scan to collect and register all libraryNames before writing any records.
    this.collectLibraries(value, new Set());

    const rootId = this.nextId++;

    // SerializationHeaderRecord
    this.w.writeByte(RecordTypeEnumeration.SerializedStreamHeader);
    this.w.writeInt32(rootId);
    this.w.writeInt32(-1); // headerId
    this.w.writeInt32(1);  // majorVersion
    this.w.writeInt32(0);  // minorVersion

    // Write all BinaryLibrary records upfront
    for (const [name, id] of this.libraryIds) {
      this.w.writeByte(RecordTypeEnumeration.BinaryLibrary);
      this.w.writeInt32(id);
      this.w.writeLengthPrefixedString(name);
    }

    this.writeValue(value, rootId);

    this.w.writeByte(RecordTypeEnumeration.MessageEnd);
    return this.w.toBuffer();
  }

  private collectLibraries(value: NrbfValue, seen: Set<object>): void {
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const el of value) this.collectLibraries(el, seen);
    } else if (isNrbfObject(value)) {
      if (value.libraryName && !this.libraryIds.has(value.libraryName)) {
        this.libraryIds.set(value.libraryName, this.nextId++);
      }
      for (const v of Object.values(value.members)) this.collectLibraries(v, seen);
    }
  }

  // Write `value` using the pre-assigned `objectId` as its identity.
  private writeValue(value: NrbfValue, objectId: number): void {
    if (typeof value === "string") {
      this.w.writeByte(RecordTypeEnumeration.BinaryObjectString);
      this.w.writeInt32(objectId);
      this.w.writeLengthPrefixedString(value);
    } else if (Array.isArray(value)) {
      this.objectIds.set(value, objectId);
      this.writeArray(value, objectId);
    } else if (isNrbfObject(value)) {
      this.objectIds.set(value, objectId);
      this.writeNrbfObject(value, objectId);
    }
  }

  // Write any NrbfValue as a standalone record (allocates a fresh objectId for objects).
  private writeAnyValue(value: NrbfValue): void {
    if (value === null) {
      this.w.writeByte(RecordTypeEnumeration.ObjectNull);
      return;
    }
    if (typeof value === "string") {
      this.w.writeByte(RecordTypeEnumeration.BinaryObjectString);
      this.w.writeInt32(this.nextId++);
      this.w.writeLengthPrefixedString(value);
      return;
    }
    if (typeof value === "object") {
      const existingId = this.objectIds.get(value);
      if (existingId !== undefined) {
        this.w.writeByte(RecordTypeEnumeration.MemberReference);
        this.w.writeInt32(existingId);
        return;
      }
      const id = this.nextId++;
      this.writeValue(value, id);
      return;
    }
    // boolean, number, bigint, DateTime
    const primType = inferPrimitiveType(value);
    if (primType === undefined) {
      throw new TypeError(`serialize: cannot infer primitive type for value: ${String(value)}`);
    }
    this.w.writeByte(RecordTypeEnumeration.MemberPrimitiveTyped);
    this.w.writeByte(primType);
    this.w.writePrimitive(primType, value);
  }

  // Write a member value according to its pre-determined MemberTypeEntry.
  private writeMemberValue(value: NrbfValue, entry: MemberTypeEntry): void {
    if (entry.binaryType === BinaryTypeEnumeration.Primitive) {
      // Inline raw bytes — no record type prefix (§2.5.2 MemberPrimitiveUnTyped)
      this.w.writePrimitive(entry.primitiveType, value as PrimitiveValue);
      return;
    }
    if (entry.binaryType === BinaryTypeEnumeration.PrimitiveArray && Array.isArray(value)) {
      // Use the exact element type from the entry, not inferred from JS values
      const id = this.nextId++;
      this.objectIds.set(value, id);
      this.w.writeByte(RecordTypeEnumeration.ArraySinglePrimitive);
      this.w.writeInt32(id);
      this.w.writeInt32(value.length);
      this.w.writeByte(entry.primitiveType);
      for (const el of value) this.w.writePrimitive(entry.primitiveType, el as PrimitiveValue);
      return;
    }
    this.writeAnyValue(value);
  }

  // ---------------------------------------------------------------------------
  // Class records
  // ---------------------------------------------------------------------------

  private classKey(obj: NrbfObject): string {
    return obj.libraryName ? `${obj.typeName}@${obj.libraryName}` : obj.typeName;
  }

  // `hint` is the PrimitiveTypeEnumeration from the original deserialized memberTypes,
  // used to avoid lossy inference (e.g. Single→Double, UInt32→Double).
  private inferMemberTypeEntry(value: NrbfValue, hint?: PrimitiveTypeEnumeration): MemberTypeEntry {
    if (hint !== undefined) {
      if (Array.isArray(value)) {
        return { binaryType: BinaryTypeEnumeration.PrimitiveArray, primitiveType: hint };
      }
      return { binaryType: BinaryTypeEnumeration.Primitive, primitiveType: hint };
    }

    if (value === null) return { binaryType: BinaryTypeEnumeration.Object };

    const primType = inferPrimitiveType(value);
    if (primType !== undefined && primType !== PrimitiveTypeEnumeration.Null) {
      return { binaryType: BinaryTypeEnumeration.Primitive, primitiveType: primType };
    }
    if (typeof value === "string") return { binaryType: BinaryTypeEnumeration.String };

    if (Array.isArray(value)) {
      const pt = uniformPrimitiveType(value);
      if (pt !== undefined) return { binaryType: BinaryTypeEnumeration.PrimitiveArray, primitiveType: pt };
      if (value.every((el) => typeof el === "string" || el === null)) {
        return { binaryType: BinaryTypeEnumeration.StringArray };
      }
      return { binaryType: BinaryTypeEnumeration.ObjectArray };
    }

    if (isNrbfObject(value)) {
      if (value.libraryName) {
        const libraryId = this.libraryIds.get(value.libraryName) ?? 0;
        return { binaryType: BinaryTypeEnumeration.Class, classTypeInfo: { typeName: value.typeName, libraryId } };
      }
      return { binaryType: BinaryTypeEnumeration.SystemClass, className: value.typeName };
    }

    return { binaryType: BinaryTypeEnumeration.Object };
  }

  private writeMemberTypeInfo(entries: MemberTypeEntry[]): void {
    // Pass 1: all BinaryTypeEnums
    for (const e of entries) this.w.writeByte(e.binaryType);
    // Pass 2: AdditionalInfos (only for types that require them)
    for (const e of entries) {
      switch (e.binaryType) {
        case BinaryTypeEnumeration.Primitive:
        case BinaryTypeEnumeration.PrimitiveArray:
          this.w.writeByte(e.primitiveType);
          break;
        case BinaryTypeEnumeration.SystemClass:
          this.w.writeLengthPrefixedString(e.className);
          break;
        case BinaryTypeEnumeration.Class:
          this.w.writeLengthPrefixedString(e.classTypeInfo.typeName);
          this.w.writeInt32(e.classTypeInfo.libraryId);
          break;
      }
    }
  }

  private writeClassInfo(objectId: number, typeName: string, memberNames: string[]): void {
    this.w.writeInt32(objectId);
    this.w.writeLengthPrefixedString(typeName);
    this.w.writeInt32(memberNames.length);
    for (const name of memberNames) this.w.writeLengthPrefixedString(name);
  }

  private writeNrbfObject(obj: NrbfObject, objectId: number): void {
    const key = this.classKey(obj);
    const existing = this.classMeta.get(key);
    const memberEntries = Object.entries(obj.members);

    if (existing !== undefined) {
      // Subsequent instance → ClassWithId
      this.w.writeByte(RecordTypeEnumeration.ClassWithId);
      this.w.writeInt32(objectId);
      this.w.writeInt32(existing.firstObjectId);
      for (let i = 0; i < existing.memberNames.length; i++) {
        this.writeMemberValue(obj.members[existing.memberNames[i]!] ?? null, existing.memberTypeEntries[i]!);
      }
      return;
    }

    // First instance → ClassWithMembersAndTypes or SystemClassWithMembersAndTypes
    const memberNames = memberEntries.map(([k]) => k);
    const memberTypeEntries = memberEntries.map(([name, v]) =>
      this.inferMemberTypeEntry(v, obj.memberTypes?.[name]),
    );
    this.classMeta.set(key, { firstObjectId: objectId, memberNames, memberTypeEntries });

    if (obj.libraryName) {
      const libraryId = this.libraryIds.get(obj.libraryName) ?? 0;
      this.w.writeByte(RecordTypeEnumeration.ClassWithMembersAndTypes);
      this.writeClassInfo(objectId, obj.typeName, memberNames);
      this.writeMemberTypeInfo(memberTypeEntries);
      this.w.writeInt32(libraryId);
    } else {
      this.w.writeByte(RecordTypeEnumeration.SystemClassWithMembersAndTypes);
      this.writeClassInfo(objectId, obj.typeName, memberNames);
      this.writeMemberTypeInfo(memberTypeEntries);
    }

    for (let i = 0; i < memberNames.length; i++) {
      this.writeMemberValue(memberEntries[i]![1], memberTypeEntries[i]!);
    }
  }

  // ---------------------------------------------------------------------------
  // Array records
  // ---------------------------------------------------------------------------

  private writeArray(arr: NrbfValue[], objectId: number): void {
    const primType = uniformPrimitiveType(arr);

    if (primType !== undefined) {
      this.w.writeByte(RecordTypeEnumeration.ArraySinglePrimitive);
      this.w.writeInt32(objectId);
      this.w.writeInt32(arr.length);
      this.w.writeByte(primType);
      for (const el of arr) this.w.writePrimitive(primType, el as PrimitiveValue);
      return;
    }

    if (arr.every((el) => typeof el === "string" || el === null)) {
      this.w.writeByte(RecordTypeEnumeration.ArraySingleString);
      this.w.writeInt32(objectId);
      this.w.writeInt32(arr.length);
      for (const el of arr) this.writeAnyValue(el);
      return;
    }

    this.w.writeByte(RecordTypeEnumeration.ArraySingleObject);
    this.w.writeInt32(objectId);
    this.w.writeInt32(arr.length);
    for (const el of arr) this.writeAnyValue(el);
  }
}

export function serialize(value: NrbfValue): Buffer {
  return new Serializer().run(value);
}
