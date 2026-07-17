import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deserialize } from './deserialize.js';
import { serialize } from './serialize.js';
import { BinaryArrayTypeEnumeration, BinaryTypeEnumeration, MessageFlags, PrimitiveTypeEnumeration, RecordTypeEnumeration } from './enums.js';
import type { DateTime, NrbfArray, NrbfMethodCall, NrbfMethodReturn, NrbfObject, NrbfValue } from './types.js';

const fixturesDir = join(fileURLToPath(import.meta.url), '..', '__fixtures__');

function roundTrip(value: NrbfValue): NrbfValue {
  return deserialize(serialize(value)) as NrbfValue;
}

describe('serialize', () => {
  describe('circular references', () => {
    it('handles mutual object references via MemberReference', () => {
      const nodeA: NrbfObject = { libraryName: 'Lib', members: { peer: null, value: 1 }, typeName: 'Node' };
      const nodeB: NrbfObject = { libraryName: 'Lib', members: { peer: nodeA, value: 2 }, typeName: 'Node' };
      nodeA.members['peer'] = nodeB;

      const result = deserialize(serialize(nodeA)) as NrbfObject;
      expect(result.members['value']).toBe(1);
      const peer = result.members['peer'] as NrbfObject;
      expect(peer.members['value']).toBe(2);
      // Back-reference resolves to the same deserialized object
      expect(peer.members['peer']).toBe(result);
    });

    it('handles self-reference', () => {
      const node: NrbfObject = { members: { self: null, value: 42 }, typeName: 'Node' };
      node.members['self'] = node;

      const result = deserialize(serialize(node)) as NrbfObject;
      expect(result.members['value']).toBe(42);
      expect(result.members['self']).toBe(result);
    });
  });

  it('throws for bare primitives as root', () => {
    expect(() => serialize(42)).toThrow(TypeError);
    expect(() => serialize(null)).toThrow(TypeError);
    expect(() => serialize(true)).toThrow(TypeError);
  });

  it('writeValue throws for an unrecognised object type (line 358 else branch)', () => {
    // A plain object that is not NrbfObject/NrbfArray/DateTime/array slips through
    // writeAnyValue's typeof==="object" gate and hits writeValue's defensive else.
    const root: NrbfObject = {
      members: { x: {} as unknown as NrbfValue },
      typeName: 'T',
    };
    expect(() => serialize(root)).toThrow(TypeError);
  });

  it('writeAnyValue throws when inferPrimitiveType returns undefined (line 427)', () => {
    // Symbol is not null, not string, not object, not bool/number/bigint/DateTime →
    // inferPrimitiveType returns undefined → throws at line 427.
    // A sibling NrbfObject arg makes hasComplexArgs=true, routing all args through
    // writeAnyValue (the call-array path) rather than writeValueWithCode (inline path).
    const call: NrbfMethodCall = {
      args: [
        { members: {}, typeName: 'X' } as NrbfObject,
        Symbol('x') as unknown as NrbfValue,
      ],
      kind: 'MethodCall',
      methodName: 'M',
      typeName: 'T',
    };
    expect(() => serialize(call)).toThrow(/cannot infer primitive type/);
  });

  it('inferValueWithCodeType throws when an arg is a plain object (line 76)', () => {
    // A plain object without typeName+members passes isNrbfObject=false → hasComplexArgs=false
    // → ArgsInline path → writeValueWithCode({}) → inferValueWithCodeType({}) throws.
    // The "array" message branch is structurally unreachable: any real JS array sets
    // hasComplexArgs=true before inferValueWithCodeType is ever called.
    const call: NrbfMethodCall = {
      args: [{} as unknown as NrbfValue],
      kind: 'MethodCall',
      methodName: 'M',
      typeName: 'T',
    };
    expect(() => serialize(call)).toThrow(/cannot encode object as ValueWithCode/);
  });

  describe('string root', () => {
    it('round-trips a string', () => {
      expect(roundTrip('hello')).toBe('hello');
    });

    it('round-trips an empty string', () => {
      expect(roundTrip('')).toBe('');
    });

    it('round-trips a UTF-8 string', () => {
      expect(roundTrip('héllo 🌍')).toBe('héllo 🌍');
    });
  });

  describe('ArraySinglePrimitive', () => {
    it('round-trips an Int32 array', () => {
      expect(roundTrip([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it('round-trips a Boolean array', () => {
      expect(roundTrip([true, false, true])).toEqual([true, false, true]);
    });

    it('round-trips an Int64 (bigint) array', () => {
      expect(roundTrip([1n, 2n, 9007199254740993n])).toEqual([1n, 2n, 9007199254740993n]);
    });

    it('round-trips an empty array', () => {
      expect(roundTrip([])).toEqual([]);
    });
  });

  describe('ArraySingleString', () => {
    it('round-trips a string array', () => {
      expect(roundTrip(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('round-trips a string array with nulls', () => {
      expect(roundTrip(['a', null, 'c'])).toEqual(['a', null, 'c']);
    });
  });

  describe('ArraySingleObject', () => {
    it('round-trips a mixed array', () => {
      expect(roundTrip([null, 'x', null])).toEqual([null, 'x', null]);
    });
  });

  describe('SystemClassWithMembersAndTypes', () => {
    it('round-trips a class with primitive members', () => {
      const obj: NrbfObject = { members: { x: 10, y: 20 }, typeName: 'Point' };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.typeName).toBe('Point');
      expect(result.members['x']).toBe(10);
      expect(result.members['y']).toBe(20);
    });

    it('round-trips a class with a string member', () => {
      const obj: NrbfObject = { members: { age: 30, name: 'Alice' }, typeName: 'Person' };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members['name']).toBe('Alice');
      expect(result.members['age']).toBe(30);
    });

    it('round-trips a class with a null member', () => {
      const obj: NrbfObject = { members: { value: null }, typeName: 'Container' };
      expect((roundTrip(obj) as NrbfObject).members['value']).toBeNull();
    });

    it('round-trips a class with a Double member', () => {
      const obj: NrbfObject = { members: { count: 7, ratio: 3.14 }, typeName: 'Stats' };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members['ratio']).toBeCloseTo(3.14);
      expect(result.members['count']).toBe(7);
    });

    it('round-trips a class with an array member', () => {
      const obj: NrbfObject = { members: { items: [1, 2, 3] }, typeName: 'Wrapper' };
      expect((roundTrip(obj) as NrbfObject).members['items']).toEqual([1, 2, 3]);
    });

    it('round-trips a class with a nested object member', () => {
      const inner: NrbfObject = { members: { x: 5, y: 6 }, typeName: 'Point' };
      const outer: NrbfObject = { members: { start: inner }, typeName: 'Line' };
      const result = roundTrip(outer) as NrbfObject;
      const start = result.members['start'] as NrbfObject;
      expect(start.typeName).toBe('Point');
      expect(start.members['x']).toBe(5);
    });
  });

  describe('ClassWithMembersAndTypes (library class)', () => {
    it('round-trips a class with a libraryName', () => {
      const obj: NrbfObject = {
        libraryName: 'MyApp, Version=1.0.0.0',
        members: { debug: false, timeout: 30 },
        typeName: 'MyApp.Config',
      };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.typeName).toBe('MyApp.Config');
      expect(result.libraryName).toBe('MyApp, Version=1.0.0.0');
      expect(result.members['timeout']).toBe(30);
      expect(result.members['debug']).toBe(false);
    });
  });

  describe('ClassWithId', () => {
    it('reuses class metadata for multiple instances of the same type', () => {
      const p1: NrbfObject = { members: { x: 1, y: 2 }, typeName: 'Point' };
      const p2: NrbfObject = { members: { x: 3, y: 4 }, typeName: 'Point' };
      const result = roundTrip([p1, p2]) as NrbfObject[];
      expect(result[0]!.members['x']).toBe(1);
      expect(result[1]!.members['x']).toBe(3);
    });

    it('emits ClassWithId byte for the second instance (not a fresh SystemClassWithMembersAndTypes)', () => {
      const p1: NrbfObject = { members: { x: 1, y: 2 }, typeName: 'Point' };
      const p2: NrbfObject = { members: { x: 3, y: 4 }, typeName: 'Point' };
      const buf = serialize([p1, p2]);
      // Layout: header(17) + BinaryArray(Single,SystemClass)(21) + SCWMT Point(31) = 69
      // BinaryArray: 1(type)+4(id)+1(arrayType)+4(rank)+4(len)+1(binaryType)+6(LPS"Point") = 21
      // SCWMT Point: 1+4+6+4+2+2+1+1+1+1+4+4 = 31
      expect(buf[69]).toBe(RecordTypeEnumeration.ClassWithId);
      expect(buf.readInt32LE(70)).toBe(3); // objectId for p2
      expect(buf.readInt32LE(74)).toBe(2); // metadataId = p1's objectId
    });

    it('emits ClassWithId for every instance beyond the first (3 instances)', () => {
      const make = (x: number): NrbfObject => ({ members: { x, y: 0 }, typeName: 'Point' });
      const buf = serialize([make(1), make(2), make(3)]);
      // ClassWithId(p2) at offset 69; ClassWithId(p3) = 69 + 1+4+4+4+4 = 69 + 17 = 86
      expect(buf[69]).toBe(RecordTypeEnumeration.ClassWithId);
      expect(buf[86]).toBe(RecordTypeEnumeration.ClassWithId);
    });

    it('each ClassWithId instance carries independent member values', () => {
      const points = [1, 2, 3, 4, 5].map(
        (n): NrbfObject => ({ members: { x: n, y: n * 10 }, typeName: 'Point' }),
      );
      const result = roundTrip(points) as NrbfObject[];
      expect(result).toHaveLength(5);
      for (let i = 0; i < 5; i++) {
        expect(result[i]!.members['x']).toBe(i + 1);
        expect(result[i]!.members['y']).toBe((i + 1) * 10);
      }
    });

    it('reuses metadata for library-class instances (ClassWithMembersAndTypes → ClassWithId)', () => {
      const make = (n: number): NrbfObject => ({ libraryName: 'MyLib', members: { id: n }, typeName: 'Dto' });
      const result = roundTrip([make(1), make(2), make(3)]) as NrbfObject[];
      for (let i = 0; i < 3; i++) {
        expect(result[i]!.typeName).toBe('Dto');
        expect(result[i]!.libraryName).toBe('MyLib');
        expect(result[i]!.members['id']).toBe(i + 1);
      }
    });

    it('ClassWithId preserves memberTypes on round-trip', () => {
      const make = (n: number): NrbfObject => ({
        memberTypes: { hi: PrimitiveTypeEnumeration.Int32, lo: PrimitiveTypeEnumeration.Byte },
        members: { hi: n * 100, lo: n },
        typeName: 'Range',
      });
      const result = roundTrip([make(1), make(2)]) as NrbfObject[];
      expect(result[0]!.memberTypes?.['lo']).toBe(PrimitiveTypeEnumeration.Byte);
      expect(result[1]!.memberTypes?.['lo']).toBe(PrimitiveTypeEnumeration.Byte);
      expect(result[1]!.members['lo']).toBe(2);
      expect(result[1]!.members['hi']).toBe(200);
    });
  });

  describe('MemberReference (shared objects)', () => {
    it('writes a MemberReference when the same object appears twice', () => {
      const shared: NrbfObject = { members: { label: 'hot' }, typeName: 'Tag' };
      const container: NrbfObject = { members: { a: shared, b: shared }, typeName: 'Container' };
      const result = roundTrip(container) as NrbfObject;
      expect((result.members['a'] as NrbfObject).members['label']).toBe('hot');
      expect((result.members['b'] as NrbfObject).members['label']).toBe('hot');
    });
  });

  describe('memberTypes type fidelity', () => {
    function typedObj(memberTypes: NrbfObject['memberTypes'], members: NrbfObject['members']): NrbfObject {
      return { memberTypes, members, typeName: 'T' };
    }

    it('round-trips Single without promoting to Double', () => {
      const obj = typedObj({ v: PrimitiveTypeEnumeration.Single }, { v: 1.5 });
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members['v']).toBeCloseTo(1.5, 4);
      expect(result.memberTypes?.['v']).toBe(PrimitiveTypeEnumeration.Single);
    });

    it('round-trips UInt32 > Int32.MaxValue without promoting to Double', () => {
      const obj = typedObj({ v: PrimitiveTypeEnumeration.UInt32 }, { v: 4_294_967_295 });
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members['v']).toBe(4_294_967_295);
      expect(result.memberTypes?.['v']).toBe(PrimitiveTypeEnumeration.UInt32);
    });

    it('round-trips Byte without widening to Int32', () => {
      const obj = typedObj({ v: PrimitiveTypeEnumeration.Byte }, { v: 255 });
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members['v']).toBe(255);
      expect(result.memberTypes?.['v']).toBe(PrimitiveTypeEnumeration.Byte);
    });

    it('round-trips SByte without widening to Int32', () => {
      const obj = typedObj({ v: PrimitiveTypeEnumeration.SByte }, { v: -128 });
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members['v']).toBe(-128);
      expect(result.memberTypes?.['v']).toBe(PrimitiveTypeEnumeration.SByte);
    });

    it('round-trips Int16 without widening to Int32', () => {
      const obj = typedObj({ v: PrimitiveTypeEnumeration.Int16 }, { v: -32768 });
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members['v']).toBe(-32768);
      expect(result.memberTypes?.['v']).toBe(PrimitiveTypeEnumeration.Int16);
    });

    it('round-trips UInt16 without widening to Int32', () => {
      const obj = typedObj({ v: PrimitiveTypeEnumeration.UInt16 }, { v: 65535 });
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members['v']).toBe(65535);
      expect(result.memberTypes?.['v']).toBe(PrimitiveTypeEnumeration.UInt16);
    });

    it('round-trips PrimitiveArray of Single with correct element type', () => {
      const obj = typedObj({ vals: PrimitiveTypeEnumeration.Single }, { vals: [1.5, 2.5, 3.5] });
      const result = roundTrip(obj) as NrbfObject;
      const vals = result.members['vals'] as number[];
      expect(vals[0]).toBeCloseTo(1.5, 4);
      expect(vals[2]).toBeCloseTo(3.5, 4);
      expect(result.memberTypes?.['vals']).toBe(PrimitiveTypeEnumeration.Single);
    });

    it('deserialized objects carry memberTypes that survive re-serialization', () => {
      // Round-trip the sample fixture and verify memberTypes propagates
      const buf = readFileSync(join(fixturesDir, 'sample.nrbf'));
      const first = deserialize(buf) as NrbfObject;
      expect(first.memberTypes?.['Age']).toBe(PrimitiveTypeEnumeration.Int32);
      expect(first.memberTypes?.['IsActive']).toBe(PrimitiveTypeEnumeration.Boolean);
      expect(first.memberTypes?.['Score']).toBe(PrimitiveTypeEnumeration.Double);
      expect(first.memberTypes?.['Values']).toBe(PrimitiveTypeEnumeration.Int32);

      const second = deserialize(serialize(first)) as NrbfObject;
      expect(second.memberTypes?.['Age']).toBe(PrimitiveTypeEnumeration.Int32);
      expect(second.memberTypes?.['Score']).toBe(PrimitiveTypeEnumeration.Double);
    });
  });

  describe('Char round-trip', () => {
    function charObj(c: string): NrbfObject {
      return { memberTypes: { c: PrimitiveTypeEnumeration.Char }, members: { c }, typeName: 'T' };
    }

    it('round-trips ASCII char preserving Char type', () => {
      const result = roundTrip(charObj('A')) as NrbfObject;
      expect(result.members['c']).toBe('A');
      expect(result.memberTypes?.['c']).toBe(PrimitiveTypeEnumeration.Char);
    });

    it('round-trips 2-byte UTF-8 char (é)', () => {
      const result = roundTrip(charObj('é')) as NrbfObject;
      expect(result.members['c']).toBe('é');
      expect(result.memberTypes?.['c']).toBe(PrimitiveTypeEnumeration.Char);
    });

    it('round-trips 3-byte UTF-8 char (€)', () => {
      const result = roundTrip(charObj('€')) as NrbfObject;
      expect(result.members['c']).toBe('€');
      expect(result.memberTypes?.['c']).toBe(PrimitiveTypeEnumeration.Char);
    });

    it('without memberTypes hint, char is serialized as String (not Char)', () => {
      const obj: NrbfObject = { members: { c: 'A' }, typeName: 'T' };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members['c']).toBe('A');
      // No Char hint → inferred as String
      expect(result.memberTypes?.['c']).toBeUndefined();
    });
  });

  describe('Decimal round-trip', () => {
    function decObj(d: string): NrbfObject {
      return { memberTypes: { d: PrimitiveTypeEnumeration.Decimal }, members: { d }, typeName: 'T' };
    }

    it('round-trips a positive decimal', () => {
      const result = roundTrip(decObj('12.34')) as NrbfObject;
      expect(result.members['d']).toBe('12.34');
      expect(result.memberTypes?.['d']).toBe(PrimitiveTypeEnumeration.Decimal);
    });

    it('round-trips a negative decimal', () => {
      const result = roundTrip(decObj('-9999999999999999.9999')) as NrbfObject;
      expect(result.members['d']).toBe('-9999999999999999.9999');
      expect(result.memberTypes?.['d']).toBe(PrimitiveTypeEnumeration.Decimal);
    });

    it('round-trips zero decimal', () => {
      const result = roundTrip(decObj('0')) as NrbfObject;
      expect(result.members['d']).toBe('0');
      expect(result.memberTypes?.['d']).toBe(PrimitiveTypeEnumeration.Decimal);
    });
  });

  describe('TimeSpan round-trip', () => {
    function tsObj(ts: bigint): NrbfObject {
      return { memberTypes: { ts: PrimitiveTypeEnumeration.TimeSpan }, members: { ts }, typeName: 'T' };
    }

    it('round-trips 1 second (10_000_000 ticks)', () => {
      const result = roundTrip(tsObj(10_000_000n)) as NrbfObject;
      expect(result.members['ts']).toBe(10_000_000n);
      expect(result.memberTypes?.['ts']).toBe(PrimitiveTypeEnumeration.TimeSpan);
    });

    it('round-trips negative TimeSpan (-1 tick)', () => {
      const result = roundTrip(tsObj(-1n)) as NrbfObject;
      expect(result.members['ts']).toBe(-1n);
      expect(result.memberTypes?.['ts']).toBe(PrimitiveTypeEnumeration.TimeSpan);
    });

    it('round-trips zero TimeSpan', () => {
      const result = roundTrip(tsObj(0n)) as NrbfObject;
      expect(result.members['ts']).toBe(0n);
      expect(result.memberTypes?.['ts']).toBe(PrimitiveTypeEnumeration.TimeSpan);
    });

    it('without memberTypes hint, bigint is inferred as Int64 (not TimeSpan)', () => {
      const obj: NrbfObject = { members: { ts: 10_000_000n }, typeName: 'T' };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members['ts']).toBe(10_000_000n);
      expect(result.memberTypes?.['ts']).toBe(PrimitiveTypeEnumeration.Int64);
    });
  });

  describe('DateTime round-trip', () => {
    function dtObj(dt: DateTime): NrbfObject {
      return { members: { dt }, typeName: 'T' };
    }

    it('round-trips UTC DateTime (kind=1)', () => {
      const result = roundTrip(dtObj({ kind: 1, ticks: 638_000_000_000_000_000n })) as NrbfObject;
      const dt = result.members['dt'] as DateTime;
      expect(dt.ticks).toBe(638_000_000_000_000_000n);
      expect(dt.kind).toBe(1);
      expect(result.memberTypes?.['dt']).toBe(PrimitiveTypeEnumeration.DateTime);
    });

    it('round-trips Local DateTime (kind=2)', () => {
      const result = roundTrip(dtObj({ kind: 2, ticks: 0n })) as NrbfObject;
      const dt = result.members['dt'] as DateTime;
      expect(dt.ticks).toBe(0n);
      expect(dt.kind).toBe(2);
    });

    it('round-trips Unspecified DateTime (kind=0) with arbitrary ticks', () => {
      const result = roundTrip(dtObj({ kind: 0, ticks: 123_456_789n })) as NrbfObject;
      const dt = result.members['dt'] as DateTime;
      expect(dt.ticks).toBe(123_456_789n);
      expect(dt.kind).toBe(0);
    });

    it('round-trips max ticks (62-bit all-ones)', () => {
      const maxTicks = 0x3fffffffffffffffn;
      const result = roundTrip(dtObj({ kind: 0, ticks: maxTicks })) as NrbfObject;
      expect((result.members['dt'] as DateTime).ticks).toBe(maxTicks);
    });

    it('DateTime is auto-inferred without memberTypes hint', () => {
      const obj: NrbfObject = { members: { dt: { kind: 1, ticks: 1n } }, typeName: 'T' };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.memberTypes?.['dt']).toBe(PrimitiveTypeEnumeration.DateTime);
    });
  });

  describe('BinaryArray(Single) for uniform class arrays', () => {
    it('emits BinaryArray(Single, Class) for library class arrays', () => {
      // Header(17) + BinaryLibrary("Lib")(9) + ClassWithMembersAndTypes header(30) = 56
      // ClassWithMembersAndTypes header: type(1)+objectId(4)+name(1+9)+memberCount(4)+memberName(1+5)+typeInfo(1)+libraryId(4)=30
      const obj: NrbfObject = {
        libraryName: 'Lib',
        members: {
          items: [
            { libraryName: 'Lib', members: { n: 1 }, typeName: 'Item' },
            { libraryName: 'Lib', members: { n: 2 }, typeName: 'Item' },
          ] as NrbfValue[],
        },
        typeName: 'Container',
      };
      const buf = serialize(obj);
      expect(buf[56]).toBe(RecordTypeEnumeration.BinaryArray);
    });

    it('emits BinaryArray(Single, SystemClass) for system class arrays', () => {
      // Header(17) + SystemClassWithMembersAndTypes header(28) = 45
      // SystemClassWithMembersAndTypes: type(1)+objectId(4)+name(1+12)+memberCount(4)+memberName(1+5)+typeInfo(1)=29
      // Wait: no libraryId for SystemClass, so: 1+4+(1+12)+4+(1+5)+1 = 29 bytes
      // Total: 17 + 29 = 46
      const obj: NrbfObject = {
        members: {
          items: [
            { members: { v: 1 }, typeName: 'SysItem' },
            { members: { v: 2 }, typeName: 'SysItem' },
          ] as NrbfValue[],
        },
        typeName: 'SysContainer',
      };
      const buf = serialize(obj);
      // Header(17) + SystemClassWithMembersAndTypes: type(1)+objectId(4)+(1+12)+"SysContainer"+(4)+memberCount+(1+5)+"items"+typeInfo(1) = 46
      expect(buf[46]).toBe(RecordTypeEnumeration.BinaryArray);
    });

    it('falls back to ArraySingleObject for mixed class types', () => {
      const obj: NrbfObject = {
        libraryName: 'Lib',
        members: {
          items: [
            { libraryName: 'Lib', members: {}, typeName: 'Foo' },
            { libraryName: 'Lib', members: {}, typeName: 'Bar' },
          ] as NrbfValue[],
        },
        typeName: 'Container',
      };
      const buf = serialize(obj);
      expect(buf[56]).toBe(RecordTypeEnumeration.ArraySingleObject);
    });

    it('falls back to ArraySingleObject when nulls are mixed in', () => {
      const obj: NrbfObject = {
        libraryName: 'Lib',
        members: {
          items: [
            { libraryName: 'Lib', members: {}, typeName: 'Item' },
            null,
          ] as NrbfValue[],
        },
        typeName: 'Container',
      };
      const buf = serialize(obj);
      expect(buf[56]).toBe(RecordTypeEnumeration.ArraySingleObject);
    });

    it('round-trips library class array preserving element values', () => {
      const obj: NrbfObject = {
        libraryName: 'Lib',
        members: {
          items: [
            { libraryName: 'Lib', members: { n: 10 }, typeName: 'Item' },
            { libraryName: 'Lib', members: { n: 20 }, typeName: 'Item' },
          ] as NrbfValue[],
        },
        typeName: 'Container',
      };
      const result = deserialize(serialize(obj)) as NrbfObject;
      const items = result.members['items'] as NrbfObject[];
      expect(items).toHaveLength(2);
      expect(items[0]!.typeName).toBe('Item');
      expect(items[0]!.libraryName).toBe('Lib');
      expect(items[0]!.members['n']).toBe(10);
      expect(items[1]!.members['n']).toBe(20);
    });

    it('round-trips system class array preserving element values', () => {
      const obj: NrbfObject = {
        members: {
          items: [
            { members: { v: 42 }, typeName: 'SysItem' },
            { members: { v: 99 }, typeName: 'SysItem' },
          ] as NrbfValue[],
        },
        typeName: 'SysContainer',
      };
      const result = deserialize(serialize(obj)) as NrbfObject;
      const items = result.members['items'] as NrbfObject[];
      expect(items).toHaveLength(2);
      expect(items[0]!.members['v']).toBe(42);
      expect(items[1]!.members['v']).toBe(99);
    });
  });

  describe('fixture round-trip', () => {
    it('round-trips sample.nrbf without data loss', () => {
      const original = deserialize(readFileSync(join(fixturesDir, 'sample.nrbf'))) as NrbfObject;
      const result = roundTrip(original) as NrbfObject;

      expect(result.typeName).toBe(original.typeName);
      expect(result.libraryName).toBe(original.libraryName);
      expect(result.members['Name']).toBe('Hello, World!');
      expect(result.members['Age']).toBe(42);
      expect(result.members['IsActive']).toBe(true);
      expect(result.members['Score']).toBeCloseTo(3.14);
      expect(result.members['Values']).toEqual([10, 20, 30]);
    });

    it('byte-exact round-trip of sample.nrbf', () => {
      const buf = readFileSync(join(fixturesDir, 'sample.nrbf'));
      const reserialized = serialize(deserialize(buf));
      expect(reserialized).toEqual(buf);
    });

    it('byte-exact round-trip of method_call.nrbf', () => {
      const buf = readFileSync(join(fixturesDir, 'method_call.nrbf'));
      const reserialized = serialize(deserialize(buf));
      expect(reserialized).toEqual(buf);
    });

    it('byte-exact round-trip of method_return.nrbf', () => {
      const buf = readFileSync(join(fixturesDir, 'method_return.nrbf'));
      const reserialized = serialize(deserialize(buf));
      expect(reserialized).toEqual(buf);
    });

    it('round-trip of object_graph.nrbf preserves structure and values', () => {
      const buf = readFileSync(join(fixturesDir, 'object_graph.nrbf'));
      const root = deserialize(serialize(deserialize(buf))) as NrbfObject;

      expect(root.typeName).toBe('GraphRoot');
      const nodeA = root.members['NodeA'] as NrbfObject;
      const nodeB = root.members['NodeB'] as NrbfObject;
      expect(nodeA.typeName).toBe('Node');
      expect(nodeA.members['Value']).toBe(100);
      expect(nodeA.members['Tag']).toBe('Alpha');
      expect(nodeA.members['Peer']).toBe(nodeB);

      expect(nodeB.typeName).toBe('Node');
      expect(nodeB.members['Value']).toBe(200);
      expect(nodeB.members['Tag']).toBe('Beta');
      expect(nodeB.members['Peer']).toBe(nodeA);

      const ver = root.members['Version'] as NrbfObject;
      expect(ver.typeName).toBe('System.Version');
      expect(ver.members['_Major']).toBe(4);
      expect(ver.members['_Minor']).toBe(8);

      expect((root.members['Matrix'] as NrbfArray).elements).toEqual([11, 12, 13, 21, 22, 23]);

      const sparse = root.members['SparseSmall'] as (string | null)[];
      expect(sparse[0]).toBe('first');
      expect(sparse[10]).toBe('Beta');
      expect(sparse[11]).toBe('last');
      expect(sparse[1]).toBeNull();
    });

    it('semantic round-trip of return_value_inline_null.nrbf (ReturnValueInline(Null) → NoReturnValue)', () => {
      // The fixture uses ReturnValueInline with PrimitiveType.Null — a valid but less precise
      // encoding. The serializer now emits NoReturnValue instead, which is byte-inequivalent
      // but semantically identical.
      const buf = readFileSync(join(fixturesDir, 'return_value_inline_null.nrbf'));
      const deserialized = deserialize(buf) as NrbfMethodReturn;
      expect(deserialized.returnValue).toBeNull();
      const reserialized = deserialize(serialize(deserialized)) as NrbfMethodReturn;
      expect(reserialized.returnValue).toBeNull();
    });

    it('byte-exact round-trip of exception_in_array.nrbf', () => {
      const buf = readFileSync(join(fixturesDir, 'exception_in_array.nrbf'));
      const reserialized = serialize(deserialize(buf));
      expect(reserialized).toEqual(buf);
    });

    it('byte-exact round-trip of context_in_array_call.nrbf', () => {
      const buf = readFileSync(join(fixturesDir, 'context_in_array_call.nrbf'));
      const reserialized = serialize(deserialize(buf));
      expect(reserialized).toEqual(buf);
    });

    it('byte-exact round-trip of return_and_context_in_array.nrbf', () => {
      const buf = readFileSync(join(fixturesDir, 'return_and_context_in_array.nrbf'));
      const reserialized = serialize(deserialize(buf));
      expect(reserialized).toEqual(buf);
    });
  });

  describe('ObjectNullMultiple / ObjectNullMultiple256 null-run compression', () => {
    it('emits ObjectNull for a single null in an array', () => {
      const buf = serialize(['a', null, 'b']);
      const nullIdx = buf.indexOf(RecordTypeEnumeration.ObjectNull, 17);
      expect(buf[nullIdx]).toBe(RecordTypeEnumeration.ObjectNull);
    });

    it('emits ObjectNullMultiple256 for 2 consecutive nulls', () => {
      const buf = serialize(['a', null, null, 'b']);
      const idx = buf.indexOf(RecordTypeEnumeration.ObjectNullMultiple256);
      expect(idx).toBeGreaterThan(-1);
      expect(buf[idx + 1]).toBe(2);
    });

    it('emits ObjectNullMultiple256 for 255 consecutive nulls', () => {
      const arr: (string | null)[] = ['start', ...Array<null>(255).fill(null), 'end'];
      const buf = serialize(arr);
      const idx = buf.indexOf(RecordTypeEnumeration.ObjectNullMultiple256);
      expect(idx).toBeGreaterThan(-1);
      expect(buf[idx + 1]).toBe(255);
    });

    it('emits ObjectNullMultiple for 256 consecutive nulls', () => {
      const arr: (string | null)[] = ['start', ...Array<null>(256).fill(null), 'end'];
      const buf = serialize(arr);
      const idx = buf.indexOf(RecordTypeEnumeration.ObjectNullMultiple);
      expect(idx).toBeGreaterThan(-1);
      expect(buf.readInt32LE(idx + 1)).toBe(256);
    });

    it('round-trips an array with 2 consecutive nulls', () => {
      expect(roundTrip(['a', null, null, 'b'])).toEqual(['a', null, null, 'b']);
    });

    it('round-trips an array with 255 consecutive nulls', () => {
      const arr: (string | null)[] = ['start', ...Array<null>(255).fill(null), 'end'];
      expect(roundTrip(arr)).toEqual(arr);
    });

    it('round-trips an array with 256 consecutive nulls', () => {
      const arr: (string | null)[] = ['start', ...Array<null>(256).fill(null), 'end'];
      expect(roundTrip(arr)).toEqual(arr);
    });

    it('round-trips an ArraySingleObject with multiple consecutive nulls', () => {
      expect(roundTrip([42, null, null, null, 'x'])).toEqual([42, null, null, null, 'x']);
    });

    it('round-trips multiple separate null runs', () => {
      const arr: (string | null)[] = [null, null, 'mid', null, null, null];
      expect(roundTrip(arr)).toEqual(arr);
    });
  });

  describe('ArraySingleObject with primitive elements', () => {
    it('round-trips a mixed primitive+null array', () => {
      expect(roundTrip([42, null])).toEqual([42, null]);
    });

    it('round-trips a mixed boolean+null+string array', () => {
      expect(roundTrip([true, null, 'x'])).toEqual([true, null, 'x']);
    });
  });

  describe('string-array class member', () => {
    it('round-trips a class with a string array member', () => {
      const obj: NrbfObject = { members: { tags: ['a', 'b', 'c'] }, typeName: 'T' };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.members['tags']).toEqual(['a', 'b', 'c']);
    });
  });

  describe('NrbfMethodCall', () => {
    function roundTripCall(call: NrbfMethodCall): NrbfMethodCall {
      return deserialize(serialize(call)) as NrbfMethodCall;
    }

    it('round-trips args containing an NrbfObject (ArgsIsArray path)', () => {
      const call: NrbfMethodCall = {
        args: [{ members: { x: 1 }, typeName: 'Inner' }],
        kind: 'MethodCall',
        methodName: 'M',
        typeName: 'T',
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ members: { x: 1 }, typeName: 'Inner' }]);
    });

    it('round-trips mixed primitive and NrbfObject args', () => {
      const call: NrbfMethodCall = {
        args: [42, 'text', { members: { value: true }, typeName: 'Payload' }],
        kind: 'MethodCall',
        methodName: 'Process',
        typeName: 'IService',
      };
      const result = roundTripCall(call);
      expect(result.methodName).toBe('Process');
      expect(result.args?.[0]).toBe(42);
      expect(result.args?.[1]).toBe('text');
      expect(result.args?.[2]).toMatchObject({ members: { value: true }, typeName: 'Payload' });
    });

    it('round-trips NrbfObject args with a library name', () => {
      const call: NrbfMethodCall = {
        args: [{ libraryName: 'MyLib, Version=1.0.0.0', members: { id: 7 }, typeName: 'Msg' }],
        kind: 'MethodCall',
        methodName: 'Send',
        typeName: 'IService',
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ libraryName: 'MyLib, Version=1.0.0.0', members: { id: 7 }, typeName: 'Msg' }]);
    });

    it('round-trips methodName and typeName', () => {
      const call: NrbfMethodCall = { kind: 'MethodCall', methodName: 'DoWork', typeName: 'IService' };
      const result = roundTripCall(call);
      expect(result.kind).toBe('MethodCall');
      expect(result.methodName).toBe('DoWork');
      expect(result.typeName).toBe('IService');
      expect(result.args).toBeUndefined();
      expect(result.callContext).toBeUndefined();
    });

    it('round-trips with string and int args', () => {
      const call: NrbfMethodCall = {
        args: ['payload-data', 7],
        kind: 'MethodCall',
        methodName: 'PerformAction',
        typeName: 'IMyService, AdvancedDemo, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null',
      };
      const result = roundTripCall(call);
      expect(result.methodName).toBe('PerformAction');
      expect(result.args).toEqual(['payload-data', 7]);
    });

    it('round-trips with callContext', () => {
      const call: NrbfMethodCall = {
        callContext: 'ctx-value',
        kind: 'MethodCall',
        methodName: 'Ping',
        typeName: 'IService',
      };
      const result = roundTripCall(call);
      expect(result.callContext).toBe('ctx-value');
    });

    it('round-trips NrbfObject callContext alone (ContextInArray path)', () => {
      const call: NrbfMethodCall = {
        callContext: { libraryName: 'mscorlib', members: { id: 'call-42' }, typeName: 'System.Runtime.Remoting.Messaging.LogicalCallContext' },
        kind: 'MethodCall',
        methodName: 'M',
        typeName: 'T',
      };
      const result = roundTripCall(call);
      expect(result.callContext).toMatchObject({ members: { id: 'call-42' }, typeName: 'System.Runtime.Remoting.Messaging.LogicalCallContext' });
    });

    it('round-trips NrbfObject args and NrbfObject callContext together', () => {
      const call: NrbfMethodCall = {
        args: [{ members: { x: 1 }, typeName: 'Arg' }],
        callContext: { libraryName: 'mscorlib', members: { id: 'ctx' }, typeName: 'System.Runtime.Remoting.Messaging.LogicalCallContext' },
        kind: 'MethodCall',
        methodName: 'M',
        typeName: 'T',
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ members: { x: 1 }, typeName: 'Arg' }]);
      expect(result.callContext).toMatchObject({ members: { id: 'ctx' }, typeName: 'System.Runtime.Remoting.Messaging.LogicalCallContext' });
    });

    it('round-trips with callContext and args', () => {
      const call: NrbfMethodCall = {
        args: [true, 42n],
        callContext: 'ctx',
        kind: 'MethodCall',
        methodName: 'Ping',
        typeName: 'IService',
      };
      const result = roundTripCall(call);
      expect(result.callContext).toBe('ctx');
      expect(result.args).toEqual([true, 42n]);
    });

    it('round-trips fixture method_call.nrbf', () => {
      const original = deserialize(readFileSync(join(fixturesDir, 'method_call.nrbf'))) as NrbfMethodCall;
      const result = roundTripCall(original);
      expect(result.kind).toBe(original.kind);
      expect(result.methodName).toBe(original.methodName);
      expect(result.typeName).toBe(original.typeName);
      expect(result.args).toEqual(original.args);
      expect(result.callContext).toEqual(original.callContext);
    });

    it('round-trips genericTypeArguments without args (GenericMethod only)', () => {
      const typeArg = { libraryName: 'mscorlib', members: { Data: 'System.Int32', UnityType: 9 }, typeName: 'System.UnitySerializationHolder' };
      const call: NrbfMethodCall = {
        genericTypeArguments: [typeArg],
        kind: 'MethodCall',
        methodName: 'M`1',
        typeName: 'IService',
      };
      const result = roundTripCall(call);
      expect(result.genericTypeArguments).toHaveLength(1);
      expect(result.genericTypeArguments![0]).toMatchObject({ members: { Data: 'System.Int32', UnityType: 9 }, typeName: 'System.UnitySerializationHolder' });
    });

    it('round-trips genericTypeArguments with complex args (ArgsIsArray + GenericMethod)', () => {
      const typeArg = { libraryName: 'mscorlib', members: { Data: 'MyLib.Payload', UnityType: 4 }, typeName: 'System.UnitySerializationHolder' };
      const call: NrbfMethodCall = {
        args: [{ libraryName: 'MyLib', members: { value: 99 }, typeName: 'Payload' }],
        genericTypeArguments: [typeArg],
        kind: 'MethodCall',
        methodName: 'Send`1',
        typeName: 'IService',
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ members: { value: 99 }, typeName: 'Payload' }]);
      expect(result.genericTypeArguments).toHaveLength(1);
      expect(result.genericTypeArguments![0]).toMatchObject({ members: { Data: 'MyLib.Payload' } });
    });

    it('round-trips genericTypeArguments with methodSignature (GenericMethod + MethodSignatureInArray)', () => {
      const makeHolder = (data: string) => ({ libraryName: 'mscorlib', members: { Data: data, UnityType: 9 }, typeName: 'System.UnitySerializationHolder' });
      const call: NrbfMethodCall = {
        args: [{ libraryName: 'Lib', members: { id: 7 }, typeName: 'Item' }],
        genericTypeArguments: [makeHolder('System.String')],
        kind: 'MethodCall',
        methodName: 'Process`1',
        methodSignature: [makeHolder('Lib.Item')],
        typeName: 'IWorker',
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ members: { id: 7 } }]);
      expect(result.genericTypeArguments).toHaveLength(1);
      expect(result.genericTypeArguments![0]).toMatchObject({ members: { Data: 'System.String' } });
      expect(result.methodSignature).toHaveLength(1);
      expect(result.methodSignature![0]).toMatchObject({ members: { Data: 'Lib.Item' } });
    });

    it('round-trips methodSignature without args (MethodSignatureInArray only)', () => {
      const sigEntry = { libraryName: 'mscorlib', members: { Data: 'System.String', UnityType: 9 }, typeName: 'System.UnitySerializationHolder' };
      const call: NrbfMethodCall = {
        kind: 'MethodCall',
        methodName: 'Greet',
        methodSignature: [sigEntry],
        typeName: 'IService',
      };
      const result = roundTripCall(call);
      expect(result.methodSignature).toHaveLength(1);
      expect(result.methodSignature![0]).toMatchObject({ members: { Data: 'System.String', UnityType: 9 }, typeName: 'System.UnitySerializationHolder' });
    });

    it('round-trips methodSignature with complex args (ArgsIsArray + MethodSignatureInArray)', () => {
      const sigEntry = { libraryName: 'mscorlib', members: { Data: 'MyLib.Payload', UnityType: 4 }, typeName: 'System.UnitySerializationHolder' };
      const call: NrbfMethodCall = {
        args: [{ libraryName: 'MyLib', members: { value: 42 }, typeName: 'Payload' }],
        kind: 'MethodCall',
        methodName: 'Send',
        methodSignature: [sigEntry],
        typeName: 'IService',
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ members: { value: 42 }, typeName: 'Payload' }]);
      expect(result.methodSignature).toHaveLength(1);
      expect(result.methodSignature![0]).toMatchObject({ members: { Data: 'MyLib.Payload', UnityType: 4 }, typeName: 'System.UnitySerializationHolder' });
    });

    it('round-trips methodSignature with object callContext (MethodSignatureInArray + ContextInArray)', () => {
      const sigEntry = { libraryName: 'mscorlib', members: { Data: 'System.Int32', UnityType: 9 }, typeName: 'System.UnitySerializationHolder' };
      const call: NrbfMethodCall = {
        callContext: { libraryName: 'mscorlib', members: { id: 'ctx-99' }, typeName: 'System.Runtime.Remoting.Messaging.LogicalCallContext' },
        kind: 'MethodCall',
        methodName: 'M',
        methodSignature: [sigEntry],
        typeName: 'T',
      };
      const result = roundTripCall(call);
      expect(result.methodSignature).toHaveLength(1);
      expect(result.methodSignature![0]).toMatchObject({ members: { Data: 'System.Int32' } });
      expect(result.callContext).toMatchObject({ members: { id: 'ctx-99' } });
    });

    it('round-trips methodSignature with complex args, object callContext, and messageProperties', () => {
      const makeSig = (data: string) => ({ libraryName: 'mscorlib', members: { Data: data, UnityType: 9 }, typeName: 'System.UnitySerializationHolder' });
      const call: NrbfMethodCall = {
        args: [
          { libraryName: 'Lib', members: { id: 1 }, typeName: 'Item' },
          { libraryName: 'Lib', members: { flag: true }, typeName: 'Options' },
        ],
        callContext: { libraryName: 'mscorlib', members: { traceId: 'abc' }, typeName: 'System.Runtime.Remoting.Messaging.LogicalCallContext' },
        kind: 'MethodCall',
        messageProperties: [{ libraryName: 'Lib', members: { key: 'val' }, typeName: 'Prop' }],
        methodName: 'Process',
        methodSignature: [makeSig('Lib.Item'), makeSig('Lib.Options')],
        typeName: 'IWorker',
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ members: { id: 1 } }, { members: { flag: true } }]);
      expect(result.methodSignature).toHaveLength(2);
      expect(result.methodSignature![0]).toMatchObject({ members: { Data: 'Lib.Item' } });
      expect(result.methodSignature![1]).toMatchObject({ members: { Data: 'Lib.Options' } });
      expect(result.callContext).toMatchObject({ members: { traceId: 'abc' } });
      expect(result.messageProperties).toMatchObject([{ members: { key: 'val' } }]);
    });

    it('round-trips inline null arg (inferValueWithCodeType null branch, line 72)', () => {
      // null is a valid inline arg — inferValueWithCodeType(null) returns PrimitiveTypeEnumeration.Null.
      // hasComplexArgs=false for [null], so ArgsInline path is taken.
      const call: NrbfMethodCall = {
        args: [null],
        kind: 'MethodCall',
        methodName: 'M',
        typeName: 'T',
      };
      const result = roundTripCall(call);
      expect(result.args).toEqual([null]);
    });
  });

  describe('NrbfMethodReturn', () => {
    function roundTripReturn(ret: NrbfMethodReturn): NrbfMethodReturn {
      return deserialize(serialize(ret)) as NrbfMethodReturn;
    }

    it('round-trips with no return value (void)', () => {
      const ret: NrbfMethodReturn = { kind: 'MethodReturn' };
      const result = roundTripReturn(ret);
      expect(result.kind).toBe('MethodReturn');
      expect(result.returnValue).toBeUndefined();
      expect(result.args).toBeUndefined();
      expect(result.callContext).toBeUndefined();
    });

    it('round-trips with a string return value', () => {
      const ret: NrbfMethodReturn = { kind: 'MethodReturn', returnValue: 'success' };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toBe('success');
    });

    it('round-trips with a numeric return value', () => {
      const ret: NrbfMethodReturn = { kind: 'MethodReturn', returnValue: 99 };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toBe(99);
    });

    it('round-trips with null return value (NoReturnValue flag)', () => {
      const ret: NrbfMethodReturn = { kind: 'MethodReturn', returnValue: null };
      const buf = serialize(ret);
      // Verify NoReturnValue flag (0x0200) is set in the 4-byte MessageEnum after the
      // MethodReturn record-type byte. flags = NoReturnValue|NoContext|NoArgs = 0x0211.
      const methodReturnOffset = buf.indexOf(RecordTypeEnumeration.MethodReturn);
      const flags = buf.readInt32LE(methodReturnOffset + 1);
      expect(flags & MessageFlags.NoReturnValue).toBeTruthy();
      expect(flags & MessageFlags.ReturnValueInline).toBeFalsy();
      expect(flags & MessageFlags.ReturnValueVoid).toBeFalsy();
      const result = roundTripReturn(ret);
      expect(result.returnValue).toBeNull();
    });

    it('round-trips with args', () => {
      const ret: NrbfMethodReturn = { args: [1, 'extra'], kind: 'MethodReturn', returnValue: 'done' };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toBe('done');
      expect(result.args).toEqual([1, 'extra']);
    });

    it('round-trips with callContext', () => {
      const ret: NrbfMethodReturn = { callContext: 'ctx', kind: 'MethodReturn', returnValue: 1 };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toBe(1);
      expect(result.callContext).toBe('ctx');
    });

    it('round-trips NrbfObject callContext alone (ContextInArray path)', () => {
      const ret: NrbfMethodReturn = {
        callContext: { libraryName: 'mscorlib', members: { id: 'r-42' }, typeName: 'System.Runtime.Remoting.Messaging.LogicalCallContext' },
        kind: 'MethodReturn',
      };
      const result = roundTripReturn(ret);
      expect(result.callContext).toMatchObject({ members: { id: 'r-42' }, typeName: 'System.Runtime.Remoting.Messaging.LogicalCallContext' });
    });

    it('round-trips complex return value and NrbfObject callContext together', () => {
      const ret: NrbfMethodReturn = {
        callContext: { libraryName: 'mscorlib', members: { id: 'r-ctx' }, typeName: 'System.Runtime.Remoting.Messaging.LogicalCallContext' },
        kind: 'MethodReturn',
        returnValue: { members: { code: 0 }, typeName: 'Result' },
      };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toMatchObject({ members: { code: 0 }, typeName: 'Result' });
      expect(result.callContext).toMatchObject({ members: { id: 'r-ctx' } });
    });

    it('round-trips fixture method_return.nrbf', () => {
      const original = deserialize(readFileSync(join(fixturesDir, 'method_return.nrbf'))) as NrbfMethodReturn;
      const result = roundTripReturn(original);
      expect(result.kind).toBe(original.kind);
      expect(result.returnValue).toEqual(original.returnValue);
      expect(result.callContext).toEqual(original.callContext);
      expect(result.args).toEqual(original.args);
    });

    it('round-trips NrbfObject return value (ReturnValueInArray path)', () => {
      const ret: NrbfMethodReturn = {
        kind: 'MethodReturn',
        returnValue: { members: { code: 0, message: 'ok' }, typeName: 'Result' },
      };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toMatchObject({ members: { code: 0, message: 'ok' }, typeName: 'Result' });
    });

    it('round-trips NrbfObject return value with a library name', () => {
      const ret: NrbfMethodReturn = {
        kind: 'MethodReturn',
        returnValue: { libraryName: 'Svc, Version=2.0.0.0', members: { status: 200 }, typeName: 'Resp' },
      };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toMatchObject({ libraryName: 'Svc, Version=2.0.0.0', members: { status: 200 }, typeName: 'Resp' });
    });

    it('round-trips complex args in MethodReturn (ArgsInArray path)', () => {
      const ret: NrbfMethodReturn = {
        args: [{ members: { val: 99 }, typeName: 'OutParam' }],
        kind: 'MethodReturn',
        returnValue: 'done',
      };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toBe('done');
      expect(result.args).toMatchObject([{ members: { val: 99 }, typeName: 'OutParam' }]);
    });

    it('round-trips complex return value and complex args together', () => {
      const ret: NrbfMethodReturn = {
        args: [{ members: { n: 2 }, typeName: 'A' }],
        kind: 'MethodReturn',
        returnValue: { members: { n: 1 }, typeName: 'R' },
      };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toMatchObject({ members: { n: 1 }, typeName: 'R' });
      expect(result.args).toMatchObject([{ members: { n: 2 }, typeName: 'A' }]);
    });

    it('round-trips exception alone (ExceptionInArray path)', () => {
      const ret: NrbfMethodReturn = {
        exception: { libraryName: 'mscorlib', members: { _message: 'boom' }, typeName: 'System.Exception' },
        kind: 'MethodReturn',
      };
      const result = roundTripReturn(ret);
      expect(result.exception).toMatchObject({ members: { _message: 'boom' }, typeName: 'System.Exception' });
      expect(result.returnValue).toBeUndefined();
      expect(result.args).toBeUndefined();
    });

    it('round-trips exception with NrbfObject callContext', () => {
      const ret: NrbfMethodReturn = {
        callContext: { libraryName: 'mscorlib', members: { id: 'ex-ctx' }, typeName: 'System.Runtime.Remoting.Messaging.LogicalCallContext' },
        exception: { libraryName: 'mscorlib', members: { _message: 'invalid' }, typeName: 'System.InvalidOperationException' },
        kind: 'MethodReturn',
      };
      const result = roundTripReturn(ret);
      expect(result.exception).toMatchObject({ members: { _message: 'invalid' }, typeName: 'System.InvalidOperationException' });
      expect(result.callContext).toMatchObject({ members: { id: 'ex-ctx' } });
    });

    it('round-trips exception with string callContext', () => {
      const ret: NrbfMethodReturn = {
        callContext: 'call-123',
        exception: { libraryName: 'mscorlib', members: { _message: 'oops' }, typeName: 'System.Exception' },
        kind: 'MethodReturn',
      };
      const result = roundTripReturn(ret);
      expect(result.exception).toMatchObject({ members: { _message: 'oops' }, typeName: 'System.Exception' });
      expect(result.callContext).toBe('call-123');
    });

    it('round-trips messageProperties alone (PropertiesInArray path)', () => {
      const entry: NrbfObject = { members: { _key: 'priority', _value: 1 }, typeName: 'DictionaryEntry' };
      const ret: NrbfMethodReturn = { kind: 'MethodReturn', messageProperties: [entry] };
      const result = roundTripReturn(ret);
      expect(result.messageProperties).toMatchObject([{ members: { _key: 'priority', _value: 1 }, typeName: 'DictionaryEntry' }]);
      expect(result.returnValue).toBeUndefined();
    });

    it('round-trips messageProperties alongside return value and callContext', () => {
      const entry: NrbfObject = { members: { _key: 'trace', _value: 'abc' }, typeName: 'DictionaryEntry' };
      const ret: NrbfMethodReturn = {
        callContext: 'ctx-1',
        kind: 'MethodReturn',
        messageProperties: [entry],
        returnValue: 42,
      };
      const result = roundTripReturn(ret);
      expect(result.returnValue).toBe(42);
      expect(result.callContext).toBe('ctx-1');
      expect(result.messageProperties).toMatchObject([{ members: { _key: 'trace', _value: 'abc' }, typeName: 'DictionaryEntry' }]);
    });

    it('round-trips messageProperties alongside exception (PropertiesInArray + ExceptionInArray)', () => {
      const entry: NrbfObject = { members: { _key: 'reqId', _value: 'x99' }, typeName: 'DictionaryEntry' };
      const ret: NrbfMethodReturn = {
        exception: { libraryName: 'mscorlib', members: { _message: 'fail' }, typeName: 'System.Exception' },
        kind: 'MethodReturn',
        messageProperties: [entry],
      };
      const result = roundTripReturn(ret);
      expect(result.exception).toMatchObject({ members: { _message: 'fail' }, typeName: 'System.Exception' });
      expect(result.messageProperties).toMatchObject([{ members: { _key: 'reqId', _value: 'x99' }, typeName: 'DictionaryEntry' }]);
    });
  });

  describe('ValueWithCode primitive type precision (argTypes / returnType)', () => {
    it('preserves Single return value without precision loss', () => {
      const ret: NrbfMethodReturn = {
        kind: 'MethodReturn',
        returnType: PrimitiveTypeEnumeration.Single,
        returnValue: 1.5,
      };
      const buf = serialize(ret);
      const result = deserialize(buf) as NrbfMethodReturn;
      expect(result.returnValue).toBe(1.5);
      expect(result.returnType).toBe(PrimitiveTypeEnumeration.Single);
      // Re-serialize should still use Single, not Double.
      const buf2 = serialize(result);
      expect(buf2).toEqual(buf);
    });

    it('preserves UInt32 arg that exceeds Int32 range', () => {
      const call: NrbfMethodCall = {
        argTypes: [PrimitiveTypeEnumeration.UInt32],
        args: [4_000_000_000],
        kind: 'MethodCall',
        methodName: 'M',
        typeName: 'T',
      };
      const buf = serialize(call);
      const result = deserialize(buf) as NrbfMethodCall;
      expect(result.args![0]).toBe(4_000_000_000);
      expect(result.argTypes![0]).toBe(PrimitiveTypeEnumeration.UInt32);
      expect(serialize(result)).toEqual(buf);
    });

    it('preserves Char arg (distinct from String)', () => {
      const call: NrbfMethodCall = {
        argTypes: [PrimitiveTypeEnumeration.Char],
        args: ['A'],
        kind: 'MethodCall',
        methodName: 'M',
        typeName: 'T',
      };
      const buf = serialize(call);
      const result = deserialize(buf) as NrbfMethodCall;
      expect(result.args![0]).toBe('A');
      expect(result.argTypes![0]).toBe(PrimitiveTypeEnumeration.Char);
      expect(serialize(result)).toEqual(buf);
    });

    it('preserves UInt64 output arg in MethodReturn', () => {
      const ret: NrbfMethodReturn = {
        argTypes: [PrimitiveTypeEnumeration.UInt64],
        args: [18_446_744_073_709_551_615n],
        kind: 'MethodReturn',
      };
      const buf = serialize(ret);
      const result = deserialize(buf) as NrbfMethodReturn;
      expect(result.args![0]).toBe(18_446_744_073_709_551_615n);
      expect(result.argTypes![0]).toBe(PrimitiveTypeEnumeration.UInt64);
      expect(serialize(result)).toEqual(buf);
    });

    it('deserializer populates argTypes from ArgsInline stream', () => {
      // Build a stream with Single + UInt32 args using known argTypes.
      const call: NrbfMethodCall = {
        argTypes: [PrimitiveTypeEnumeration.Single, PrimitiveTypeEnumeration.UInt32],
        args: [3.14, 3_000_000_000],
        kind: 'MethodCall',
        methodName: 'M',
        typeName: 'T',
      };
      const result = deserialize(serialize(call)) as NrbfMethodCall;
      expect(result.argTypes).toEqual([PrimitiveTypeEnumeration.Single, PrimitiveTypeEnumeration.UInt32]);
    });

    it('deserializer populates returnType from ReturnValueInline stream', () => {
      const ret: NrbfMethodReturn = {
        kind: 'MethodReturn',
        returnType: PrimitiveTypeEnumeration.Single,
        returnValue: 2.5,
      };
      const result = deserialize(serialize(ret)) as NrbfMethodReturn;
      expect(result.returnType).toBe(PrimitiveTypeEnumeration.Single);
      expect(result.returnValue).toBe(2.5);
    });

    it('preserves Single alongside an object arg in ArgsIsArray path', () => {
      // Without the fix, inferPrimitiveType(1.5) returns Double, so the Single would round-trip
      // as Double. With the fix, argTypes[1]=Single is threaded through writeAnyValue.
      const obj: NrbfObject = { members: { x: 1 }, typeName: 'Foo' };
      const call: NrbfMethodCall = {
        argTypes: [undefined, PrimitiveTypeEnumeration.Single],
        args: [obj, 1.5],
        kind: 'MethodCall',
        methodName: 'M',
        typeName: 'T',
      };
      const result = deserialize(serialize(call)) as NrbfMethodCall;
      expect(result.args![1]).toBeCloseTo(1.5);
      expect(result.argTypes![1]).toBe(PrimitiveTypeEnumeration.Single);
    });

    it('preserves Char alongside an object arg in ArgsIsArray path', () => {
      // Char is a string in JS — without the fix it would be written as BinaryObjectString,
      // and the type hint would be lost entirely.
      const obj: NrbfObject = { members: { n: 42 }, typeName: 'Bar' };
      const call: NrbfMethodCall = {
        argTypes: [undefined, PrimitiveTypeEnumeration.Char],
        args: [obj, 'A'],
        kind: 'MethodCall',
        methodName: 'Send',
        typeName: 'ISvc',
      };
      const result = deserialize(serialize(call)) as NrbfMethodCall;
      expect(result.args![1]).toBe('A');
      expect(result.argTypes![1]).toBe(PrimitiveTypeEnumeration.Char);
    });

    it('deserializer populates argTypes from ArgsIsArray stream', () => {
      // Serialise with explicit type hints, deserialise and verify argTypes is populated.
      const obj: NrbfObject = { members: { id: 0 }, typeName: 'Payload' };
      const call: NrbfMethodCall = {
        argTypes: [undefined, PrimitiveTypeEnumeration.UInt32, PrimitiveTypeEnumeration.Single],
        args: [obj, 4_000_000_000, 3.14],
        kind: 'MethodCall',
        methodName: 'Process',
        typeName: 'IWorker',
      };
      const result = deserialize(serialize(call)) as NrbfMethodCall;
      expect(result.argTypes![0]).toBeUndefined();
      expect(result.argTypes![1]).toBe(PrimitiveTypeEnumeration.UInt32);
      expect(result.argTypes![2]).toBe(PrimitiveTypeEnumeration.Single);
      expect(result.args![1]).toBe(4_000_000_000);
      expect(result.args![2]).toBeCloseTo(3.14);
    });
  });

  describe('NrbfMethodCall messageProperties', () => {
    function roundTripCall(call: NrbfMethodCall): NrbfMethodCall {
      return deserialize(serialize(call)) as NrbfMethodCall;
    }

    it('round-trips messageProperties alone (no args, no context)', () => {
      const entry: NrbfObject = { members: { _key: 'env', _value: 'prod' }, typeName: 'DictionaryEntry' };
      const call: NrbfMethodCall = {
        kind: 'MethodCall',
        messageProperties: [entry],
        methodName: 'Ping',
        typeName: 'IService',
      };
      const result = roundTripCall(call);
      expect(result.messageProperties).toMatchObject([{ members: { _key: 'env', _value: 'prod' }, typeName: 'DictionaryEntry' }]);
      expect(result.args).toBeUndefined();
    });

    it('round-trips messageProperties with complex args (ArgsIsArray + PropertiesInArray)', () => {
      const entry: NrbfObject = { members: { _key: 'k', _value: 'v' }, typeName: 'DictionaryEntry' };
      const call: NrbfMethodCall = {
        args: [{ members: { id: 7 }, typeName: 'Payload' }],
        kind: 'MethodCall',
        messageProperties: [entry],
        methodName: 'Send',
        typeName: 'IService',
      };
      const result = roundTripCall(call);
      expect(result.args).toMatchObject([{ members: { id: 7 }, typeName: 'Payload' }]);
      expect(result.messageProperties).toMatchObject([{ members: { _key: 'k', _value: 'v' }, typeName: 'DictionaryEntry' }]);
    });

    it('round-trips messageProperties with NrbfObject callContext (ContextInArray + PropertiesInArray)', () => {
      const entry: NrbfObject = { members: { _key: 'tid', _value: 't1' }, typeName: 'DictionaryEntry' };
      const call: NrbfMethodCall = {
        callContext: { libraryName: 'mscorlib', members: { id: 'ctx' }, typeName: 'System.Runtime.Remoting.Messaging.LogicalCallContext' },
        kind: 'MethodCall',
        messageProperties: [entry],
        methodName: 'M',
        typeName: 'T',
      };
      const result = roundTripCall(call);
      expect(result.callContext).toMatchObject({ members: { id: 'ctx' } });
      expect(result.messageProperties).toMatchObject([{ members: { _key: 'tid', _value: 't1' }, typeName: 'DictionaryEntry' }]);
    });
  });

  describe('NrbfArray — multi-dimensional / offset / jagged arrays', () => {
    function roundTripArr(arr: NrbfArray): NrbfArray {
      return deserialize(serialize(arr)) as NrbfArray;
    }

    it('round-trips a Rectangular 2×3 Int32 array', () => {
      const arr: NrbfArray = {
        arrayType: BinaryArrayTypeEnumeration.Rectangular,
        elementBinaryType: BinaryTypeEnumeration.Primitive,
        elementPrimitiveType: PrimitiveTypeEnumeration.Int32,
        elements: [1, 2, 3, 4, 5, 6],
        lengths: [2, 3],
      };
      const result = roundTripArr(arr);
      expect(result.arrayType).toBe(BinaryArrayTypeEnumeration.Rectangular);
      expect(result.lengths).toEqual([2, 3]);
      expect(result.lowerBounds).toBeUndefined();
      expect(result.elementBinaryType).toBe(BinaryTypeEnumeration.Primitive);
      expect(result.elementPrimitiveType).toBe(PrimitiveTypeEnumeration.Int32);
      expect(result.elements).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('round-trips a Rectangular 3×2 String array', () => {
      const arr: NrbfArray = {
        arrayType: BinaryArrayTypeEnumeration.Rectangular,
        elementBinaryType: BinaryTypeEnumeration.String,
        elements: ['a', 'b', 'c', 'd', 'e', 'f'],
        lengths: [3, 2],
      };
      const result = roundTripArr(arr);
      expect(result.arrayType).toBe(BinaryArrayTypeEnumeration.Rectangular);
      expect(result.lengths).toEqual([3, 2]);
      expect(result.elements).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    });

    it('round-trips a Rectangular array with null elements', () => {
      const arr: NrbfArray = {
        arrayType: BinaryArrayTypeEnumeration.Rectangular,
        elementBinaryType: BinaryTypeEnumeration.Object,
        elements: ['hello', null, null, 'world'],
        lengths: [2, 2],
      };
      const result = roundTripArr(arr);
      expect(result.elements).toEqual(['hello', null, null, 'world']);
    });

    it('round-trips a Jagged array', () => {
      const arr: NrbfArray = {
        arrayType: BinaryArrayTypeEnumeration.Jagged,
        elementBinaryType: BinaryTypeEnumeration.ObjectArray,
        elements: [[1, 2], [3, 4, 5], [6]],
        lengths: [3],
      };
      const result = roundTripArr(arr);
      expect(result.arrayType).toBe(BinaryArrayTypeEnumeration.Jagged);
      expect(result.lengths).toEqual([3]);
      expect(result.elements).toEqual([[1, 2], [3, 4, 5], [6]]);
    });

    it('round-trips a SingleOffset array with lower bound', () => {
      const arr: NrbfArray = {
        arrayType: BinaryArrayTypeEnumeration.SingleOffset,
        elementBinaryType: BinaryTypeEnumeration.String,
        elements: ['a', 'b', 'c'],
        lengths: [3],
        lowerBounds: [5],
      };
      const result = roundTripArr(arr);
      expect(result.arrayType).toBe(BinaryArrayTypeEnumeration.SingleOffset);
      expect(result.lengths).toEqual([3]);
      expect(result.lowerBounds).toEqual([5]);
      expect(result.elements).toEqual(['a', 'b', 'c']);
    });

    it('round-trips a RectangularOffset array with lower bounds', () => {
      const arr: NrbfArray = {
        arrayType: BinaryArrayTypeEnumeration.RectangularOffset,
        elementBinaryType: BinaryTypeEnumeration.Primitive,
        elementPrimitiveType: PrimitiveTypeEnumeration.Int32,
        elements: [10, 20, 30, 40],
        lengths: [2, 2],
        lowerBounds: [1, 1],
      };
      const result = roundTripArr(arr);
      expect(result.arrayType).toBe(BinaryArrayTypeEnumeration.RectangularOffset);
      expect(result.lengths).toEqual([2, 2]);
      expect(result.lowerBounds).toEqual([1, 1]);
      expect(result.elements).toEqual([10, 20, 30, 40]);
    });

    it('round-trips a JaggedOffset array with lower bound', () => {
      const arr: NrbfArray = {
        arrayType: BinaryArrayTypeEnumeration.JaggedOffset,
        elementBinaryType: BinaryTypeEnumeration.ObjectArray,
        elements: [[1, 2, 3], [4, 5]],
        lengths: [2],
        lowerBounds: [10],
      };
      const result = roundTripArr(arr);
      expect(result.arrayType).toBe(BinaryArrayTypeEnumeration.JaggedOffset);
      expect(result.lengths).toEqual([2]);
      expect(result.lowerBounds).toEqual([10]);
      expect(result.elements).toEqual([[1, 2, 3], [4, 5]]);
    });

    it('round-trips an NrbfArray as a class member', () => {
      const matrix: NrbfArray = {
        arrayType: BinaryArrayTypeEnumeration.Rectangular,
        elementBinaryType: BinaryTypeEnumeration.Primitive,
        elementPrimitiveType: PrimitiveTypeEnumeration.Double,
        elements: [1.0, 2.0, 3.0, 4.0],
        lengths: [2, 2],
      };
      const obj: NrbfObject = { members: { data: matrix }, typeName: 'Grid' };
      const result = deserialize(serialize(obj)) as NrbfObject;
      const data = result.members['data'] as NrbfArray;
      expect(data.arrayType).toBe(BinaryArrayTypeEnumeration.Rectangular);
      expect(data.lengths).toEqual([2, 2]);
      expect(data.elements).toEqual([1.0, 2.0, 3.0, 4.0]);
    });

    it('emits correct BinaryArray record header for Rectangular', () => {
      const arr: NrbfArray = {
        arrayType: BinaryArrayTypeEnumeration.Rectangular,
        elementBinaryType: BinaryTypeEnumeration.Primitive,
        elementPrimitiveType: PrimitiveTypeEnumeration.Int32,
        elements: [1, 2, 3, 4, 5, 6],
        lengths: [2, 3],
      };
      const buf = serialize(arr);
      const idx = buf.indexOf(RecordTypeEnumeration.BinaryArray);
      expect(idx).toBeGreaterThan(-1);
      // layout: record(1) + objectId(4) + arrayType(1) + rank(4) + lengths[0](4) + lengths[1](4) + ...
      expect(buf[idx + 5]).toBe(BinaryArrayTypeEnumeration.Rectangular); // arrayType
      expect(buf.readInt32LE(idx + 6)).toBe(2);  // rank = 2
      expect(buf.readInt32LE(idx + 10)).toBe(2); // lengths[0] = 2
      expect(buf.readInt32LE(idx + 14)).toBe(3); // lengths[1] = 3
    });

    it('round-trips a Rectangular NrbfArray with SystemClass element type', () => {
      // Covers serialize.ts lines 614–616: SystemClass branch writes elementClassName LPS.
      const arr: NrbfArray = {
        arrayType: BinaryArrayTypeEnumeration.Rectangular,
        elementBinaryType: BinaryTypeEnumeration.SystemClass,
        elementClassName: 'System.Exception',
        elements: [
          { members: { _message: 'oops' }, typeName: 'System.Exception' } as NrbfObject,
          null,
        ],
        lengths: [2, 1],
      };
      const result = roundTripArr(arr);
      expect(result.arrayType).toBe(BinaryArrayTypeEnumeration.Rectangular);
      expect(result.elementBinaryType).toBe(BinaryTypeEnumeration.SystemClass);
      expect(result.elementClassName).toBe('System.Exception');
      expect((result.elements[0] as NrbfObject).members['_message']).toBe('oops');
      expect(result.elements[1]).toBeNull();
    });

    it('round-trips a Rectangular NrbfArray with Class element type', () => {
      // Covers serialize.ts lines 617–620: Class branch writes elementClassName LPS + libraryId INT32.
      // Also exercises collectLibraries line 335: elementLibraryName registration.
      const lib = 'MyAssembly, Version=1.0.0.0';
      const arr: NrbfArray = {
        arrayType: BinaryArrayTypeEnumeration.Rectangular,
        elementBinaryType: BinaryTypeEnumeration.Class,
        elementClassName: 'MyNamespace.MyClass',
        elementLibraryName: lib,
        elements: [
          { libraryName: lib, members: { value: 1 }, typeName: 'MyNamespace.MyClass' } as NrbfObject,
          null,
        ],
        lengths: [2, 1],
      };
      const result = roundTripArr(arr);
      expect(result.arrayType).toBe(BinaryArrayTypeEnumeration.Rectangular);
      expect(result.elementBinaryType).toBe(BinaryTypeEnumeration.Class);
      expect(result.elementClassName).toBe('MyNamespace.MyClass');
      expect(result.elementLibraryName).toBe(lib);
      expect((result.elements[0] as NrbfObject).members['value']).toBe(1);
      expect(result.elements[1]).toBeNull();
    });

    it('byte-exact round-trip of object_graph.nrbf (contains RectangularOffset matrix)', () => {
      const buf = readFileSync(join(fixturesDir, 'object_graph.nrbf'));
      // The matrix member uses RectangularOffset — verify serialize produces identical bytes
      const reserialized = serialize(deserialize(buf));
      // object_graph has circular refs so we can't do byte-exact (re-serialized MemberReference
      // order may differ), but we verify the matrix element values survive the round-trip.
      const root = deserialize(reserialized) as NrbfObject;
      const matrix = root.members['Matrix'] as NrbfArray;
      expect(matrix.arrayType).toBe(BinaryArrayTypeEnumeration.RectangularOffset);
      expect(matrix.elements).toEqual([11, 12, 13, 21, 22, 23]);
    });
  });

  describe('DateTime in mixed JS array (ArraySingleObject path)', () => {
    it('round-trips a DateTime element alongside a string in an ArraySingleObject', () => {
      const dt: DateTime = { kind: 1, ticks: 637_000_000_000_000_000n };
      const result = roundTrip([dt, 'hello']) as NrbfValue[];
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(dt);
      expect(result[1]).toBe('hello');
    });

    it('round-trips a DateTime element alongside null', () => {
      const dt: DateTime = { kind: 0, ticks: 0n };
      const result = roundTrip([dt, null]) as NrbfValue[];
      expect(result[0]).toEqual(dt);
      expect(result[1]).toBeNull();
    });
  });

  describe('defensive ?? fallbacks', () => {
    it('round-trips a class with no members (empty writeMemberTypeInfo — line 502 branch)', () => {
      // writeMemberTypeInfo is called with an empty entries array; the for-loop bodies are never entered.
      const obj: NrbfObject = { members: {}, typeName: 'Empty' };
      const result = roundTrip(obj) as NrbfObject;
      expect(result.typeName).toBe('Empty');
      expect(result.members).toEqual({});
    });

    it('ClassWithId fills missing member with null (line 540 ?? null branch)', () => {
      // obj2 shares a type key with obj1 but omits "label".
      // The ClassWithId write loop hits obj2.members["label"] === undefined → ?? null → ObjectNull.
      const obj1: NrbfObject = { members: { label: 'hello', x: 1 }, typeName: 'T' };
      const obj2: NrbfObject = { members: { x: 2 }, typeName: 'T' };
      const root: NrbfObject = { members: { a: obj1, b: obj2 }, typeName: 'Root' };
      const result = deserialize(serialize(root)) as NrbfObject;
      const b = result.members['b'] as NrbfObject;
      expect(b.members['x']).toBe(2);
      expect(b.members['label']).toBeNull();
    });

    it('NrbfArray with Class element type and no elementLibraryName uses library ID 0 (line 619 ?? 0 branch)', () => {
      // collectLibraries sees elementLibraryName=undefined → nothing registered.
      // writeNrbfArray hits libraryIds.get(undefined) ?? 0 → writes libraryId 0.
      // readBinaryArray: libraries.get(0) = undefined → elementLibraryName stays unset.
      const arr: NrbfArray = {
        arrayType: BinaryArrayTypeEnumeration.Rectangular,
        elementBinaryType: BinaryTypeEnumeration.Class,
        elementClassName: 'SomeType',
        elements: [],
        lengths: [0, 0],
      };
      const result = deserialize(serialize(arr)) as NrbfArray;
      expect(result.arrayType).toBe(BinaryArrayTypeEnumeration.Rectangular);
      expect(result.elementBinaryType).toBe(BinaryTypeEnumeration.Class);
      expect(result.elementClassName).toBe('SomeType');
      expect(result.elementLibraryName).toBeUndefined();
      expect(result.elements).toEqual([]);
    });
  });

  describe('semantic round-trip — alternative wire encodings', () => {
    // Verify that streams using ClassWithMembers / SystemClassWithMembers / ArgsInArray
    // decode correctly and that re-serialization preserves content even though the
    // serializer always emits the canonical WithTypes / ArgsIsArray / ArgsInline variants.
    function i32r(n: number): number[] {
      const b = Buffer.alloc(4);
      b.writeInt32LE(n, 0);
      return [...b];
    }
    function lpsr(s: string): number[] {
      const encoded = Buffer.from(s, 'utf8');
      const len = encoded.length;
      return len < 128 ? [len, ...encoded] : [(len & 0x7f) | 0x80, len >> 7, ...encoded];
    }
    function bufr(...parts: number[][]): Buffer {
      return Buffer.from(parts.flat());
    }
    const MEND = [0x0b];
    function hdr(rootId: number): number[] {
      return [0x00, ...i32r(rootId), ...i32r(-1), ...i32r(1), ...i32r(0)];
    }

    it('SystemClassWithMembers re-encodes as SystemClassWithMembersAndTypes — content preserved', () => {
      // SystemClassWithMembers carries no member type info; the serializer re-emits it as
      // SystemClassWithMembersAndTypes (type info inferred from values), so bytes differ.
      const stream = bufr(
        hdr(1),
        [0x02, ...i32r(1), ...lpsr('MyLib.Point'), ...i32r(2), ...lpsr('X'), ...lpsr('Y')],
        [0x08, 0x08, ...i32r(10)],  // X: MemberPrimitiveTyped Int32=10
        [0x08, 0x08, ...i32r(20)],  // Y: MemberPrimitiveTyped Int32=20
        MEND,
      );
      const first = deserialize(stream) as NrbfObject;
      const reencoded = deserialize(serialize(first)) as NrbfObject;
      expect(reencoded.typeName).toBe('MyLib.Point');
      expect(reencoded.libraryName).toBeUndefined();
      expect(reencoded.members['X']).toBe(10);
      expect(reencoded.members['Y']).toBe(20);
      expect(serialize(reencoded)).not.toEqual(stream);
    });

    it('ClassWithMembers re-encodes as ClassWithMembersAndTypes — content preserved', () => {
      // ClassWithMembers carries no member type info; the serializer re-emits it as
      // ClassWithMembersAndTypes (type info inferred from values), so bytes differ.
      const stream = bufr(
        hdr(1),
        [0x0c, ...i32r(2), ...lpsr('Acme.Lib')],  // BinaryLibrary id=2
        [0x03, ...i32r(1), ...lpsr('Acme.Widget'), ...i32r(1), ...lpsr('Label'), ...i32r(2)],
        [0x06, ...i32r(3), ...lpsr('Hello')],      // member "Label": BinaryObjectString
        MEND,
      );
      const first = deserialize(stream) as NrbfObject;
      const reencoded = deserialize(serialize(first)) as NrbfObject;
      expect(reencoded.typeName).toBe('Acme.Widget');
      expect(reencoded.libraryName).toBe('Acme.Lib');
      expect(reencoded.members['Label']).toBe('Hello');
      expect(serialize(reencoded)).not.toEqual(stream);
    });

    it('MethodCall ArgsInArray re-encodes as ArgsInline — content preserved', () => {
      // ArgsInArray wraps args in a nested sub-array (element 0 of the call array).
      // After deserialization the args are a plain JS array; simple args re-serialize as
      // ArgsInline (no call array at all), so bytes differ.
      // flags = NoContext(0x10) | ArgsInArray(0x08) = 0x18
      const stream = bufr(
        hdr(1),
        [0x15, ...i32r(0x18), 0x12, ...lpsr('DoWork'), 0x12, ...lpsr('ISvc')],  // MethodCall
        [0x10, ...i32r(1), ...i32r(1)],   // outer call array: id=1, length=1
        [0x10, ...i32r(2), ...i32r(2),    // nested args sub-array: id=2, length=2
          0x06, ...i32r(3), ...lpsr('hello'),  // arg 0: "hello"
          0x08, 0x08, ...i32r(42)],            // arg 1: Int32 42
        MEND,
      );
      const first = deserialize(stream) as NrbfMethodCall;
      expect(first.args).toEqual(['hello', 42]);
      const reencoded = deserialize(serialize(first)) as NrbfMethodCall;
      expect(reencoded.kind).toBe('MethodCall');
      expect(reencoded.methodName).toBe('DoWork');
      expect(reencoded.typeName).toBe('ISvc');
      expect(reencoded.args).toEqual(['hello', 42]);
      expect(serialize(reencoded)).not.toEqual(stream);
    });
  });
});
