import {
  BinaryArrayTypeEnumeration,
  BinaryTypeEnumeration,
  MessageFlags,
  PrimitiveTypeEnumeration,
  RecordTypeEnumeration,
} from "./enums.js";
import { BinaryReader } from "./reader.js";
import {
  ClassInfo,
  MemberTypeEntry,
  MemberTypeInfo,
  NrbfMethodCall,
  NrbfMethodReturn,
  NrbfObject,
  NrbfRoot,
  NrbfValue,
} from "./types.js";

interface ClassMeta {
  classInfo: ClassInfo;
  memberTypeInfo?: MemberTypeInfo;
  libraryId?: number;
}

// A deferred assignment to apply after all records are parsed (resolves forward references).
interface Fixup {
  set: (v: NrbfValue) => void;
  idRef: number;
}

class Deserializer {
  private readonly r: BinaryReader;
  private readonly objects = new Map<number, NrbfValue>();
  private readonly classesByObjectId = new Map<number, ClassMeta>();
  private readonly classesByName = new Map<string, ClassMeta>();
  private readonly libraries = new Map<number, string>();
  private readonly fixups: Fixup[] = [];

  constructor(buf: Buffer) {
    this.r = new BinaryReader(buf);
  }

  run(): NrbfRoot {
    const firstTag = this.r.readByte() as RecordTypeEnumeration;
    if (firstTag !== RecordTypeEnumeration.SerializedStreamHeader) {
      throw new Error(`Expected SerializationHeaderRecord (0) as first byte, got ${firstTag}`);
    }
    const rootId = this.r.readInt32();
    this.r.readInt32(); // headerId (ignored on read per spec)
    this.r.readInt32(); // majorVersion
    this.r.readInt32(); // minorVersion

    let methodRecord: NrbfMethodCall | NrbfMethodReturn | undefined;

    while (true) {
      const tag = this.r.readByte() as RecordTypeEnumeration;
      if (tag === RecordTypeEnumeration.MessageEnd) break;
      if (tag === RecordTypeEnumeration.MethodCall) {
        methodRecord = this.readBinaryMethodCall();
      } else if (tag === RecordTypeEnumeration.MethodReturn) {
        methodRecord = this.readBinaryMethodReturn();
      } else {
        this.readRecord(tag);
      }
    }

    // Resolve any forward references (e.g. circular object graphs)
    for (const { set, idRef } of this.fixups) {
      const value = this.objects.get(idRef);
      if (value === undefined) throw new Error(`Unresolved forward reference to objectId=${idRef}`);
      set(value);
    }

    if (methodRecord !== undefined) return methodRecord;

    const root = this.objects.get(rootId);
    if (root === undefined) throw new Error(`Root object (objectId=${rootId}) not found in stream`);
    return root;
  }

  // -------------------------------------------------------------------------
  // Record dispatcher
  // -------------------------------------------------------------------------

  private readRecord(tag: RecordTypeEnumeration): NrbfValue {
    switch (tag) {
      case RecordTypeEnumeration.BinaryLibrary:            return this.readBinaryLibrary();
      case RecordTypeEnumeration.BinaryObjectString:       return this.readBinaryObjectString();
      case RecordTypeEnumeration.ClassWithMembersAndTypes: return this.readClassWithMembersAndTypes();
      case RecordTypeEnumeration.SystemClassWithMembersAndTypes: return this.readSystemClassWithMembersAndTypes();
      case RecordTypeEnumeration.ClassWithMembers:         return this.readClassWithMembers();
      case RecordTypeEnumeration.SystemClassWithMembers:   return this.readSystemClassWithMembers();
      case RecordTypeEnumeration.ClassWithId:              return this.readClassWithId();
      case RecordTypeEnumeration.BinaryArray:              return this.readBinaryArray();
      case RecordTypeEnumeration.ArraySinglePrimitive:     return this.readArraySinglePrimitive();
      case RecordTypeEnumeration.ArraySingleObject:        return this.readArraySingleObject();
      case RecordTypeEnumeration.ArraySingleString:        return this.readArraySingleString();
      case RecordTypeEnumeration.MemberReference:          return this.readMemberReference();
      case RecordTypeEnumeration.MemberPrimitiveTyped:     return this.readMemberPrimitiveTyped();
      case RecordTypeEnumeration.ObjectNull:               return null;
      case RecordTypeEnumeration.ObjectNullMultiple256:
        this.r.readByte(); // nullCount — caller handles multi-null in array context
        return null;
      case RecordTypeEnumeration.ObjectNullMultiple:
        this.r.readInt32();
        return null;
      default:
        throw new Error(`Unhandled record type: ${tag}`);
    }
  }

