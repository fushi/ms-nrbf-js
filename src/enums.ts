export const BINARY_TYPE_ENUM = {
  Primitive: 0,
  String: 1,
  Object: 2,
  SystemClass: 3,
  Class: 4,
  ObjectArray: 5,
  StringArray: 6,
  PrimitiveArray: 7
}

export const PRIMITIVE_TYPE_ENUM = {
  Boolean: 1,
  Byte: 2,
  Char: 3,
  Decimal: 5,
  Double: 6,
  Int16: 7,
  Int32: 8,
  Int64: 9,
  SByte: 10,
  Single: 11,
  TimeSpan: 12,
  DateTime: 13,
  UInt16: 14,
  UInt32: 15,
  UInt64: 16,
  Null: 17,
  String: 18
}

export const RECORD_TYPE_ENUM = {
  SerializedStreamHeader: 0,
  ClassWithId: 1,
  SystemClassWithMembers: 2,
  ClassWithMembers: 3,
  SystemClassWithMembersAndTypes: 4,
  ClassWithMembersAndTypes: 5,
  BinaryObjectString: 6,
  BinaryArray: 7,
  MemberPrimitiveTyped: 8,
  MemberReference: 9,
  ObjectNull: 10,
  MessageEnd: 11,
  BinaryLibrary: 12,
  ObjectNullMultiple256: 13,
  ObjectNullMultiple: 14,
  ArraySinglePrimitive: 15,
  ArraySingleObject: 16,
  ArraySingleString: 17,
  MethodCall: 21,
  MethodReturn: 22
}
