import { describe, expect, it } from 'vitest';
import { PrimitiveTypeEnumeration } from './enums.js';
import { BinaryReader } from './reader.js';

function reader(...bytes: number[]): BinaryReader {
  return new BinaryReader(Buffer.from(bytes));
}

describe('BinaryReader', () => {
  describe('position / remaining', () => {
    it('starts at 0', () => {
      expect(reader(0x01, 0x02).position).toBe(0);
    });

    it('tracks position after reads', () => {
      const r = reader(0x01, 0x02, 0x03);
      r.readByte();
      expect(r.position).toBe(1);
      expect(r.remaining).toBe(2);
    });
  });

  describe('bounds checking', () => {
    it('throws on read past end', () => {
      expect(() => reader().readByte()).toThrow(RangeError);
      expect(() => reader(0x01).readInt32()).toThrow(RangeError);
    });
  });

  describe('readByte / readSByte', () => {
    it('reads unsigned byte', () => {
      expect(reader(0xff).readByte()).toBe(255);
      expect(reader(0x00).readByte()).toBe(0);
    });

    it('reads signed byte', () => {
      expect(reader(0xff).readSByte()).toBe(-1);
      expect(reader(0x7f).readSByte()).toBe(127);
    });
  });

  describe('readBoolean', () => {
    it('returns false for 0, true for non-zero', () => {
      expect(reader(0x00).readBoolean()).toBe(false);
      expect(reader(0x01).readBoolean()).toBe(true);
      expect(reader(0xff).readBoolean()).toBe(true);
    });
  });

  describe('readInt16 / readUInt16', () => {
    it('reads little-endian 16-bit values', () => {
      expect(reader(0x00, 0x80).readInt16()).toBe(-32768);
      expect(reader(0xff, 0x7f).readInt16()).toBe(32767);
      expect(reader(0xff, 0xff).readUInt16()).toBe(65535);
    });
  });

  describe('readInt32 / readUInt32', () => {
    it('reads little-endian 32-bit values', () => {
      expect(reader(0x01, 0x00, 0x00, 0x00).readInt32()).toBe(1);
      expect(reader(0xff, 0xff, 0xff, 0x7f).readInt32()).toBe(2147483647);
      expect(reader(0x00, 0x00, 0x00, 0x80).readInt32()).toBe(-2147483648);
      expect(reader(0xff, 0xff, 0xff, 0xff).readUInt32()).toBe(4294967295);
    });
  });

  describe('readInt64 / readUInt64', () => {
    it('reads little-endian 64-bit values', () => {
      expect(reader(0x01, 0, 0, 0, 0, 0, 0, 0).readInt64()).toBe(1n);
      expect(reader(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff).readInt64()).toBe(-1n);
      expect(reader(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff).readUInt64()).toBe(18446744073709551615n);
    });
  });

  describe('readSingle / readDouble', () => {
    it('reads IEEE 754 floats', () => {
      const singleBuf = Buffer.allocUnsafe(4);
      singleBuf.writeFloatLE(1.5, 0);
      expect(new BinaryReader(singleBuf).readSingle()).toBe(1.5);

      const doubleBuf = Buffer.allocUnsafe(8);
      doubleBuf.writeDoubleLE(Math.PI, 0);
      expect(new BinaryReader(doubleBuf).readDouble()).toBe(Math.PI);
    });
  });

  describe('readLengthPrefixedString', () => {
    it('reads empty string', () => {
      expect(reader(0x00).readLengthPrefixedString()).toBe('');
    });

    it('reads short ASCII string (length < 128)', () => {
      expect(reader(0x02, 0x68, 0x69).readLengthPrefixedString()).toBe('hi');
    });

    it('reads string with 2-byte length prefix (length 128–16383)', () => {
      const bytes = [0x80, 0x01, ...Array<number>(128).fill(0x41)];
      expect(reader(...bytes).readLengthPrefixedString()).toBe('A'.repeat(128));
    });

    it('reads string with 3-byte length prefix (length 16384+)', () => {
      const bytes = [0x80, 0x80, 0x01, ...Array<number>(16384).fill(0x42)];
      expect(reader(...bytes).readLengthPrefixedString()).toBe('B'.repeat(16384));
    });

    it('reads UTF-8 string', () => {
      const encoded = Buffer.from('héllo', 'utf8');
      const prefix = [encoded.length];
      expect(new BinaryReader(Buffer.concat([Buffer.from(prefix), encoded])).readLengthPrefixedString()).toBe('héllo');
    });
  });

  describe('readChar', () => {
    it('reads 1-byte ASCII character', () => {
      expect(reader(0x41).readChar()).toBe('A');
    });

    it('reads 2-byte UTF-8 character', () => {
      expect(reader(0xc3, 0xa9).readChar()).toBe('é');
    });

    it('reads 3-byte UTF-8 character', () => {
      expect(reader(0xe2, 0x82, 0xac).readChar()).toBe('€');
    });

    it('reads 4-byte UTF-8 character', () => {
      expect(reader(0xf0, 0x9d, 0x84, 0x9e).readChar()).toBe('𝄞');
    });

    it('throws on invalid UTF-8 leading byte', () => {
      expect(() => reader(0x80).readChar()).toThrow(RangeError);
    });
  });

  describe('readDateTime', () => {
    it('decodes kind=UTC(1) with ticks=0', () => {
      // raw = 1n << 62n → LE bytes: [0,0,0,0,0,0,0,0x40]
      const dt = reader(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40).readDateTime();
      expect(dt.ticks).toBe(0n);
      expect(dt.kind).toBe(1);
    });

    it('decodes kind=Unspecified(0) with ticks=1', () => {
      const dt = reader(0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00).readDateTime();
      expect(dt.ticks).toBe(1n);
      expect(dt.kind).toBe(0);
    });

    it('decodes kind=Local(2) — high bits 10', () => {
      // kind=2 → 2n << 62n = 0x8000000000000000n → LE bytes: [0,0,0,0,0,0,0,0x80]
      const dt = reader(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80).readDateTime();
      expect(dt.ticks).toBe(0n);
      expect(dt.kind).toBe(2);
    });

    it('decodes max ticks (62-bit all-ones) with kind=Unspecified', () => {
      // 0x3fffffffffffffff LE = [0xff,0xff,0xff,0xff,0xff,0xff,0xff,0x3f]
      const dt = reader(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x3f).readDateTime();
      expect(dt.ticks).toBe(0x3fffffffffffffffn);
      expect(dt.kind).toBe(0);
    });

  });

  describe('TimeSpan', () => {
    it('reads 1 second as positive ticks (readInt64)', () => {
      expect(reader(0x80, 0x96, 0x98, 0x00, 0x00, 0x00, 0x00, 0x00).readPrimitive(PrimitiveTypeEnumeration.TimeSpan))
        .toBe(10_000_000n);
    });

    it('reads negative TimeSpan ticks', () => {
      // -1 tick → two's-complement 64-bit → all 0xff
      expect(reader(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff).readPrimitive(PrimitiveTypeEnumeration.TimeSpan))
        .toBe(-1n);
    });

    it('reads zero TimeSpan', () => {
      expect(reader(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00).readPrimitive(PrimitiveTypeEnumeration.TimeSpan))
        .toBe(0n);
    });
  });

  describe('readPrimitive', () => {
    it('dispatches Boolean', () => {
      expect(reader(0x01).readPrimitive(PrimitiveTypeEnumeration.Boolean)).toBe(true);
    });

    it('dispatches Int32', () => {
      expect(reader(0x05, 0x00, 0x00, 0x00).readPrimitive(PrimitiveTypeEnumeration.Int32)).toBe(5);
    });

    it('dispatches Null to null', () => {
      expect(reader().readPrimitive(PrimitiveTypeEnumeration.Null)).toBeNull();
    });

    it('dispatches String to readLengthPrefixedString', () => {
      expect(reader(0x02, 0x68, 0x69).readPrimitive(PrimitiveTypeEnumeration.String)).toBe('hi');
    });

    it('dispatches UInt64 to bigint', () => {
      expect(
        reader(0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00).readPrimitive(PrimitiveTypeEnumeration.UInt64),
      ).toBe(1n);
    });

    it('dispatches Byte', () => {
      expect(reader(0xff).readPrimitive(PrimitiveTypeEnumeration.Byte)).toBe(255);
    });

    it('dispatches Char', () => {
      expect(reader(0x41).readPrimitive(PrimitiveTypeEnumeration.Char)).toBe('A');
    });

    it('dispatches Decimal to string', () => {
      expect(reader(0x05, 0x31, 0x32, 0x2e, 0x33, 0x34).readPrimitive(PrimitiveTypeEnumeration.Decimal)).toBe('12.34');
    });

    it('dispatches Double', () => {
      const buf = Buffer.allocUnsafe(8);
      buf.writeDoubleLE(Math.PI, 0);
      expect(new BinaryReader(buf).readPrimitive(PrimitiveTypeEnumeration.Double)).toBeCloseTo(Math.PI);
    });

    it('dispatches Int16', () => {
      expect(reader(0x00, 0x80).readPrimitive(PrimitiveTypeEnumeration.Int16)).toBe(-32768);
    });

    it('dispatches Int64', () => {
      expect(reader(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff).readPrimitive(PrimitiveTypeEnumeration.Int64)).toBe(-1n);
    });

    it('dispatches SByte', () => {
      expect(reader(0xff).readPrimitive(PrimitiveTypeEnumeration.SByte)).toBe(-1);
    });

    it('dispatches Single', () => {
      const buf = Buffer.allocUnsafe(4);
      buf.writeFloatLE(1.5, 0);
      expect(new BinaryReader(buf).readPrimitive(PrimitiveTypeEnumeration.Single)).toBeCloseTo(1.5);
    });

    it('dispatches TimeSpan to bigint ticks', () => {
      expect(reader(0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00).readPrimitive(PrimitiveTypeEnumeration.TimeSpan)).toBe(1n);
    });

    it('dispatches DateTime', () => {
      // kind=UTC(1) packed as 1n << 62n → ticks=0, kind=1
      const dt = reader(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40).readPrimitive(PrimitiveTypeEnumeration.DateTime);
      expect(dt).toMatchObject({ ticks: 0n, kind: 1 });
    });

    it('dispatches UInt16', () => {
      expect(reader(0xff, 0xff).readPrimitive(PrimitiveTypeEnumeration.UInt16)).toBe(65535);
    });

    it('dispatches UInt32', () => {
      expect(reader(0xff, 0xff, 0xff, 0xff).readPrimitive(PrimitiveTypeEnumeration.UInt32)).toBe(4_294_967_295);
    });

    it('unknown type → RangeError', () => {
      expect(() => reader().readPrimitive(99 as PrimitiveTypeEnumeration)).toThrow(RangeError);
    });
  });
});