  // -------------------------------------------------------------------------
  // Scalar records
  // -------------------------------------------------------------------------

  private readBinaryLibrary(): null {
    const libraryId = this.r.readInt32();
    this.libraries.set(libraryId, this.r.readLengthPrefixedString());
    return null;
  }

  private readBinaryObjectString(): string {
    const objectId = this.r.readInt32();
    const value = this.r.readLengthPrefixedString();
    this.objects.set(objectId, value);
    return value;
  }

  private readMemberPrimitiveTyped(): NrbfValue {
    return this.r.readPrimitive(this.r.readByte() as PrimitiveTypeEnumeration);
  }

  private readMemberReference(): NrbfValue {
    const idRef = this.r.readInt32();
    const value = this.objects.get(idRef);
    if (value === undefined) {
      throw new Error(`MemberReference to unknown objectId=${idRef} (use readReferenceableValue for forward-ref support)`);
    }
    return value;
  }

  // -------------------------------------------------------------------------
  // Reads the next value, registering a fixup if it's a forward MemberReference.
  // Use this for all typed/untyped member reads and array elements.
  // -------------------------------------------------------------------------

  private readReferenceableValue(onForwardRef: (v: NrbfValue) => void): NrbfValue {
    const tag = this.r.readByte() as RecordTypeEnumeration;
    if (tag === RecordTypeEnumeration.MemberReference) {
      const idRef = this.r.readInt32();
      const existing = this.objects.get(idRef);
      if (existing !== undefined) return existing;
      this.fixups.push({ set: onForwardRef, idRef });
      return null; // placeholder — overwritten when fixup is applied
    }
    return this.readRecord(tag);
  }

  // -------------------------------------------------------------------------
  // ClassInfo + MemberTypeInfo wire parsing
  // -------------------------------------------------------------------------

  private readClassInfo(): ClassInfo {
    const objectId = this.r.readInt32();
    const name = this.r.readLengthPrefixedString();
    const memberCount = this.r.readInt32();
    const memberNames: string[] = [];
    for (let i = 0; i < memberCount; i++) memberNames.push(this.r.readLengthPrefixedString());
    return { objectId, name, memberNames };
  }

  private readMemberTypeInfo(count: number): MemberTypeInfo {
    const binaryTypes: BinaryTypeEnumeration[] = [];
    for (let i = 0; i < count; i++) binaryTypes.push(this.r.readByte() as BinaryTypeEnumeration);

    const entries: MemberTypeEntry[] = [];
    for (const binaryType of binaryTypes) {
      switch (binaryType) {
        case BinaryTypeEnumeration.Primitive:
        case BinaryTypeEnumeration.PrimitiveArray:
          entries.push({ binaryType, primitiveType: this.r.readByte() as PrimitiveTypeEnumeration });
          break;
        case BinaryTypeEnumeration.SystemClass:
          entries.push({ binaryType, className: this.r.readLengthPrefixedString() });
          break;
        case BinaryTypeEnumeration.Class:
          entries.push({ binaryType, classTypeInfo: { typeName: this.r.readLengthPrefixedString(), libraryId: this.r.readInt32() } });
          break;
        default:
          entries.push({ binaryType } as MemberTypeEntry);
      }
    }
    return entries;
  }

  // -------------------------------------------------------------------------
  // Member value reading
  // -------------------------------------------------------------------------

  private readMembers(classInfo: ClassInfo, memberTypeInfo: MemberTypeInfo): Record<string, NrbfValue> {
    const members: Record<string, NrbfValue> = {};
    for (let i = 0; i < classInfo.memberNames.length; i++) {
      const name = classInfo.memberNames[i]!;
      const typeEntry = memberTypeInfo[i]!;
      if (typeEntry.binaryType === BinaryTypeEnumeration.Primitive) {
        members[name] = this.r.readPrimitive(typeEntry.primitiveType);
      } else {
        members[name] = this.readReferenceableValue((v) => { members[name] = v; });
      }
    }
    return members;
  }

  private readMembersUntyped(classInfo: ClassInfo): Record<string, NrbfValue> {
    const members: Record<string, NrbfValue> = {};
    for (const name of classInfo.memberNames) {
      members[name] = this.readReferenceableValue((v) => { members[name] = v; });
    }
    return members;
  }

