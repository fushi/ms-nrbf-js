export { deserialize } from './deserialize.js';
export { serialize } from './serialize.js';

export { BinaryArrayTypeEnumeration, BinaryTypeEnumeration, PrimitiveTypeEnumeration } from './enums.js';

export { DateTimeKind, isDateTime, isNrbfArray, isNrbfMethodCall, isNrbfMethodReturn, isNrbfObject } from './types.js';
export type {
  DateTime,
  PrimitiveValue,
  NrbfObject,
  NrbfArray,
  NrbfValue,
  NrbfMethodCall,
  NrbfMethodReturn,
  NrbfRoot,
} from './types.js';
