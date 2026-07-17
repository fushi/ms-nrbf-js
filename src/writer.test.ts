import { describe, expect, it } from 'vitest';
import { PrimitiveTypeEnumeration } from './enums.js';
import { BinaryWriter } from './writer.js';

function writePrimitive(type: PrimitiveTypeEnumeration, value: unknown): Buffer {
  const w = new BinaryWriter();
  w.writePrimitive(type, value as never);
  return w.toBuffer();
}

describe('BinaryWriter', () => {
  describe('writePrimitive', () => {
    it('Boolean false → 0x00', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.Boolean, false)).toEqual(Buffer.from([0x00]));
    });

    it('Boolean true → 0x01', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.Boolean, true)).toEqual(Buffer.from([0x01]));
    });

    it('Byte → unsigned byte', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.Byte, 255)).toEqual(Buffer.from([0xff]));
      expect(writePrimitive(PrimitiveTypeEnumeration.Byte, 0)).toEqual(Buffer.from([0x00]));
    });

    it('Char (ASCII) → single byte', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.Char, 'A')).toEqual(Buffer.from([0x41]));
    });

    it('Char (multi-byte) → UTF-8 encoding', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.Char, 'é')).toEqual(Buffer.from([0xc3, 0xa9]));
    });

    it('Decimal → length-prefixed string', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.Decimal, '12.34')).toEqual(
        Buffer.from([0x05, 0x31, 0x32, 0x2e, 0x33, 0x34]),
      );
    });

    it('Double → 8-byte little-endian IEEE 754', () => {
      const buf = writePrimitive(PrimitiveTypeEnumeration.Double, Math.PI);
      expect(buf).toHaveLength(8);
      expect(buf.readDoubleLE(0)).toBeCloseTo(Math.PI);
    });

    it('Int16 → little-endian signed 16-bit', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.Int16, -32768)).toEqual(Buffer.from([0x00, 0x80]));
      expect(writePrimitive(PrimitiveTypeEnumeration.Int16, 32767)).toEqual(Buffer.from([0xff, 0x7f]));
    });

    it('Int32 → little-endian signed 32-bit', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.Int32, 1)).toEqual(Buffer.from([0x01, 0x00, 0x00, 0x00]));
      expect(writePrimitive(PrimitiveTypeEnumeration.Int32, -1)).toEqual(Buffer.from([0xff, 0xff, 0xff, 0xff]));
    });

    it('Int64 → little-endian signed 64-bit bigint', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.Int64, 1n)).toEqual(
        Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      );
      expect(writePrimitive(PrimitiveTypeEnumeration.Int64, -1n)).toEqual(
        Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      );
    });

    it('SByte → signed byte', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.SByte, -1)).toEqual(Buffer.from([0xff]));
      expect(writePrimitive(PrimitiveTypeEnumeration.SByte, 127)).toEqual(Buffer.from([0x7f]));
    });

    it('Single → 4-byte little-endian IEEE 754', () => {
      const buf = writePrimitive(PrimitiveTypeEnumeration.Single, 1.5);
      expect(buf).toHaveLength(4);
      expect(buf.readFloatLE(0)).toBeCloseTo(1.5);
    });

    it('TimeSpan → little-endian signed 64-bit bigint (ticks)', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.TimeSpan, 10_000_000n)).toEqual(
        Buffer.from([0x80, 0x96, 0x98, 0x00, 0x00, 0x00, 0x00, 0x00]),
      );
    });

    it('TimeSpan → negative ticks (two\'s complement)', () => {
      // -1 tick → all 0xff bytes
      expect(writePrimitive(PrimitiveTypeEnumeration.TimeSpan, -1n)).toEqual(
        Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      );
    });

    it('TimeSpan → zero', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.TimeSpan, 0n)).toEqual(
        Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      );
    });

    it('DateTime → packed 64-bit, kind=UTC(1)', () => {
      const buf = writePrimitive(PrimitiveTypeEnumeration.DateTime, { kind: 1, ticks: 0n });
      expect(buf).toHaveLength(8);
      expect(buf.readBigUInt64LE(0)).toBe(1n << 62n);
    });

    it('DateTime → packed 64-bit, kind=Local(2)', () => {
      // kind=2 → 2n << 62n = 0x8000000000000000n
      const buf = writePrimitive(PrimitiveTypeEnumeration.DateTime, { kind: 2, ticks: 0n });
      expect(buf.readBigUInt64LE(0)).toBe(2n << 62n);
    });

    it('DateTime → packed 64-bit, kind=Unspecified(0) with specific ticks', () => {
      const buf = writePrimitive(PrimitiveTypeEnumeration.DateTime, { kind: 0, ticks: 123_456_789n });
      expect(buf.readBigUInt64LE(0)).toBe(123_456_789n);
    });

    it('DateTime → packed 64-bit, max ticks (62-bit) preserved', () => {
      const maxTicks = 0x3fffffffffffffffn;
      const buf = writePrimitive(PrimitiveTypeEnumeration.DateTime, { kind: 0, ticks: maxTicks });
      expect(buf.readBigUInt64LE(0)).toBe(maxTicks);
    });

    it('Decimal → negative value', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.Decimal, '-99.5')).toEqual(
        Buffer.from([0x05, 0x2d, 0x39, 0x39, 0x2e, 0x35]),
      );
    });

    it('Decimal → zero', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.Decimal, '0')).toEqual(
        Buffer.from([0x01, 0x30]),
      );
    });

    it('UInt16 → little-endian unsigned 16-bit', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.UInt16, 65535)).toEqual(Buffer.from([0xff, 0xff]));
    });

    it('UInt32 → little-endian unsigned 32-bit', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.UInt32, 4_294_967_295)).toEqual(
        Buffer.from([0xff, 0xff, 0xff, 0xff]),
      );
    });

    it('UInt64 → little-endian unsigned 64-bit bigint', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.UInt64, 18_446_744_073_709_551_615n)).toEqual(
        Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      );
    });

    it('Null → empty buffer (no bytes written)', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.Null, null)).toEqual(Buffer.from([]));
    });

    it('String → length-prefixed UTF-8', () => {
      expect(writePrimitive(PrimitiveTypeEnumeration.String, 'hi')).toEqual(Buffer.from([0x02, 0x68, 0x69]));
    });

    it('unknown type → RangeError', () => {
      expect(() => writePrimitive(99 as PrimitiveTypeEnumeration, null)).toThrow(RangeError);
    });
  });

  describe('writeLengthPrefixedString', () => {
    function writeLPS(s: string): Buffer {
      const w = new BinaryWriter();
      w.writeLengthPrefixedString(s);
      return w.toBuffer();
    }

    it('2-byte length prefix for 128-byte string', () => {
      // 128 = 0b10000000 → LEB128: [0x80, 0x01]
      const s = 'a'.repeat(128);
      const buf = writeLPS(s);
      expect(buf[0]).toBe(0x80);
      expect(buf[1]).toBe(0x01);
      expect(buf.length).toBe(130);
      expect(buf.subarray(2).toString('utf8')).toBe(s);
    });

    it('2-byte length prefix for 16383-byte string (upper boundary)', () => {
      // 16383 = 0b11111111111111 → LEB128: [0xff, 0x7f]
      const s = 'b'.repeat(16383);
      const buf = writeLPS(s);
      expect(buf[0]).toBe(0xff);
      expect(buf[1]).toBe(0x7f);
      expect(buf.length).toBe(16385);
    });

    it('3-byte length prefix for 16384-byte string', () => {
      // 16384 = 0b100000000000000 → LEB128: [0x80, 0x80, 0x01]
      const s = 'c'.repeat(16384);
      const buf = writeLPS(s);
      expect(buf[0]).toBe(0x80);
      expect(buf[1]).toBe(0x80);
      expect(buf[2]).toBe(0x01);
      expect(buf.length).toBe(16387);
    });
  });
});
