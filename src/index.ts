export * from "./enums.js";
export * from "./types.js";
export * from "./records.js";

export function deserialize(_buffer: Buffer): unknown {
  throw new Error("Not implemented");
}

export function serialize(_value: unknown): Buffer {
  throw new Error("Not implemented");
}
