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
  NrbfArray,
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
      case RecordTypeEnumeration.ClassWithMembersAndTypes:         return this.readClassRecord(true, false);
      case RecordTypeEnumeration.SystemClassWithMembersAndTypes:   return this.readClassRecord(true, true);
      case RecordTypeEnumeration.ClassWithMembers:                 return this.readClassRecord(false, false);
      case RecordTypeEnumeration.SystemClassWithMembers:           return this.readClassRecord(false, true);
      case RecordTypeEnumeration.ClassWithId:              return this.readClassWithId();
      case RecordTypeEnumeration.BinaryArray:              return this.readBinaryArray();
      case RecordTypeEnumeration.ArraySinglePrimitive:     return this.readArraySinglePrimitive();
      case RecordTypeEnumeration.ArraySingleObject:        return this.readArraySingleGeneric();
      case RecordTypeEnumeration.ArraySingleString:        return this.readArraySingleGeneric();
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

  // Like readReferenceableValue but also returns the PrimitiveTypeEnumeration when the record is
  // MemberPrimitiveTyped. Used when reading call array args so argTypes can be populated.
  private readReferenceableValueWithType(
    onForwardRef: (v: NrbfValue) => void,
  ): [NrbfValue, PrimitiveTypeEnumeration | undefined] {
    const tag = this.r.readByte() as RecordTypeEnumeration;
    if (tag === RecordTypeEnumeration.MemberReference) {
      const idRef = this.r.readInt32();
      const existing = this.objects.get(idRef);
      if (existing !== undefined) return [existing, undefined];
      this.fixups.push({ set: onForwardRef, idRef });
      return [null, undefined];
    }
    if (tag === RecordTypeEnumeration.MemberPrimitiveTyped) {
      const type = this.r.readByte() as PrimitiveTypeEnumeration;
      return [this.r.readPrimitive(type), type];
    }
    return [this.readRecord(tag), undefined];
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

  private resolveLibraryName(libraryId: number): string {
    const name = this.libraries.get(libraryId);
    /* v8 ignore next -- BinaryLibrary must precede any class that references its id; missing means a malformed stream */
    if (name === undefined) throw new Error(`Unknown libraryId=${libraryId}`);
    return name;
  }

  // -------------------------------------------------------------------------
  // Class records
  // -------------------------------------------------------------------------

  private readClassRecord(hasTypes: boolean, isSystem: boolean): NrbfObject {
    const classInfo = this.readClassInfo();
    const memberTypeInfo = hasTypes ? this.readMemberTypeInfo(classInfo.memberNames.length) : undefined;
    const libraryId = isSystem ? undefined : this.r.readInt32();
    const nameKey = isSystem ? classInfo.name : `${classInfo.name}@${libraryId}`;
    this.storeClassMeta({ classInfo, ...(memberTypeInfo !== undefined && { memberTypeInfo }), ...(libraryId !== undefined && { libraryId }) }, nameKey);

    const obj: NrbfObject = { typeName: classInfo.name, members: {} };
    if (libraryId !== undefined) obj.libraryName = this.resolveLibraryName(libraryId);
    if (memberTypeInfo !== undefined) {
      const memberTypes = this.extractMemberTypes(classInfo, memberTypeInfo);
      if (memberTypes !== undefined) obj.memberTypes = memberTypes;
    }
    this.objects.set(classInfo.objectId, obj);
    obj.members = memberTypeInfo !== undefined
      ? this.readMembers(classInfo, memberTypeInfo)
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
      obj.libraryName = this.resolveLibraryName(meta.libraryId);
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

  private initArray(): { objectId: number; length: number; arr: NrbfValue[] } {
    const objectId = this.r.readInt32();
    const length = this.r.readInt32();
    const arr: NrbfValue[] = [];
    this.objects.set(objectId, arr);
    return { objectId, length, arr };
  }

  private readArraySinglePrimitive(): NrbfValue[] {
    const { length, arr } = this.initArray();
    const primitiveType = this.r.readByte() as PrimitiveTypeEnumeration;
    this.fillArrayElements(arr, length, primitiveType);
    return arr;
  }

  private readArraySingleGeneric(): NrbfValue[] {
    const { length, arr } = this.initArray();
    this.readArrayElements(arr, length);
    return arr;
  }

  private readBinaryArray(): NrbfValue {
    const objectId = this.r.readInt32();
    const arrayTypeEnum = this.r.readByte() as BinaryArrayTypeEnumeration;
    const rank = this.r.readInt32();
    const lengths: number[] = [];
    for (let i = 0; i < rank; i++) lengths.push(this.r.readInt32());

    const hasLowerBounds =
      arrayTypeEnum === BinaryArrayTypeEnumeration.SingleOffset ||
      arrayTypeEnum === BinaryArrayTypeEnumeration.JaggedOffset ||
      arrayTypeEnum === BinaryArrayTypeEnumeration.RectangularOffset;
    const lowerBounds: number[] = [];
    if (hasLowerBounds) for (let i = 0; i < rank; i++) lowerBounds.push(this.r.readInt32());

    const typeEnum = this.r.readByte() as BinaryTypeEnumeration;
    let primitiveType: PrimitiveTypeEnumeration | undefined;
    let elementClassName: string | undefined;
    let elementLibraryName: string | undefined;
    switch (typeEnum) {
      case BinaryTypeEnumeration.Primitive:
      case BinaryTypeEnumeration.PrimitiveArray:
        primitiveType = this.r.readByte() as PrimitiveTypeEnumeration;
        break;
      case BinaryTypeEnumeration.SystemClass:
        elementClassName = this.r.readLengthPrefixedString();
        break;
      case BinaryTypeEnumeration.Class: {
        elementClassName = this.r.readLengthPrefixedString();
        const libraryId = this.r.readInt32();
        elementLibraryName = this.libraries.get(libraryId);
        break;
      }
    }

    const totalElements = lengths.reduce((a, b) => a * b, 1);

    // BinaryArray(Single) with no offset keeps the existing NrbfValue[] representation.
    if (arrayTypeEnum === BinaryArrayTypeEnumeration.Single) {
      const arr: NrbfValue[] = [];
      this.objects.set(objectId, arr);
      this.fillArrayElements(arr, totalElements, primitiveType);
      return arr;
    }

    // All other variants (Jagged, Rectangular, *Offset) return NrbfArray.
    const elements: NrbfValue[] = [];
    const nrbfArr: NrbfArray = {
      arrayType: arrayTypeEnum,
      lengths,
      ...(hasLowerBounds ? { lowerBounds } : {}),
      elementBinaryType: typeEnum,
      ...(primitiveType !== undefined ? { elementPrimitiveType: primitiveType } : {}),
      ...(elementClassName !== undefined ? { elementClassName } : {}),
      ...(elementLibraryName !== undefined ? { elementLibraryName } : {}),
      elements,
    };
    this.objects.set(objectId, nrbfArr);
    this.fillArrayElements(elements, totalElements, primitiveType);
    return nrbfArr;
  }

  private fillArrayElements(target: NrbfValue[], count: number, primitiveType: PrimitiveTypeEnumeration | undefined): void {
    if (primitiveType !== undefined) {
      for (let i = 0; i < count; i++) target.push(this.r.readPrimitive(primitiveType));
    } else {
      this.readArrayElements(target, count);
    }
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

  private readInlineArgsAndContext(
    messageEnum: number,
    result: NrbfMethodCall | NrbfMethodReturn,
  ): void {
    if (messageEnum & MessageFlags.ContextInline) result.callContext = this.readStringValueWithCode();
    if (messageEnum & MessageFlags.ArgsInline) {
      const [values, types] = this.readArrayOfValueWithCodeTyped();
      result.args = values;
      result.argTypes = types;
    }
  }

  private readBinaryMethodCall(): NrbfMethodCall {
    const messageEnum = this.r.readInt32();
    const methodName = this.readStringValueWithCode();
    const typeName = this.readStringValueWithCode();

    const result: NrbfMethodCall = { kind: "MethodCall", methodName, typeName };
    this.readInlineArgsAndContext(messageEnum, result);
    if (!(messageEnum & MessageFlags.ArgsInline) && (
      (messageEnum & MessageFlags.ArgsIsArray) ||
      (messageEnum & MessageFlags.ArgsInArray) ||
      (messageEnum & MessageFlags.ContextInArray) ||
      (messageEnum & MessageFlags.GenericMethod) ||
      (messageEnum & MessageFlags.MethodSignatureInArray) ||
      (messageEnum & MessageFlags.PropertiesInArray)
    )) {
      this.readCallArray(messageEnum, result);
    }
    return result;
  }

  private readBinaryMethodReturn(): NrbfMethodReturn {
    const messageEnum = this.r.readInt32();
    const result: NrbfMethodReturn = { kind: "MethodReturn" };
    if (messageEnum & MessageFlags.ReturnValueInline) {
      const [value, type] = this.readValueWithCodeAndType();
      result.returnValue = value;
      result.returnType = type;
    }
    if (messageEnum & MessageFlags.NoReturnValue) result.returnValue = null;
    this.readInlineArgsAndContext(messageEnum, result);
    if (!(messageEnum & MessageFlags.ArgsInline) && (
      (messageEnum & MessageFlags.ReturnValueInArray) ||
      (messageEnum & MessageFlags.ArgsInArray) ||
      (messageEnum & MessageFlags.ExceptionInArray) ||
      (messageEnum & MessageFlags.ContextInArray) ||
      (messageEnum & MessageFlags.PropertiesInArray)
    )) {
      this.readCallArray(messageEnum, result);
    }
    return result;
  }

  // §2.2.3.2 / §2.2.3.4 — reads the ArraySingleObject that immediately follows a method record
  // when ArgsIsArray, ArgsInArray, or ReturnValueInArray flags are set.
  private readArgsInArray(arr: NrbfValue[], result: NrbfMethodCall | NrbfMethodReturn): void {
    const idx = arr.length;
    const val = this.readReferenceableValue((v) => {
      arr[idx] = v;
      /* v8 ignore next -- valid NRBF guarantees an array here; non-array means a malformed stream */
      if (!Array.isArray(v)) throw new Error(`Expected array at args, got ${typeof v}`);
      result.args = v;
    });
    arr.push(val);
    if (Array.isArray(val)) result.args = val;
  }

  private drainCallArray(arr: NrbfValue[], length: number): void {
    while (arr.length < length) {
      const idx = arr.length;
      arr.push(this.readReferenceableValue((v) => { arr[idx] = v; }));
    }
  }

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

    const { length, arr } = this.initArray();

    if (result.kind === "MethodCall") {
      if (messageEnum & MessageFlags.ArgsIsArray) {
        // With ArgsIsArray, each arg is a direct element. Order per §2.2.3.2:
        // args (direct), GenericMethod, MethodSignature, CallContext, MessageProperties.
        const hasCtx = !!(messageEnum & MessageFlags.ContextInArray);
        const hasProps = !!(messageEnum & MessageFlags.PropertiesInArray);
        const hasSig = !!(messageEnum & MessageFlags.MethodSignatureInArray);
        const hasGeneric = !!(messageEnum & MessageFlags.GenericMethod);
        const argCount = length - (hasGeneric ? 1 : 0) - (hasSig ? 1 : 0) - (hasCtx ? 1 : 0) - (hasProps ? 1 : 0);
        const argSlice: NrbfValue[] = [];
        const argTypeSlice: (PrimitiveTypeEnumeration | undefined)[] = [];
        let hasArgType = false;
        for (let i = 0; i < argCount; i++) {
          const idx = i;
          const [val, type] = this.readReferenceableValueWithType((v) => { arr[idx] = v; argSlice[idx] = v; });
          arr.push(val);
          argSlice.push(val);
          argTypeSlice.push(type);
          if (type !== undefined) hasArgType = true;
        }
        result.args = argSlice;
        if (hasArgType) result.argTypes = argTypeSlice;
        this.readOptionalArrayValue(messageEnum, MessageFlags.GenericMethod, arr, (v) => { result.genericTypeArguments = v; }, "genericTypeArguments");
        this.readOptionalArrayValue(messageEnum, MessageFlags.MethodSignatureInArray, arr, (v) => { result.methodSignature = v; }, "methodSignature");
        this.readOptionalCallContext(messageEnum, arr, result);
        this.readOptionalArrayValue(messageEnum, MessageFlags.PropertiesInArray, arr, (v) => { result.messageProperties = v; }, "messageProperties");
      } else {
        // ArgsInArray: element 0 is the nested args sub-array. Otherwise: no arg flags set.
        // Order per §2.2.3.2: ArgsInArray, GenericMethod, MethodSignature, CallContext, MessageProperties.
        if (messageEnum & MessageFlags.ArgsInArray) this.readArgsInArray(arr, result);
        this.readOptionalArrayValue(messageEnum, MessageFlags.GenericMethod, arr, (v) => { result.genericTypeArguments = v; }, "genericTypeArguments");
        this.readOptionalArrayValue(messageEnum, MessageFlags.MethodSignatureInArray, arr, (v) => { result.methodSignature = v; }, "methodSignature");
        this.readOptionalCallContext(messageEnum, arr, result);
        this.readOptionalArrayValue(messageEnum, MessageFlags.PropertiesInArray, arr, (v) => { result.messageProperties = v; }, "messageProperties");
        this.drainCallArray(arr, length);
      }
    } else {
      // MethodReturn: items in order per §2.2.3.4 — ReturnValue, OutputArguments, Exception, CallContext, Properties.
      if (messageEnum & MessageFlags.ReturnValueInArray) {
        const idx = arr.length;
        const val = this.readReferenceableValue((v) => { arr[idx] = v; result.returnValue = v; });
        arr.push(val);
        result.returnValue = val;
      }
      if (messageEnum & MessageFlags.ArgsInArray) this.readArgsInArray(arr, result);
      if (messageEnum & MessageFlags.ExceptionInArray) {
        const idx = arr.length;
        const val = this.readReferenceableValue((v) => { arr[idx] = v; result.exception = v as NrbfObject; });
        arr.push(val);
        result.exception = val as NrbfObject;
      }
      this.readOptionalCallContext(messageEnum, arr, result);
      this.readOptionalArrayValue(messageEnum, MessageFlags.PropertiesInArray, arr, (v) => { result.messageProperties = v; }, "messageProperties");
      this.drainCallArray(arr, length);
    }
  }

  private readOptionalArrayValue(
    messageEnum: number,
    flag: MessageFlags,
    arr: NrbfValue[],
    set: (v: NrbfValue[]) => void,
    label: string,
  ): void {
    if (!(messageEnum & flag)) return;
    const idx = arr.length;
    const val = this.readReferenceableValue((v) => {
      arr[idx] = v;
      /* v8 ignore next -- valid NRBF guarantees an array here; non-array means a malformed stream */
      if (!Array.isArray(v)) throw new Error(`Expected array at ${label}, got ${typeof v}`);
      set(v);
    });
    arr.push(val);
    if (Array.isArray(val)) set(val);
  }

  private readOptionalCallContext(messageEnum: number, arr: NrbfValue[], result: NrbfMethodCall | NrbfMethodReturn): void {
    if (!(messageEnum & MessageFlags.ContextInArray)) return;
    const idx = arr.length;
    const ctx = this.readReferenceableValue((v) => { arr[idx] = v; result.callContext = v as string | NrbfObject; });
    arr.push(ctx);
    result.callContext = ctx as string | NrbfObject;
  }

  // §2.2.2.2 — PrimitiveTypeEnum(18) + LengthPrefixedString
  private readStringValueWithCode(): string {
    this.r.readByte(); // PrimitiveTypeEnum — should be String(18)
    return this.r.readLengthPrefixedString();
  }

  // §2.2.2.1 — PrimitiveTypeEnum + optional value (absent when Null)
  private readValueWithCodeAndType(): [NrbfValue, PrimitiveTypeEnumeration] {
    const type = this.r.readByte() as PrimitiveTypeEnumeration;
    return [type === PrimitiveTypeEnumeration.Null ? null : this.r.readPrimitive(type), type];
  }

  // §2.2.2.3 — INT32 count + count × ValueWithCode
  private readArrayOfValueWithCodeTyped(): [NrbfValue[], PrimitiveTypeEnumeration[]] {
    const count = this.r.readInt32();
    const values: NrbfValue[] = [];
    const types: PrimitiveTypeEnumeration[] = [];
    for (let i = 0; i < count; i++) {
      const [v, t] = this.readValueWithCodeAndType();
      values.push(v);
      types.push(t);
    }
    return [values, types];
  }
}

export function deserialize(buf: Buffer): NrbfRoot {
  return new Deserializer(buf).run();
}
