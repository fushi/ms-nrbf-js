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

// Public output types for the deserializer / input types for the serializer
export interface NrbfObject {
  typeName: string;
  libraryName?: string; // absent for system-library classes
  // Primitive type for each Primitive- or PrimitiveArray-typed member (element type for arrays).
  // Populated by the deserializer; used by the serializer to avoid type inference errors.
  memberTypes?: { [name: string]: PrimitiveTypeEnumeration };
  members: { [name: string]: NrbfValue };
}

export type NrbfValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | DateTime
  | NrbfObject
  | NrbfValue[];

// §2.4.2.1
export interface ArrayInfo {
  objectId: number;
  length: number;
}

// Method invocation stream roots (not values — only appear as the stream root)
export interface NrbfMethodCall {
  kind: "MethodCall";
  methodName: string;
  typeName: string;
  callContext?: string | NrbfObject;
  args?: NrbfValue[];
  // Primitive type per arg — preserves types JS cannot distinguish (Single vs Double, Char vs
  // String, UInt32 vs Int32). Populated by the deserializer; used by the serializer when present.
  // undefined entries mean "infer from value" (present when ArgsIsArray has mixed primitive/object args).
  argTypes?: (PrimitiveTypeEnumeration | undefined)[];
  genericTypeArguments?: NrbfValue[];
  methodSignature?: NrbfValue[];
  messageProperties?: NrbfValue[];
}

export interface NrbfMethodReturn {
  kind: "MethodReturn";
  returnValue?: NrbfValue;
  // Primitive type for an inline (ReturnValueInline) return value. Same purpose as argTypes.
  returnType?: PrimitiveTypeEnumeration;
  exception?: NrbfObject;
  callContext?: string | NrbfObject;
  args?: NrbfValue[];
  // Primitive type per output arg — same semantics as argTypes on NrbfMethodCall.
  argTypes?: (PrimitiveTypeEnumeration | undefined)[];
  messageProperties?: NrbfValue[];
}

// Top-level return type of deserialize()
export type NrbfRoot = NrbfValue | NrbfMethodCall | NrbfMethodReturn;

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
