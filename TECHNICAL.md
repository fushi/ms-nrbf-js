# Technical Specification

## Language & Compilation

- **TypeScript** — all source files in `src/`, compiled to `dist/`
- Target: ES2022 (`Node 18+`)
- Strict mode on (`strict: true` in tsconfig)
- No `any` — use `unknown` and narrow explicitly

## Module Format

- **ESM only** — `"type": "module"` in package.json
- Single entry point: `dist/index.js` with a matching `dist/index.d.ts`
- No CJS build, no dual-format shims

## Testing

- **Vitest** — all tests live in `src/**/*.test.ts` alongside the code they test
- Coverage via `@vitest/coverage-v8`
- Test against real binary fixtures, not synthetic mocks of the binary format itself

## Dependencies

- **Runtime deps**: allowed if small, well-maintained, and genuinely reduce complexity — document the reason for each in package.json `"dependencies"`
- **Binary parsing**: use Node.js `Buffer` and `DataView` as the baseline; only reach for a library if the spec complexity demands it
- **Dev deps**: no restrictions

## What to Avoid

- Do **not** use CommonJS (`require`, `module.exports`, `.cjs` files)
- Do **not** use `any` or unsafe type casts
- Do **not** add runtime dependencies for things Node already provides (buffers, streams, file I/O)
- Do **not** use a bundler (webpack, rollup, esbuild) for the package output — tsc is sufficient
- Do **not** add a CLI layer unless the project scope changes

## Code Style

- **ESLint** — flat config (`eslint.config.js`), with `typescript-eslint` for TS-aware rules; no Prettier (format manually or via editor)
- Prefer explicit over clever: the NRBF spec has many record types; model them as discriminated unions, not dynamic dispatch
- All public API types exported from `src/index.ts`
