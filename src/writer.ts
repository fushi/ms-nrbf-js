import { PrimitiveTypeEnumeration } from "./enums.js";
import type { DateTime, PrimitiveValue } from "./types.js";

export class BinaryWriter {
  private readonly chunks: Buffer[] = [];

  private alloc(n: number): Buffer {
    const b = Buffer.allocUnsafe(n);
    this.chunks.push(b);
    return b;
  }

  writeByte(n: number): void {
    this.alloc(1).writeUInt8(n, 0);
  }

  writeSByte(n: number): void {
    this.alloc(1).writeInt8(n, 0);
  }

  writeBoolean(b: boolean): void {
    this.writeByte(b ? 1 : 0);
  }

  writeInt16(n: number): void {
    this.alloc(2).writeInt16LE(n, 0);
  }

  writeUInt16(n: number): void {
    this.alloc(2).writeUInt16LE(n, 0);
  }

  writeInt32(n: number): void {
    this.alloc(4).writeInt32LE(n, 0);
  }

  writeUInt32(n: number): void {
    this.alloc(4).writeUInt32LE(n, 0);
  }

  writeInt64(n: bigint): void {
    this.alloc(8).writeBigInt64LE(n, 0);
  }

  writeUInt64(n: bigint): void {
    this.alloc(8).writeBigUInt64LE(n, 0);
  }

  writeSingle(n: number): void {
    this.alloc(4).writeFloatLE(n, 0);
  }

  writeDouble(n: number): void {
    this.alloc(8).writeDoubleLE(n, 0);
  }

  // §2.1.1.6 — variable-length length prefix (1–5 bytes), then UTF-8 string body
  writeLengthPrefixedString(s: string): void {
    const body = Buffer.from(s, "utf8");
    let len = body.length;
    const prefix: number[] = [];
    do {
      const byte = len & 0x7f;
      len >>>= 7;
      prefix.push(len > 0 ? byte | 0x80 : byte);
    } while (len > 0);
    const buf = Buffer.allocUnsafe(prefix.length + body.length);
    Buffer.from(prefix).copy(buf, 0);
    body.copy(buf, prefix.length);
    this.chunks.push(buf);
  }

  // §2.1.1.1 — UTF-8 encode a single Unicode character (1–4 bytes, no length prefix)
  writeChar(s: string): void {
    this.chunks.push(Buffer.from(s, "utf8"));
  }

  // §2.1.1.5 — pack 62-bit ticks + 2-bit Kind into a little-endian UINT64
  writeDateTime(dt: DateTime): void {
    const raw = (dt.ticks & 0x3fffffffffffffffn) | (BigInt(dt.kind) << 62n);
    this.alloc(8).writeBigUInt64LE(raw, 0);
  }

  writePrimitive(type: PrimitiveTypeEnumeration, value: PrimitiveValue): void {
    switch (type) {
      case PrimitiveTypeEnumeration.Boolean:  this.writeBoolean(value as boolean); break;
      case PrimitiveTypeEnumeration.Byte:     this.writeByte(value as number); break;
      case PrimitiveTypeEnumeration.Char:     this.writeChar(value as string); break;
      case PrimitiveTypeEnumeration.Decimal:  this.writeLengthPrefixedString(value as string); break;
      case PrimitiveTypeEnumeration.Double:   this.writeDouble(value as number); break;
      case PrimitiveTypeEnumeration.Int16:    this.writeInt16(value as number); break;
      case PrimitiveTypeEnumeration.Int32:    this.writeInt32(value as number); break;
      case PrimitiveTypeEnumeration.Int64:    this.writeInt64(value as bigint); break;
      case PrimitiveTypeEnumeration.SByte:    this.writeSByte(value as number); break;
      case PrimitiveTypeEnumeration.Single:   this.writeSingle(value as number); break;
      case PrimitiveTypeEnumeration.TimeSpan: this.writeInt64(value as bigint); break;
      case PrimitiveTypeEnumeration.DateTime: this.writeDateTime(value as DateTime); break;
      case PrimitiveTypeEnumeration.UInt16:   this.writeUInt16(value as number); break;
      case PrimitiveTypeEnumeration.UInt32:   this.writeUInt32(value as number); break;
      case PrimitiveTypeEnumeration.UInt64:   this.writeUInt64(value as bigint); break;
      case PrimitiveTypeEnumeration.Null:     break; // no bytes
      case PrimitiveTypeEnumeration.String:   this.writeLengthPrefixedString(value as string); break;
      default: throw new RangeError(`Unknown PrimitiveTypeEnumeration: ${String(type)}`);
    }
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
