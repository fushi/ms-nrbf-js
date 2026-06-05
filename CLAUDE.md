# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

An NPM package that reads and writes binary files encoded in the [MS-NRBF](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-nrbf/) format (.NET Remoting Binary Format). The full specification is in `documents/[MS-NRBF].pdf`.

## Commands

Once the project is bootstrapped these will be the standard commands:

```bash
npm run build      # tsc — compiles src/ → dist/
npm run lint       # eslint src/
npm test           # vitest run
npm run test:watch # vitest
npm run coverage   # vitest run --coverage
```

To run a single test file:

```bash
npx vitest run src/path/to/file.test.ts
```

## Toolchain

- **TypeScript** — strict mode, ES2022 target, Node 18+
- **ESM only** — `"type": "module"` in package.json; no CJS output
- **Vitest** — tests colocated with source as `*.test.ts`; fixtures are real binary samples, not synthetic mocks of the binary format
- **ESLint** — flat config (`eslint.config.js`) with `typescript-eslint`; no Prettier
- **tsc only** — no bundler; `dist/` is the compiled output

## Architecture

The library has two top-level operations: **deserialize** (binary → JS object) and **serialize** (JS object → binary). Both are driven by the record structure defined in the MS-NRBF spec.

Key concepts from the spec to keep in mind:
- Every NRBF stream is a sequence of **records**, each beginning with a `RecordTypeEnum` byte
- Records reference each other by integer **object IDs** — the deserializer must maintain an ID-to-object map to resolve forward and back references
- **Class records** carry metadata (assembly name, class name, member names/types) that may be defined once and reused via reference records (`ClassWithId`)
- **Primitive types**, **arrays**, and **strings** each have their own record variants

Model record types as **discriminated unions** (a `type` field on each variant), not class hierarchies or dynamic dispatch. All public API types are exported from `src/index.ts`.

The spec PDF is the authoritative reference — consult it for any ambiguity about record layout, field widths, or encoding rules.
