import {
  BinaryArrayTypeEnumeration,
  BinaryTypeEnumeration,
  MessageFlags,
  PrimitiveTypeEnumeration,
  RecordTypeEnumeration,
} from "./enums.js";
import { BinaryWriter } from "./writer.js";
import type {
  DateTime,
  MemberTypeEntry,
  NrbfMethodCall,
  NrbfMethodReturn,
  NrbfObject,
  NrbfRoot,
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

// Infer the PrimitiveTypeEnumeration for a ValueWithCode field — includes String, unlike inferPrimitiveType.
function inferValueWithCodeType(v: NrbfValue): PrimitiveTypeEnumeration {
  if (v === null) return PrimitiveTypeEnumeration.Null;
  if (typeof v === "string") return PrimitiveTypeEnumeration.String;
  const pt = inferPrimitiveType(v);
  if (pt !== undefined) return pt;
  throw new TypeError(
    `serialize: cannot encode ${Array.isArray(v) ? "array" : "object"} as ValueWithCode — only primitives and strings are supported`,
  );
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

  run(root: NrbfRoot): Buffer {
    if (typeof root === "object" && root !== null && !Array.isArray(root) && !isDateTime(root)) {
      if ((root as NrbfMethodCall).kind === "MethodCall") return this.runMethodCall(root as NrbfMethodCall);
      if ((root as NrbfMethodReturn).kind === "MethodReturn") return this.runMethodReturn(root as NrbfMethodReturn);
    }

    const value = root as NrbfValue;
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      isDateTime(value)
    ) {
      throw new TypeError(
        "serialize: root value must be a string, NrbfObject, NrbfMethodCall, NrbfMethodReturn, or array — bare primitives have no objectId",
      );
    }

    // Assign rootId first so library IDs follow it, matching the .NET wire order.
    const rootId = this.nextId++;

    // Pre-scan to collect and register all libraryNames before writing any records.
    this.collectLibraries(value, new Set());

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

  private writeHeader(rootId = -1): void {
    this.w.writeByte(RecordTypeEnumeration.SerializedStreamHeader);
    this.w.writeInt32(rootId);
    this.w.writeInt32(-1); // headerId
    this.w.writeInt32(1);  // majorVersion
    this.w.writeInt32(0);  // minorVersion
  }

  private runMethodCall(call: NrbfMethodCall): Buffer {
    const hasComplexArgs =
      call.args !== undefined && call.args.some((v) => Array.isArray(v) || isNrbfObject(v));
    const ctxIsObject = call.callContext !== undefined && isNrbfObject(call.callContext);
    const hasGeneric = call.genericTypeArguments !== undefined;
    const hasSig = call.methodSignature !== undefined;
    const needsCallArray = hasComplexArgs || ctxIsObject || hasGeneric || hasSig || call.messageProperties !== undefined;

    if (needsCallArray) {
      const seen = new Set<object>();
      if (call.args) for (const arg of call.args) this.collectLibraries(arg as NrbfValue, seen);
      if (hasGeneric) for (const el of call.genericTypeArguments!) this.collectLibraries(el, seen);
      if (ctxIsObject) this.collectLibraries(call.callContext as NrbfObject, seen);
      if (hasSig) for (const el of call.methodSignature!) this.collectLibraries(el, seen);
      if (call.messageProperties !== undefined) for (const el of call.messageProperties) this.collectLibraries(el, seen);
    }

    let flags = MessageFlags.NoContext | MessageFlags.NoArgs;
    if (call.callContext !== undefined) {
      flags = (flags & ~MessageFlags.NoContext) | (ctxIsObject ? MessageFlags.ContextInArray : MessageFlags.ContextInline);
    }
    if (call.args !== undefined) {
      flags &= ~MessageFlags.NoArgs;
      flags |= hasComplexArgs ? MessageFlags.ArgsIsArray : MessageFlags.ArgsInline;
    }
    if (hasGeneric) {
      flags |= MessageFlags.GenericMethod;
    }
    if (hasSig) {
      flags |= MessageFlags.MethodSignatureInArray;
    }
    if (call.messageProperties !== undefined) {
      flags |= MessageFlags.PropertiesInArray;
    }

    const callArrayId = needsCallArray ? this.nextId++ : undefined;
    this.writeHeader(callArrayId ?? -1);

    if (needsCallArray) {
      for (const [name, id] of this.libraryIds) {
        this.w.writeByte(RecordTypeEnumeration.BinaryLibrary);
        this.w.writeInt32(id);
        this.w.writeLengthPrefixedString(name);
      }
    }

    this.w.writeByte(RecordTypeEnumeration.MethodCall);
    this.w.writeInt32(flags);
    this.writeStringValueWithCode(call.methodName);
    this.writeStringValueWithCode(call.typeName);
    if (call.callContext !== undefined && !ctxIsObject) this.writeStringValueWithCode(call.callContext as string);
    if (!hasComplexArgs && call.args !== undefined) this.writeArrayOfValueWithCode(call.args, call.argTypes);

    if (needsCallArray && callArrayId !== undefined) {
      // §2.2.3.2 MethodCallArray order: args (direct for ArgsIsArray), GenericTypeArgs, MethodSignature, CallContext, MessageProperties.
      const elementCount =
        (hasComplexArgs ? call.args!.length : 0) + (hasGeneric ? 1 : 0) + (hasSig ? 1 : 0) + (ctxIsObject ? 1 : 0) + (call.messageProperties !== undefined ? 1 : 0);
      this.w.writeByte(RecordTypeEnumeration.ArraySingleObject);
      this.w.writeInt32(callArrayId);
      this.w.writeInt32(elementCount);
      if (hasComplexArgs && call.args !== undefined) {
        for (let i = 0; i < call.args.length; i++) {
          this.writeAnyValue(call.args[i] as NrbfValue, call.argTypes?.[i]);
        }
      }
      if (hasGeneric) this.writeAnyValue(call.genericTypeArguments! as NrbfValue);
      if (hasSig) this.writeAnyValue(call.methodSignature! as NrbfValue);
      if (ctxIsObject) this.writeAnyValue(call.callContext as NrbfObject);
      if (call.messageProperties !== undefined) this.writeAnyValue(call.messageProperties as NrbfValue);
    }

    this.w.writeByte(RecordTypeEnumeration.MessageEnd);
    return this.w.toBuffer();
  }

  private runMethodReturn(ret: NrbfMethodReturn): Buffer {
    const hasException = ret.exception !== undefined;
    // ExceptionInArray is exclusive with Return and Args categories per spec §2.2.1.1.
    const hasComplexReturn = !hasException &&
      ret.returnValue !== undefined && (Array.isArray(ret.returnValue) || isNrbfObject(ret.returnValue));
    const hasComplexArgs = !hasException &&
      ret.args !== undefined && ret.args.some((v) => Array.isArray(v) || isNrbfObject(v));
    const ctxIsObject = ret.callContext !== undefined && isNrbfObject(ret.callContext);
    const needsCallArray = hasComplexReturn || hasComplexArgs || hasException || ctxIsObject || ret.messageProperties !== undefined;

    if (needsCallArray) {
      const seen = new Set<object>();
      if (!hasException) {
        if (ret.returnValue !== undefined) this.collectLibraries(ret.returnValue as NrbfValue, seen);
        if (ret.args !== undefined) for (const arg of ret.args) this.collectLibraries(arg as NrbfValue, seen);
      }
      if (hasException) this.collectLibraries(ret.exception!, seen);
      if (ctxIsObject) this.collectLibraries(ret.callContext as NrbfObject, seen);
      if (ret.messageProperties !== undefined) for (const el of ret.messageProperties) this.collectLibraries(el, seen);
    }

    // ExceptionInArray is mutually exclusive with Arg and Return flag categories.
    let flags = 0;
    if (hasException) {
      flags |= MessageFlags.ExceptionInArray;
    } else {
      flags |= ret.args === undefined ? MessageFlags.NoArgs
        : hasComplexArgs ? MessageFlags.ArgsInArray : MessageFlags.ArgsInline;
      flags |= ret.returnValue === undefined ? MessageFlags.ReturnValueVoid
        : ret.returnValue === null ? MessageFlags.NoReturnValue
        : hasComplexReturn ? MessageFlags.ReturnValueInArray : MessageFlags.ReturnValueInline;
    }
    flags |= ret.callContext !== undefined
      ? ctxIsObject ? MessageFlags.ContextInArray : MessageFlags.ContextInline
      : MessageFlags.NoContext;
    flags |= ret.messageProperties !== undefined ? MessageFlags.PropertiesInArray : 0;

    const callArrayId = needsCallArray ? this.nextId++ : undefined;
    this.writeHeader(callArrayId ?? -1);

    if (needsCallArray) {
      for (const [name, id] of this.libraryIds) {
        this.w.writeByte(RecordTypeEnumeration.BinaryLibrary);
        this.w.writeInt32(id);
        this.w.writeLengthPrefixedString(name);
      }
    }

    this.w.writeByte(RecordTypeEnumeration.MethodReturn);
    this.w.writeInt32(flags);
    if (!hasException && ret.returnValue !== undefined && ret.returnValue !== null && !hasComplexReturn) this.writeValueWithCode(ret.returnValue, ret.returnType);
    if (ret.callContext !== undefined && !ctxIsObject) this.writeStringValueWithCode(ret.callContext as string);
    if (!hasException && ret.args !== undefined && !hasComplexArgs) this.writeArrayOfValueWithCode(ret.args, ret.argTypes);

    if (needsCallArray && callArrayId !== undefined) {
      // MethodReturnCallArray order: ReturnValue, OutputArguments, Exception, CallContext, Properties (§2.2.3.4).
      const elementCount =
        (hasComplexReturn ? 1 : 0) + (hasComplexArgs ? 1 : 0) + (hasException ? 1 : 0) + (ctxIsObject ? 1 : 0) + (ret.messageProperties !== undefined ? 1 : 0);
      this.w.writeByte(RecordTypeEnumeration.ArraySingleObject);
      this.w.writeInt32(callArrayId);
      this.w.writeInt32(elementCount);
      if (hasComplexReturn && ret.returnValue !== undefined) this.writeAnyValue(ret.returnValue as NrbfValue);
      if (hasComplexArgs && ret.args !== undefined) this.writeAnyValue(ret.args);
      if (hasException) this.writeAnyValue(ret.exception!);
      if (ctxIsObject) this.writeAnyValue(ret.callContext as NrbfObject);
      if (ret.messageProperties !== undefined) this.writeAnyValue(ret.messageProperties as NrbfValue);
    }

    this.w.writeByte(RecordTypeEnumeration.MessageEnd);
    return this.w.toBuffer();
  }

  private writeStringValueWithCode(s: string): void {
    this.w.writeByte(PrimitiveTypeEnumeration.String);
    this.w.writeLengthPrefixedString(s);
  }

  private writeValueWithCode(v: NrbfValue, typeHint?: PrimitiveTypeEnumeration): void {
    const pt = typeHint ?? inferValueWithCodeType(v);
    this.w.writeByte(pt);
    if (pt !== PrimitiveTypeEnumeration.Null) this.w.writePrimitive(pt, v as PrimitiveValue);
  }

  private writeArrayOfValueWithCode(arr: NrbfValue[], typeHints?: (PrimitiveTypeEnumeration | undefined)[]): void {
    this.w.writeInt32(arr.length);
    for (let i = 0; i < arr.length; i++) this.writeValueWithCode(arr[i] ?? null, typeHints?.[i]);
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
  // typeHint overrides type inference for primitive values (e.g. Single, Char, UInt32); it also
  // routes string-shaped values (Char, Decimal) through MemberPrimitiveTyped instead of BinaryObjectString.
  private writeAnyValue(value: NrbfValue, typeHint?: PrimitiveTypeEnumeration): void {
    if (value === null) {
      this.w.writeByte(RecordTypeEnumeration.ObjectNull);
      return;
    }
    // If a type hint is provided (and is not String — which uses BinaryObjectString), write as
    // MemberPrimitiveTyped. This handles Char/Decimal (string in JS) and Single/UInt32 etc.
    if (typeHint !== undefined && typeHint !== PrimitiveTypeEnumeration.String && typeHint !== PrimitiveTypeEnumeration.Null) {
      this.w.writeByte(RecordTypeEnumeration.MemberPrimitiveTyped);
      this.w.writeByte(typeHint);
      this.w.writePrimitive(typeHint, value as PrimitiveValue);
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

  // If every element of `arr` is an NrbfObject of the same type, return the BinaryTypeEntry
  // for that class type. Used to emit BinaryArray(Single, Class/SystemClass) instead of
  // ArraySingleObject, preserving type info for .NET interop.
  private uniformClassEntry(
    arr: NrbfValue[],
  ):
    | { binaryType: BinaryTypeEnumeration.Class; classTypeInfo: { typeName: string; libraryId: number } }
    | { binaryType: BinaryTypeEnumeration.SystemClass; className: string }
    | undefined {
    if (arr.length === 0 || !arr.every(isNrbfObject)) return undefined;
    const first = arr[0] as NrbfObject;
    const { typeName, libraryName } = first;
    if (!arr.every((el) => (el).typeName === typeName && (el).libraryName === libraryName)) {
      return undefined;
    }
    if (libraryName) {
      return { binaryType: BinaryTypeEnumeration.Class, classTypeInfo: { typeName, libraryId: this.libraryIds.get(libraryName) ?? 0 } };
    }
    return { binaryType: BinaryTypeEnumeration.SystemClass, className: typeName };
  }

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

    const classEntry = this.uniformClassEntry(arr);
    if (classEntry !== undefined) {
      this.w.writeByte(RecordTypeEnumeration.BinaryArray);
      this.w.writeInt32(objectId);
      this.w.writeByte(BinaryArrayTypeEnumeration.Single);
      this.w.writeInt32(1); // rank
      this.w.writeInt32(arr.length); // lengths[0]
      // no lowerBounds for Single
      this.w.writeByte(classEntry.binaryType);
      if (classEntry.binaryType === BinaryTypeEnumeration.Class) {
        this.w.writeLengthPrefixedString(classEntry.classTypeInfo.typeName);
        this.w.writeInt32(classEntry.classTypeInfo.libraryId);
      } else {
        this.w.writeLengthPrefixedString(classEntry.className);
      }
      for (const el of arr) this.writeAnyValue(el);
      return;
    }

    this.w.writeByte(RecordTypeEnumeration.ArraySingleObject);
    this.w.writeInt32(objectId);
    this.w.writeInt32(arr.length);
    for (const el of arr) this.writeAnyValue(el);
  }
}

export function serialize(root: NrbfRoot): Buffer {
  return new Serializer().run(root);
}
