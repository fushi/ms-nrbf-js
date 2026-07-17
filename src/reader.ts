import { PrimitiveTypeEnumeration } from './enums.js';
import { DateTime, PrimitiveValue } from './types.js';

export class BinaryReader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  private need(n: number): void {
    if (this.offset + n > this.buf.length) {
      throw new RangeError(
        `BinaryReader: need ${n} byte(s) at offset ${this.offset}, only ${this.buf.length - this.offset} remaining`,
      );
    }
  }

  readByte(): number {
    this.need(1);
    return this.buf.readUInt8(this.offset++);
  }

  readSByte(): number {
    this.need(1);
    return this.buf.readInt8(this.offset++);
  }

  readBoolean(): boolean {
    return this.readByte() !== 0;
  }

  readInt16(): number {
    this.need(2);
    const v = this.buf.readInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  readUInt16(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  readInt32(): number {
    this.need(4);
    const v = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readUInt32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  readInt64(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  readUInt64(): bigint {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  readSingle(): number {
    this.need(4);
    const v = this.buf.readFloatLE(this.offset);
    this.offset += 4;
    return v;
  }

  readDouble(): number {
    this.need(8);
    const v = this.buf.readDoubleLE(this.offset);
    this.offset += 8;
    return v;
  }

  readBytes(count: number): Buffer {
    this.need(count);
    const slice = this.buf.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  // §2.1.1.6 — length prefix is 1–5 bytes, each byte contributes 7 bits (little-endian);
  // high bit signals a continuation byte follows.
  readLengthPrefixedString(): string {
    let length = 0;
    let shift = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.readByte();
      length |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return this.readBytes(length).toString('utf8');
  }

  // §2.1.1.1 — UTF-8 encoded Unicode character; first byte determines total byte count.
  readChar(): string {
    const first = this.readByte();
    let extra: number;
    if ((first & 0x80) === 0) extra = 0;
    else if ((first & 0xe0) === 0xc0) extra = 1;
    else if ((first & 0xf0) === 0xe0) extra = 2;
    else if ((first & 0xf8) === 0xf0) extra = 3;
    else
      throw new RangeError(
        `BinaryReader: invalid UTF-8 leading byte 0x${first.toString(16)} at offset ${this.offset - 1}`,
      );

    const bytes = Buffer.alloc(1 + extra);
    bytes[0] = first;
    for (let i = 1; i <= extra; i++) bytes[i] = this.readByte();
    return bytes.toString('utf8');
  }

  // §2.1.1.5 — 64-bit little-endian: low 62 bits are ticks, high 2 bits are Kind.
  readDateTime(): DateTime {
    const raw = this.readUInt64();
    return {
      kind: Number(raw >> 62n),
      ticks: raw & 0x3fffffffffffffffn,
    };
  }

  // Reads a single primitive value whose type is determined by the PrimitiveTypeEnumeration.
  readPrimitive(primitiveType: PrimitiveTypeEnumeration): PrimitiveValue {
    switch (primitiveType) {
      case PrimitiveTypeEnumeration.Boolean:  return this.readBoolean();
      case PrimitiveTypeEnumeration.Byte:     return this.readByte();
      case PrimitiveTypeEnumeration.Char:     return this.readChar();
      case PrimitiveTypeEnumeration.Decimal:  return this.readLengthPrefixedString();
      case PrimitiveTypeEnumeration.Double:   return this.readDouble();
      case PrimitiveTypeEnumeration.Int16:    return this.readInt16();
      case PrimitiveTypeEnumeration.Int32:    return this.readInt32();
      case PrimitiveTypeEnumeration.Int64:    return this.readInt64();
      case PrimitiveTypeEnumeration.SByte:    return this.readSByte();
      case PrimitiveTypeEnumeration.Single:   return this.readSingle();
      case PrimitiveTypeEnumeration.TimeSpan: return this.readInt64();
      case PrimitiveTypeEnumeration.DateTime: return this.readDateTime();
      case PrimitiveTypeEnumeration.UInt16:   return this.readUInt16();
      case PrimitiveTypeEnumeration.UInt32:   return this.readUInt32();
      case PrimitiveTypeEnumeration.UInt64:   return this.readUInt64();
      case PrimitiveTypeEnumeration.Null:     return null;
      case PrimitiveTypeEnumeration.String:   return this.readLengthPrefixedString();
      default:
        throw new RangeError(`BinaryReader: unknown PrimitiveTypeEnumeration value ${String(primitiveType)}`);
    }
  }
}