  // Build a memberTypes record from MemberTypeInfo for Primitive/PrimitiveArray members.
  private extractMemberTypes(
    classInfo: ClassInfo,
    memberTypeInfo: MemberTypeInfo,
  ): Record<string, PrimitiveTypeEnumeration> | undefined {
    const result: Record<string, PrimitiveTypeEnumeration> = {};
    let any = false;
    for (let i = 0; i < classInfo.memberNames.length; i++) {
      const entry = memberTypeInfo[i]!;
      if (
        entry.binaryType === BinaryTypeEnumeration.Primitive ||
        entry.binaryType === BinaryTypeEnumeration.PrimitiveArray
      ) {
        result[classInfo.memberNames[i]!] = entry.primitiveType;
        any = true;
      }
    }
    return any ? result : undefined;
  }

  private storeClassMeta(meta: ClassMeta, nameKey: string): void {
    this.classesByObjectId.set(meta.classInfo.objectId, meta);
    this.classesByName.set(nameKey, meta);
  }

  // -------------------------------------------------------------------------
  // Class records
  // -------------------------------------------------------------------------

  private readClassWithMembersAndTypes(): NrbfObject {
    const classInfo = this.readClassInfo();
    const memberTypeInfo = this.readMemberTypeInfo(classInfo.memberNames.length);
    const libraryId = this.r.readInt32();
    this.storeClassMeta({ classInfo, memberTypeInfo, libraryId }, `${classInfo.name}@${libraryId}`);

    const obj: NrbfObject = { typeName: classInfo.name, members: {} };
    const libraryName = this.libraries.get(libraryId);
    if (libraryName !== undefined) obj.libraryName = libraryName;
    const memberTypes = this.extractMemberTypes(classInfo, memberTypeInfo);
    if (memberTypes !== undefined) obj.memberTypes = memberTypes;
    this.objects.set(classInfo.objectId, obj);
    obj.members = this.readMembers(classInfo, memberTypeInfo);
    return obj;
  }

  private readSystemClassWithMembersAndTypes(): NrbfObject {
    const classInfo = this.readClassInfo();
    const memberTypeInfo = this.readMemberTypeInfo(classInfo.memberNames.length);
    this.storeClassMeta({ classInfo, memberTypeInfo }, classInfo.name);

    const obj: NrbfObject = { typeName: classInfo.name, members: {} };
    const memberTypes = this.extractMemberTypes(classInfo, memberTypeInfo);
    if (memberTypes !== undefined) obj.memberTypes = memberTypes;
    this.objects.set(classInfo.objectId, obj);
    obj.members = this.readMembers(classInfo, memberTypeInfo);
    return obj;
  }

  private readClassWithMembers(): NrbfObject {
    const classInfo = this.readClassInfo();
    const libraryId = this.r.readInt32();
    this.storeClassMeta({ classInfo, libraryId }, `${classInfo.name}@${libraryId}`);

    const obj: NrbfObject = { typeName: classInfo.name, members: {} };
    this.objects.set(classInfo.objectId, obj);
    const knownMeta = this.classesByName.get(`${classInfo.name}@${libraryId}`);
    obj.members = knownMeta?.memberTypeInfo
      ? this.readMembers(classInfo, knownMeta.memberTypeInfo)
      : this.readMembersUntyped(classInfo);
    return obj;
  }

  private readSystemClassWithMembers(): NrbfObject {
    const classInfo = this.readClassInfo();
    this.storeClassMeta({ classInfo }, classInfo.name);

    const obj: NrbfObject = { typeName: classInfo.name, members: {} };
    this.objects.set(classInfo.objectId, obj);
    const knownMeta = this.classesByName.get(classInfo.name);
    obj.members = knownMeta?.memberTypeInfo
      ? this.readMembers(classInfo, knownMeta.memberTypeInfo)
      : this.readMembersUntyped(classInfo);
    return obj;
  }

  private readClassWithId(): NrbfObject {
    const objectId = this.r.readInt32();
    const metadataId = this.r.readInt32();
    const meta = this.classesByObjectId.get(metadataId);
    if (!meta) throw new Error(`ClassWithId: no metadata found for metadataId=${metadataId}`);

    const obj: NrbfObject = { typeName: meta.classInfo.name, members: {} };
    if (meta.libraryId !== undefined) {
      const libraryName = this.libraries.get(meta.libraryId);
      if (libraryName !== undefined) obj.libraryName = libraryName;
    }
    if (meta.memberTypeInfo) {
      const memberTypes = this.extractMemberTypes(meta.classInfo, meta.memberTypeInfo);
      if (memberTypes !== undefined) obj.memberTypes = memberTypes;
    }
    this.objects.set(objectId, obj);
    obj.members = meta.memberTypeInfo
      ? this.readMembers(meta.classInfo, meta.memberTypeInfo)
      : this.readMembersUntyped(meta.classInfo);
    return obj;
  }

