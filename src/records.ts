import {
  BinaryArrayTypeEnumeration,
  MessageFlags,
  PrimitiveTypeEnumeration,
  RecordTypeEnumeration,
} from './enums.js';
import {
  ArrayInfo,
  ArrayOfValueWithCode,
  ClassInfo,
  MemberTypeEntry,
  MemberTypeInfo,
  PrimitiveValue,
  StringValueWithCode,
  ValueWithCode,
} from './types.js';

// §2.6.1 — MUST be first record in every serialization stream
export interface SerializationHeaderRecord {
  type: RecordTypeEnumeration.SerializedStreamHeader;
  rootId: number;
  headerId: number;
  majorVersion: number;
  minorVersion: number;
}

// §2.6.2
export interface BinaryLibrary {
  type: RecordTypeEnumeration.BinaryLibrary;
  libraryId: number;
  libraryName: string;
}

// §2.6.3 — single RecordTypeEnum byte, no payload
export interface MessageEnd {
  type: RecordTypeEnumeration.MessageEnd;
}

// §2.3.2.1 — most verbose class record; includes member type info and library reference
export interface ClassWithMembersAndTypes {
  type: RecordTypeEnumeration.ClassWithMembersAndTypes;
  classInfo: ClassInfo;
  memberTypeInfo: MemberTypeInfo;
  libraryId: number;
}

// §2.3.2.2 — omits member type info; type info must be inferred from context
export interface ClassWithMembers {
  type: RecordTypeEnumeration.ClassWithMembers;
  classInfo: ClassInfo;
  libraryId: number;
}

// §2.3.2.3 — like ClassWithMembersAndTypes but implicitly in the System Library
export interface SystemClassWithMembersAndTypes {
  type: RecordTypeEnumeration.SystemClassWithMembersAndTypes;
  classInfo: ClassInfo;
  memberTypeInfo: MemberTypeInfo;
}

// §2.3.2.4 — no type info, no library; System Library class only
export interface SystemClassWithMembers {
  type: RecordTypeEnumeration.SystemClassWithMembers;
  classInfo: ClassInfo;
}

// §2.3.2.5 — no metadata; references a prior class record by metadataId
export interface ClassWithId {
  type: RecordTypeEnumeration.ClassWithId;
  objectId: number;
  metadataId: number;
}

// §2.4.3.1 — general array; lowerBounds present only for *Offset binaryArrayTypeEnum values
export interface BinaryArray {
  type: RecordTypeEnumeration.BinaryArray;
  objectId: number;
  binaryArrayTypeEnum: BinaryArrayTypeEnumeration;
  rank: number;
  lengths: number[];
  lowerBounds?: number[];
  itemTypeInfo: MemberTypeEntry;
}

// §2.4.3.2 — single-dimensional array, items may be any type
export interface ArraySingleObject {
  type: RecordTypeEnumeration.ArraySingleObject;
  arrayInfo: ArrayInfo;
}

// §2.4.3.3 — single-dimensional array of a single primitive type
export interface ArraySinglePrimitive {
  type: RecordTypeEnumeration.ArraySinglePrimitive;
  arrayInfo: ArrayInfo;
  primitiveTypeEnum: PrimitiveTypeEnumeration;
}

// §2.4.3.4 — single-dimensional array of strings
export interface ArraySingleString {
  type: RecordTypeEnumeration.ArraySingleString;
  arrayInfo: ArrayInfo;
}

// §2.5.1 — typed primitive value (not String)
export interface MemberPrimitiveTyped {
  type: RecordTypeEnumeration.MemberPrimitiveTyped;
  primitiveTypeEnum: PrimitiveTypeEnumeration;
  value: PrimitiveValue;
}

// §2.5.3 — forward or back reference to another record by object ID
export interface MemberReference {
  type: RecordTypeEnumeration.MemberReference;
  idRef: number;
}

// §2.5.4 — single null object
export interface ObjectNull {
  type: RecordTypeEnumeration.ObjectNull;
}

// §2.5.5 — compact run of nulls when count fits in one byte (0–255)
export interface ObjectNullMultiple256 {
  type: RecordTypeEnumeration.ObjectNullMultiple256;
  nullCount: number;
}

// §2.5.6 — compact run of nulls, INT32 count
export interface ObjectNullMultiple {
  type: RecordTypeEnumeration.ObjectNullMultiple;
  nullCount: number;
}

// §2.5.7 — string object with its own object ID (can be referenced)
export interface BinaryObjectString {
  type: RecordTypeEnumeration.BinaryObjectString;
  objectId: number;
  value: string;
}

// §2.2.3.1 — callContext and args present only when the corresponding MessageFlags bits are set
export interface BinaryMethodCall {
  type: RecordTypeEnumeration.MethodCall;
  messageEnum: MessageFlags;
  methodName: StringValueWithCode;
  typeName: StringValueWithCode;
  callContext?: StringValueWithCode;
  args?: ArrayOfValueWithCode;
}

// §2.2.3.3 — returnValue, callContext, and args are each conditional on MessageFlags bits
export interface BinaryMethodReturn {
  type: RecordTypeEnumeration.MethodReturn;
  messageEnum: MessageFlags;
  returnValue?: ValueWithCode;
  callContext?: StringValueWithCode;
  args?: ArrayOfValueWithCode;
}

export type NrbfRecord =
  | SerializationHeaderRecord
  | BinaryLibrary
  | MessageEnd
  | ClassWithMembersAndTypes
  | ClassWithMembers
  | SystemClassWithMembersAndTypes
  | SystemClassWithMembers
  | ClassWithId
  | BinaryArray
  | ArraySingleObject
  | ArraySinglePrimitive
  | ArraySingleString
  | MemberPrimitiveTyped
  | MemberReference
  | ObjectNull
  | ObjectNullMultiple256
  | ObjectNullMultiple
  | BinaryObjectString
  | BinaryMethodCall
  | BinaryMethodReturn;
