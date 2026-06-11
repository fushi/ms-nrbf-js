import { BinaryTypeEnumeration, PrimitiveTypeEnumeration } from "./enums.js";

// §2.1.1.5 — 2-bit Kind field packed into the high bits of the DateTime INT64
export enum DateTimeKind {
  Unspecified = 0,
  Utc         = 1,
  Local       = 2,
}

export interface DateTime {
  ticks: bigint; // 62-bit signed, 100ns intervals since 0001-01-01T00:00:00
  kind: DateTimeKind;
}

// Deserialized representation of any PrimitiveTypeEnumeration value
export type PrimitiveValue =
  | boolean   // Boolean
  | number    // Byte, Double, Int16, Int32, SByte, Single, UInt16, UInt32
  | bigint    // Int64, UInt64, TimeSpan
  | string    // Char, Decimal, String
  | DateTime  // DateTime
  | null;     // Null

// §2.1.1.8
export interface ClassTypeInfo {
  typeName: string;
  libraryId: number;
}

// §2.3.1.1
export interface ClassInfo {
  objectId: number;
  name: string;
  memberNames: string[];
}

// §2.3.1.2 — the spec stores BinaryTypeEnums and AdditionalInfos as parallel arrays;
// we flatten them into a per-member discriminated union to avoid index-alignment errors.
export type MemberTypeEntry =
  | { binaryType: BinaryTypeEnumeration.Primitive;      primitiveType: PrimitiveTypeEnumeration }
  | { binaryType: BinaryTypeEnumeration.String }
  | { binaryType: BinaryTypeEnumeration.Object }
  | { binaryType: BinaryTypeEnumeration.SystemClass;    className: string }
  | { binaryType: BinaryTypeEnumeration.Class;          classTypeInfo: ClassTypeInfo }
  | { binaryType: BinaryTypeEnumeration.ObjectArray }
  | { binaryType: BinaryTypeEnumeration.StringArray }
  | { binaryType: BinaryTypeEnumeration.PrimitiveArray; primitiveType: PrimitiveTypeEnumeration };

export type MemberTypeInfo = MemberTypeEntry[];

// §2.4.2.1
export interface ArrayInfo {
  objectId: number;
  length: number;
}

// §2.2.2.1 — Value is absent when primitiveTypeEnum is Null
export type ValueWithCode =
  | { primitiveTypeEnum: PrimitiveTypeEnumeration.Null }
  | { primitiveTypeEnum: Exclude<PrimitiveTypeEnumeration, PrimitiveTypeEnumeration.Null>; value: PrimitiveValue };

// §2.2.2.2
export interface StringValueWithCode {
  value: string;
}

// §2.2.2.3
export interface ArrayOfValueWithCode {
  listOfValueWithCode: ValueWithCode[];
}
