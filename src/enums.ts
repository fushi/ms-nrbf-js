// §2.1.2.1
export enum RecordTypeEnumeration {
  SerializedStreamHeader         = 0,
  ClassWithId                    = 1,
  SystemClassWithMembers         = 2,
  ClassWithMembers               = 3,
  SystemClassWithMembersAndTypes = 4,
  ClassWithMembersAndTypes       = 5,
  BinaryObjectString             = 6,
  BinaryArray                    = 7,
  MemberPrimitiveTyped           = 8,
  MemberReference                = 9,
  ObjectNull                     = 10,
  MessageEnd                     = 11,
  BinaryLibrary                  = 12,
  ObjectNullMultiple256          = 13,
  ObjectNullMultiple             = 14,
  ArraySinglePrimitive           = 15,
  ArraySingleObject              = 16,
  ArraySingleString              = 17,
  MethodCall                     = 21,
  MethodReturn                   = 22,
}

// §2.1.2.2
export enum BinaryTypeEnumeration {
  Primitive      = 0,
  String         = 1,
  Object         = 2,
  SystemClass    = 3,
  Class          = 4,
  ObjectArray    = 5,
  StringArray    = 6,
  PrimitiveArray = 7,
}

// §2.1.2.3 — value 4 is unused in the protocol
export enum PrimitiveTypeEnumeration {
  Boolean  = 1,
  Byte     = 2,
  Char     = 3,
  Decimal  = 5,
  Double   = 6,
  Int16    = 7,
  Int32    = 8,
  Int64    = 9,
  SByte    = 10,
  Single   = 11,
  TimeSpan = 12,
  DateTime = 13,
  UInt16   = 14,
  UInt32   = 15,
  UInt64   = 16,
  Null     = 17,
  String   = 18,
}

// §2.4.1.1
export enum BinaryArrayTypeEnumeration {
  Single            = 0,
  Jagged            = 1,
  Rectangular       = 2,
  SingleOffset      = 3,
  JaggedOffset      = 4,
  RectangularOffset = 5,
}

// §2.2.1.1 — flags enum, INT32
export enum MessageFlags {
  NoArgs                 = 0x00000001,
  ArgsInline             = 0x00000002,
  ArgsIsArray            = 0x00000004,
  ArgsInArray            = 0x00000008,
  NoContext              = 0x00000010,
  ContextInline          = 0x00000020,
  ContextInArray         = 0x00000040,
  MethodSignatureInArray = 0x00000080,
  PropertiesInArray      = 0x00000100,
  NoReturnValue          = 0x00000200,
  ReturnValueVoid        = 0x00000400,
  ReturnValueInline      = 0x00000800,
  ReturnValueInArray     = 0x00001000,
  ExceptionInArray       = 0x00002000,
  GenericMethod          = 0x00008000,
}