  // -------------------------------------------------------------------------
  // Array records
  // -------------------------------------------------------------------------

  private readArraySinglePrimitive(): NrbfValue[] {
    const objectId = this.r.readInt32();
    const length = this.r.readInt32();
    const primitiveType = this.r.readByte() as PrimitiveTypeEnumeration;
    const arr: NrbfValue[] = [];
    this.objects.set(objectId, arr);
    for (let i = 0; i < length; i++) arr.push(this.r.readPrimitive(primitiveType));
    return arr;
  }

  private readArraySingleObject(): NrbfValue[] {
    const objectId = this.r.readInt32();
    const length = this.r.readInt32();
    const arr: NrbfValue[] = [];
    this.objects.set(objectId, arr);
    this.readArrayElements(arr, length);
    return arr;
  }

  private readArraySingleString(): NrbfValue[] {
    const objectId = this.r.readInt32();
    const length = this.r.readInt32();
    const arr: NrbfValue[] = [];
    this.objects.set(objectId, arr);
    this.readArrayElements(arr, length);
    return arr;
  }

  private readBinaryArray(): NrbfValue[] {
    const objectId = this.r.readInt32();
    const arrayTypeEnum = this.r.readByte() as BinaryArrayTypeEnumeration;
    const rank = this.r.readInt32();
    const lengths: number[] = [];
    for (let i = 0; i < rank; i++) lengths.push(this.r.readInt32());

    const hasLowerBounds =
      arrayTypeEnum === BinaryArrayTypeEnumeration.SingleOffset ||
      arrayTypeEnum === BinaryArrayTypeEnumeration.JaggedOffset ||
      arrayTypeEnum === BinaryArrayTypeEnumeration.RectangularOffset;
    if (hasLowerBounds) for (let i = 0; i < rank; i++) this.r.readInt32();

    const typeEnum = this.r.readByte() as BinaryTypeEnumeration;
    let primitiveType: PrimitiveTypeEnumeration | undefined;
    switch (typeEnum) {
      case BinaryTypeEnumeration.Primitive:
      case BinaryTypeEnumeration.PrimitiveArray:
        primitiveType = this.r.readByte() as PrimitiveTypeEnumeration;
        break;
      case BinaryTypeEnumeration.SystemClass: this.r.readLengthPrefixedString(); break;
      case BinaryTypeEnumeration.Class: this.r.readLengthPrefixedString(); this.r.readInt32(); break;
    }

    const totalElements = lengths.reduce((a, b) => a * b, 1);
    const arr: NrbfValue[] = [];
    this.objects.set(objectId, arr);

    if (primitiveType !== undefined) {
      for (let i = 0; i < totalElements; i++) arr.push(this.r.readPrimitive(primitiveType));
    } else {
      this.readArrayElements(arr, totalElements);
    }
    return arr;
  }

