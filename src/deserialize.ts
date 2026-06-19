import {
  BinaryArrayTypeEnumeration,
  BinaryTypeEnumeration,
  PrimitiveTypeEnumeration,
  RecordTypeEnumeration,
} from "./enums.js";
import { BinaryReader } from "./reader.js";
import {
  ClassInfo,
  MemberTypeEntry,
  MemberTypeInfo,
  NrbfObject,
  NrbfValue,
} from "./types.js";

interface ClassMeta {
  classInfo: ClassInfo;
  memberTypeInfo?: MemberTypeInfo; // absent for ClassWithMembers / SystemClassWithMembers
  libraryId?: number;              // absent for system classes
}

class Deserializer {
  private readonly r: BinaryReader;
  private readonly objects = new Map<number, NrbfValue>();
  private readonly classesByObjectId = new Map<number, ClassMeta>();
  // keyed by "typeName@libraryId" (or just typeName for system classes)
  private readonly classesByName = new Map<string, ClassMeta>();
  private readonly libraries = new Map<number, string>(); // libraryId → libraryName

  constructor(buf: Buffer) {
    this.r = new BinaryReader(buf);
  }

  run(): NrbfValue {
    const firstTag = this.r.readByte();
    if (firstTag !== RecordTypeEnumeration.SerializedStreamHeader) {
      throw new Error(
        `Expected SerializationHeaderRecord (0) as first byte, got ${firstTag}`,
      );
    }
    const rootId = this.r.readInt32();
    this.r.readInt32(); // headerId (ignored on read per spec)
    this.r.readInt32(); // majorVersion
    this.r.readInt32(); // minorVersion

    while (true) {
      const tag = this.r.readByte() as RecordTypeEnumeration;
      if (tag === RecordTypeEnumeration.MessageEnd) break;
      this.readRecord(tag);
    }

    const root = this.objects.get(rootId);
    if (root === undefined) {
      throw new Error(`Root object (objectId=${rootId}) not found in stream`);
    }
    return root;
  }

  // Dispatch on an already-consumed tag byte. Returns the deserialized value.
  private readRecord(tag: RecordTypeEnumeration): NrbfValue {
    switch (tag) {
      case RecordTypeEnumeration.BinaryLibrary:
        return this.readBinaryLibrary();
      case RecordTypeEnumeration.BinaryObjectString:
        return this.readBinaryObjectString();
      case RecordTypeEnumeration.ClassWithMembersAndTypes:
        return this.readClassWithMembersAndTypes();
      case RecordTypeEnumeration.SystemClassWithMembersAndTypes:
        return this.readSystemClassWithMembersAndTypes();
      case RecordTypeEnumeration.ClassWithMembers:
        return this.readClassWithMembers();
      case RecordTypeEnumeration.SystemClassWithMembers:
        return this.readSystemClassWithMembers();
      case RecordTypeEnumeration.ClassWithId:
        return this.readClassWithId();
      case RecordTypeEnumeration.BinaryArray:
        return this.readBinaryArray();
      case RecordTypeEnumeration.ArraySinglePrimitive:
        return this.readArraySinglePrimitive();
      case RecordTypeEnumeration.ArraySingleObject:
        return this.readArraySingleObject();
      case RecordTypeEnumeration.ArraySingleString:
        return this.readArraySingleString();
      case RecordTypeEnumeration.MemberReference:
        return this.readMemberReference();
      case RecordTypeEnumeration.MemberPrimitiveTyped:
        return this.readMemberPrimitiveTyped();
      case RecordTypeEnumeration.ObjectNull:
        return null;
      case RecordTypeEnumeration.ObjectNullMultiple256:
        this.r.readByte(); // nullCount — handled by caller in array context
        return null;
      case RecordTypeEnumeration.ObjectNullMultiple:
        this.r.readInt32();
        return null;
      default:
        throw new Error(`Unhandled record type: ${tag}`);
    }
  }

  // --- Scalar records ---

