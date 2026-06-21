# ms-nrbf-js

Read and write binary files encoded in the [MS-NRBF](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-nrbf/) format (.NET Remoting Binary Format) — the wire format used by .NET's `BinaryFormatter`.

## Installation

```bash
npm install ms-nrbf-js
```

## Quick start

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { deserialize, serialize } from "ms-nrbf-js";

// Read
const root = deserialize(readFileSync("data.nrbf"));

// Write
writeFileSync("out.nrbf", serialize(root));
```

## API

### `deserialize(buf: Buffer): NrbfRoot`

Parses an NRBF byte buffer and returns the root value. The return type is `NrbfRoot`:

```ts
type NrbfRoot = NrbfValue | NrbfMethodCall | NrbfMethodReturn;
```

For typical object streams the result is an `NrbfValue`. For RPC streams it is an `NrbfMethodCall` or `NrbfMethodReturn`; check the `kind` discriminant:

```ts
import { deserialize } from "ms-nrbf-js";
import type { NrbfMethodCall, NrbfObject } from "ms-nrbf-js";

const root = deserialize(buf);

if (typeof root === "object" && root !== null && "kind" in root) {
  if (root.kind === "MethodCall") {
    const call = root as NrbfMethodCall;
    console.log(call.methodName, call.typeName, call.args);
  }
} else {
  const obj = root as NrbfObject;
  console.log(obj.typeName, obj.members);
}
```

### `serialize(root: NrbfRoot): Buffer`

Encodes a value tree (or method call/return) as an NRBF byte buffer. Circular object references are serialized as `MemberReference` records and round-trip correctly.

```ts
import { serialize } from "ms-nrbf-js";
import type { NrbfObject } from "ms-nrbf-js";

const obj: NrbfObject = {
  typeName: "MyApp.Config",
  libraryName: "MyApp, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null",
  members: {
    Host: "localhost",
    Port: 8080,
    Debug: false,
  },
};

const buf = serialize(obj);
```

## Value types

`NrbfValue` maps .NET types to JavaScript primitives:

| .NET type | JavaScript type |
|---|---|
| `null` | `null` |
| `Boolean` | `boolean` |
| `Byte`, `Int16`, `Int32`, `SByte`, `UInt16`, `Single`, `Double` | `number` |
| `Int64`, `UInt64`, `TimeSpan` | `bigint` |
| `Char`, `Decimal`, `String` | `string` |
| `DateTime` | `DateTime` (`{ ticks: bigint; kind: DateTimeKind }`) |
| Class / object | `NrbfObject` |
| Array | `NrbfValue[]` |

### `NrbfObject`

```ts
interface NrbfObject {
  typeName: string;
  libraryName?: string;       // absent for system-library classes
  memberTypes?: { [name: string]: PrimitiveTypeEnumeration };
  members: { [name: string]: NrbfValue };
}
```

`memberTypes` is populated by the deserializer to preserve exact primitive types (e.g. `Single` vs `Double`, `UInt32` vs `Int32`) and is used by the serializer to avoid lossy inference on round-trip. You can supply it yourself when constructing objects that need exact primitive typing:

```ts
import { PrimitiveTypeEnumeration } from "ms-nrbf-js";

const obj: NrbfObject = {
  typeName: "Stats",
  memberTypes: { ratio: PrimitiveTypeEnumeration.Single },
  members: { ratio: 3.14 },
};
```

### `NrbfMethodCall` / `NrbfMethodReturn`

```ts
interface NrbfMethodCall {
  kind: "MethodCall";
  methodName: string;
  typeName: string;
  callContext?: string;
  args?: NrbfValue[];
}

interface NrbfMethodReturn {
  kind: "MethodReturn";
  returnValue?: NrbfValue;
  callContext?: string;
  args?: NrbfValue[];
}
```

## Known limitations

- **Multi-dimensional arrays** (`BinaryArray` with rank > 1) are deserialized as flat `NrbfValue[]` in row-major order. Shape metadata is not preserved.
- **CJS** — this package is ESM-only (`"type": "module"`).

## License

MIT