  private readArrayElements(arr: NrbfValue[], remaining: number): void {
    while (remaining > 0) {
      const tag = this.r.readByte() as RecordTypeEnumeration;

      if (tag === RecordTypeEnumeration.ObjectNullMultiple256) {
        const count = this.r.readByte();
        for (let i = 0; i < count; i++) arr.push(null);
        remaining -= count;
      } else if (tag === RecordTypeEnumeration.ObjectNullMultiple) {
        const count = this.r.readInt32();
        for (let i = 0; i < count; i++) arr.push(null);
        remaining -= count;
      } else if (tag === RecordTypeEnumeration.MemberReference) {
        const idRef = this.r.readInt32();
        const existing = this.objects.get(idRef);
        const idx = arr.length;
        arr.push(existing ?? null);
        if (existing === undefined) this.fixups.push({ set: (v) => { arr[idx] = v; }, idRef });
        remaining--;
      } else {
        arr.push(this.readRecord(tag));
        remaining--;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Method invocation records (§2.2.3)
  // -------------------------------------------------------------------------

  private readBinaryMethodCall(): NrbfMethodCall {
    const messageEnum = this.r.readInt32();
    const methodName = this.readStringValueWithCode();
    const typeName = this.readStringValueWithCode();

    const result: NrbfMethodCall = { kind: "MethodCall", methodName, typeName };
    if (messageEnum & MessageFlags.ContextInline) result.callContext = this.readStringValueWithCode();
    if (messageEnum & MessageFlags.ArgsInline) {
      result.args = this.readArrayOfValueWithCode();
    } else if (
      (messageEnum & MessageFlags.ArgsIsArray) ||
      (messageEnum & MessageFlags.ArgsInArray) ||
      (messageEnum & MessageFlags.ContextInArray) ||
      (messageEnum & MessageFlags.PropertiesInArray)
    ) {
      this.readCallArray(messageEnum, result);
    }
    return result;
  }

  private readBinaryMethodReturn(): NrbfMethodReturn {
    const messageEnum = this.r.readInt32();
    const result: NrbfMethodReturn = { kind: "MethodReturn" };
    if (messageEnum & MessageFlags.ReturnValueInline) result.returnValue = this.readValueWithCode();
    if (messageEnum & MessageFlags.NoReturnValue) result.returnValue = null;
    if (messageEnum & MessageFlags.ContextInline) result.callContext = this.readStringValueWithCode();
    if (messageEnum & MessageFlags.ArgsInline) {
      result.args = this.readArrayOfValueWithCode();
    } else if (
      (messageEnum & MessageFlags.ReturnValueInArray) ||
      (messageEnum & MessageFlags.ArgsInArray) ||
      (messageEnum & MessageFlags.ExceptionInArray) ||
      (messageEnum & MessageFlags.ContextInArray) ||
      (messageEnum & MessageFlags.PropertiesInArray)
    ) {
      this.readCallArray(messageEnum, result);
    }
    return result;
  }

  // §2.2.3.2 / §2.2.3.4 — reads the ArraySingleObject that immediately follows a method record
  // when ArgsIsArray, ArgsInArray, or ReturnValueInArray flags are set.
  private readCallArray(messageEnum: number, result: NrbfMethodCall | NrbfMethodReturn): void {
    // Skip any leading BinaryLibrary records (grammar: callArray = 0*1(BinaryLibrary) ArraySingleObject ...)
    let tag = this.r.readByte() as RecordTypeEnumeration;
    while (tag === RecordTypeEnumeration.BinaryLibrary) {
      this.readRecord(tag);
      tag = this.r.readByte() as RecordTypeEnumeration;
    }
    if (tag !== RecordTypeEnumeration.ArraySingleObject) {
      throw new Error(`Expected ArraySingleObject for callArray, got record type ${tag}`);
    }

    const objectId = this.r.readInt32();
    const length = this.r.readInt32();
    const arr: NrbfValue[] = [];
    this.objects.set(objectId, arr);

    if (result.kind === "MethodCall") {
      if (messageEnum & MessageFlags.ArgsIsArray) {
        // With ArgsIsArray, each arg is a direct element followed by optional context and properties.
        const hasCtx = !!(messageEnum & MessageFlags.ContextInArray);
        const hasProps = !!(messageEnum & MessageFlags.PropertiesInArray);
        const argCount = length - (hasCtx ? 1 : 0) - (hasProps ? 1 : 0);
        const argSlice: NrbfValue[] = [];
        for (let i = 0; i < argCount; i++) {
          const idx = i;
          const val = this.readReferenceableValue((v) => { arr[idx] = v; argSlice[idx] = v; });
          arr.push(val);
          argSlice.push(val);
        }
        result.args = argSlice;
        if (hasCtx) {
          const ctxIdx = arr.length;
          const ctx = this.readReferenceableValue((v) => { arr[ctxIdx] = v; result.callContext = v as string | NrbfObject; });
          arr.push(ctx);
          result.callContext = ctx as string | NrbfObject;
        }
        if (hasProps) {
          const propsIdx = arr.length;
          const val = this.readReferenceableValue((v) => { arr[propsIdx] = v; if (Array.isArray(v)) result.messageProperties = v; });
          arr.push(val);
          if (Array.isArray(val)) result.messageProperties = val;
        }
      } else if (messageEnum & MessageFlags.ArgsInArray) {
        // Element 0 is the nested args sub-array.
        {
          const idx = 0;
          const val = this.readReferenceableValue((v) => {
            arr[idx] = v;
            if (Array.isArray(v)) result.args = v;
          });
          arr.push(val);
          if (Array.isArray(val)) result.args = val;
        }
        // Element 1 (if ContextInArray) is the call context object.
        if (messageEnum & MessageFlags.ContextInArray) {
          const ctxIdx = arr.length;
          const ctx = this.readReferenceableValue((v) => { arr[ctxIdx] = v; result.callContext = v as string | NrbfObject; });
          arr.push(ctx);
          result.callContext = ctx as string | NrbfObject;
        }
        if (messageEnum & MessageFlags.PropertiesInArray) {
          const propsIdx = arr.length;
          const val = this.readReferenceableValue((v) => { arr[propsIdx] = v; if (Array.isArray(v)) result.messageProperties = v; });
          arr.push(val);
          if (Array.isArray(val)) result.messageProperties = val;
        }
        while (arr.length < length) {
          const idx = arr.length;
          arr.push(this.readReferenceableValue((v) => { arr[idx] = v; }));
        }
      } else {
        // ContextInArray (and/or PropertiesInArray) with no arg flags set.
        if (messageEnum & MessageFlags.ContextInArray) {
          const ctxIdx = arr.length;
          const ctx = this.readReferenceableValue((v) => { arr[ctxIdx] = v; result.callContext = v as string | NrbfObject; });
          arr.push(ctx);
          result.callContext = ctx as string | NrbfObject;
        }
        if (messageEnum & MessageFlags.PropertiesInArray) {
          const propsIdx = arr.length;
          const val = this.readReferenceableValue((v) => { arr[propsIdx] = v; if (Array.isArray(v)) result.messageProperties = v; });
          arr.push(val);
          if (Array.isArray(val)) result.messageProperties = val;
        }
        while (arr.length < length) {
          const idx = arr.length;
          arr.push(this.readReferenceableValue((v) => { arr[idx] = v; }));
        }
      }
    } else {
      // MethodReturn: items in order per §2.2.3.4 — ReturnValue, OutputArguments, Exception, CallContext, Properties.
      if (messageEnum & MessageFlags.ReturnValueInArray) {
        const idx = arr.length;
        const val = this.readReferenceableValue((v) => { arr[idx] = v; result.returnValue = v; });
        arr.push(val);
        result.returnValue = val;
      }
      if (messageEnum & MessageFlags.ArgsInArray) {
        const idx = arr.length;
        const val = this.readReferenceableValue((v) => {
          arr[idx] = v;
          if (Array.isArray(v)) result.args = v;
        });
        arr.push(val);
        if (Array.isArray(val)) result.args = val;
      }
      if (messageEnum & MessageFlags.ExceptionInArray) {
        const idx = arr.length;
        const val = this.readReferenceableValue((v) => { arr[idx] = v; result.exception = v as NrbfObject; });
        arr.push(val);
        result.exception = val as NrbfObject;
      }
      if (messageEnum & MessageFlags.ContextInArray) {
        const ctxIdx = arr.length;
        const ctx = this.readReferenceableValue((v) => { arr[ctxIdx] = v; result.callContext = v as string | NrbfObject; });
        arr.push(ctx);
        result.callContext = ctx as string | NrbfObject;
      }
      if (messageEnum & MessageFlags.PropertiesInArray) {
        const propsIdx = arr.length;
        const val = this.readReferenceableValue((v) => { arr[propsIdx] = v; if (Array.isArray(v)) result.messageProperties = v; });
        arr.push(val);
        if (Array.isArray(val)) result.messageProperties = val;
      }
      // Consume remaining elements (unsupported flags like GenericMethod).
      while (arr.length < length) {
        const idx = arr.length;
        arr.push(this.readReferenceableValue((v) => { arr[idx] = v; }));
      }
    }
  }

  // §2.2.2.2 — PrimitiveTypeEnum(18) + LengthPrefixedString
  private readStringValueWithCode(): string {
    this.r.readByte(); // PrimitiveTypeEnum — should be String(18)
    return this.r.readLengthPrefixedString();
  }

  // §2.2.2.1 — PrimitiveTypeEnum + optional value (absent when Null)
  private readValueWithCode(): NrbfValue {
    const primitiveType = this.r.readByte() as PrimitiveTypeEnumeration;
    if (primitiveType === PrimitiveTypeEnumeration.Null) return null;
    return this.r.readPrimitive(primitiveType);
  }

  // §2.2.2.3 — INT32 count + count × ValueWithCode
  private readArrayOfValueWithCode(): NrbfValue[] {
    const count = this.r.readInt32();
    const arr: NrbfValue[] = [];
    for (let i = 0; i < count; i++) arr.push(this.readValueWithCode());
    return arr;
  }
}

export function deserialize(buf: Buffer): NrbfRoot {
  return new Deserializer(buf).run();
}