  private readBinaryLibrary(): null {
    const libraryId = this.r.readInt32();
    const libraryName = this.r.readLengthPrefixedString();
    this.libraries.set(libraryId, libraryName);
    return null;
  }

  private readBinaryObjectString(): string {
    const objectId = this.r.readInt32();
    const value = this.r.readLengthPrefixedString();
    this.objects.set(objectId, value);
    return value;
  }

  private readMemberPrimitiveTyped(): NrbfValue {
    const primitiveType = this.r.readByte() as PrimitiveTypeEnumeration;
    return this.r.readPrimitive(primitiveType);
  }

  private readMemberReference(): NrbfValue {
    const idRef = this.r.readInt32();
    const value = this.objects.get(idRef);
    if (value === undefined) {
      throw new Error(
        `MemberReference to unknown objectId=${idRef} (forward references are not supported)`,
      );
    }
    return value;
  }

  // --- ClassInfo + MemberTypeInfo wire parsing ---

  private readClassInfo(): ClassInfo {
    const objectId = this.r.readInt32();
    const name = this.r.readLengthPrefixedString();
    const memberCount = this.r.readInt32();
    const memberNames: string[] = [];
    for (let i = 0; i < memberCount; i++) {
      memberNames.push(this.r.readLengthPrefixedString());
    }
    return { objectId, name, memberNames };
  }

  private readMemberTypeInfo(count: number): MemberTypeInfo {
    // The spec encodes all BinaryTypeEnums first, then all AdditionalInfos.
    const binaryTypes: BinaryTypeEnumeration[] = [];
    for (let i = 0; i < count; i++) {
      binaryTypes.push(this.r.readByte() as BinaryTypeEnumeration);
    }

    const entries: MemberTypeEntry[] = [];
    for (const binaryType of binaryTypes) {
      switch (binaryType) {
        case BinaryTypeEnumeration.Primitive:
        case BinaryTypeEnumeration.PrimitiveArray:
          entries.push({
            binaryType,
            primitiveType: this.r.readByte() as PrimitiveTypeEnumeration,
          });
          break;
        case BinaryTypeEnumeration.SystemClass:
          entries.push({ binaryType, className: this.r.readLengthPrefixedString() });
          break;
        case BinaryTypeEnumeration.Class:
          entries.push({
            binaryType,
            classTypeInfo: {
              typeName: this.r.readLengthPrefixedString(),
              libraryId: this.r.readInt32(),
            },
          });
          break;
        default:
          entries.push({ binaryType } as MemberTypeEntry);
      }
    }
    return entries;
  }

  // --- Member value reading ---

  private readMemberValue(typeEntry: MemberTypeEntry): NrbfValue {
    if (typeEntry.binaryType === BinaryTypeEnumeration.Primitive) {
      // Primitive members are serialized as raw bytes with no record type prefix (§2.5.2)
      return this.r.readPrimitive(typeEntry.primitiveType);
    }
    const tag = this.r.readByte() as RecordTypeEnumeration;
    return this.readRecord(tag);
  }

  private readMembers(
    classInfo: ClassInfo,
    memberTypeInfo: MemberTypeInfo,
  ): Record<string, NrbfValue> {
    const members: Record<string, NrbfValue> = {};
    for (let i = 0; i < classInfo.memberNames.length; i++) {
      members[classInfo.memberNames[i]!] = this.readMemberValue(memberTypeInfo[i]!);
    }
    return members;
  }

  // Read members when no type info is available (ClassWithMembers / SystemClassWithMembers).
  // Falls back to reading each member as a full record; fails if any member is an inline primitive.
  private readMembersUntyped(classInfo: ClassInfo): Record<string, NrbfValue> {
    const members: Record<string, NrbfValue> = {};
    for (const name of classInfo.memberNames) {
      const tag = this.r.readByte() as RecordTypeEnumeration;
      members[name] = this.readRecord(tag);
    }
    return members;
  }

  private storeClassMeta(meta: ClassMeta, nameKey: string): void {
    this.classesByObjectId.set(meta.classInfo.objectId, meta);
    this.classesByName.set(nameKey, meta);
  }

  // --- Class records ---

  private readClassWithMembersAndTypes(): NrbfObject {
    const classInfo = this.readClassInfo();
    const memberTypeInfo = this.readMemberTypeInfo(classInfo.memberNames.length);
    const libraryId = this.r.readInt32();
    const meta: ClassMeta = { classInfo, memberTypeInfo, libraryId };
    this.storeClassMeta(meta, `${classInfo.name}@${libraryId}`);

    const obj: NrbfObject = { typeName: classInfo.name, members: {} };
    const libraryName = this.libraries.get(libraryId);
    if (libraryName !== undefined) obj.libraryName = libraryName;
    this.objects.set(classInfo.objectId, obj);
    obj.members = this.readMembers(classInfo, memberTypeInfo);
    return obj;
  }

  private readSystemClassWithMembersAndTypes(): NrbfObject {
    const classInfo = this.readClassInfo();
    const memberTypeInfo = this.readMemberTypeInfo(classInfo.memberNames.length);
    const meta: ClassMeta = { classInfo, memberTypeInfo };
    this.storeClassMeta(meta, classInfo.name);

    const obj: NrbfObject = { typeName: classInfo.name, members: {} };
    this.objects.set(classInfo.objectId, obj);
    obj.members = this.readMembers(classInfo, memberTypeInfo);
    return obj;
  }

  private readClassWithMembers(): NrbfObject {
    const classInfo = this.readClassInfo();
    const libraryId = this.r.readInt32();
    const meta: ClassMeta = { classInfo, libraryId };
    this.storeClassMeta(meta, `${classInfo.name}@${libraryId}`);

    const obj: NrbfObject = { typeName: classInfo.name, members: {} };
    this.objects.set(classInfo.objectId, obj);

    // Recover type info from a prior definition of the same class if available
    const knownMeta = this.classesByName.get(`${classInfo.name}@${libraryId}`);
    obj.members = knownMeta?.memberTypeInfo
      ? this.readMembers(classInfo, knownMeta.memberTypeInfo)
      : this.readMembersUntyped(classInfo);
    return obj;
  }

  private readSystemClassWithMembers(): NrbfObject {
    const classInfo = this.readClassInfo();
    const meta: ClassMeta = { classInfo };
    this.storeClassMeta(meta, classInfo.name);

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
    if (!meta) {
      throw new Error(`ClassWithId: no metadata found for metadataId=${metadataId}`);
    }

    const obj: NrbfObject = { typeName: meta.classInfo.name, members: {} };
    if (meta.libraryId !== undefined) {
      const libraryName = this.libraries.get(meta.libraryId);
      if (libraryName !== undefined) obj.libraryName = libraryName;
    }
    this.objects.set(objectId, obj);
    obj.members = meta.memberTypeInfo
      ? this.readMembers(meta.classInfo, meta.memberTypeInfo)
      : this.readMembersUntyped(meta.classInfo);
    return obj;
  }

  // --- Array records ---

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
    if (hasLowerBounds) {
      for (let i = 0; i < rank; i++) this.r.readInt32(); // lowerBounds (discarded)
    }

    const typeEnum = this.r.readByte() as BinaryTypeEnumeration;
    let primitiveType: PrimitiveTypeEnumeration | undefined;
    switch (typeEnum) {
      case BinaryTypeEnumeration.Primitive:
      case BinaryTypeEnumeration.PrimitiveArray:
        primitiveType = this.r.readByte() as PrimitiveTypeEnumeration;
        break;
      case BinaryTypeEnumeration.SystemClass:
        this.r.readLengthPrefixedString(); // className
        break;
      case BinaryTypeEnumeration.Class:
        this.r.readLengthPrefixedString(); // typeName
        this.r.readInt32(); // libraryId
        break;
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

  // Read `remaining` records into `arr`, handling ObjectNullMultiple* compression.
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
      } else {
        arr.push(this.readRecord(tag));
        remaining--;
      }
    }
  }
}

export function deserialize(buf: Buffer): NrbfValue {
  return new Deserializer(buf).run();
}
