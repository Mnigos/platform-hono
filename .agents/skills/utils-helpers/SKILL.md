---
name: utils-helpers
description: Create, organize, and document reusable utilities or module-local helpers in this Hono adapter package.
---

## Repository Shape

This is a small TypeScript package with source files under `src/` and tests under `tests/`.

There is no path alias for shared utilities. Use relative imports inside `src/` and keep exports intentional through `src/index.ts`.

## Utils vs Helpers

Use a utility when the function is domain-agnostic and likely reusable across adapter behavior.

Examples:

- header normalization
- request size parsing
- path matching
- response finalization

Use a helper when the function supports one module's implementation detail and is not broadly useful yet.

Examples:

- body parser internals in `src/body-parser.ts`
- client IP extraction internals in `src/client-ip.ts`
- route registration internals in `src/hono-adapter.ts`

## When To Extract

Extract a function when:

- It is used in two or more places.
- It makes a public method easier to read.
- It can be tested as pure behavior without constructing the full adapter.
- It isolates a tricky edge case such as headers, body limits, path matching, or response state.

Keep logic inline when:

- It is short and only used once.
- Extracting it would hide the control flow.
- It depends heavily on `this` or adapter state.

Domain-neutral pure logic should usually be a standalone function instead of a private class method.

## File Organization

Prefer focused files in `src/` with kebab-case names.

```text
src/
	body-parser.ts
	client-ip.ts
	options.ts
	path-matching.ts
	response.ts
```

Do not add a generic `utils.ts` dumping ground. If a new helper group is needed, name the file after the behavior it owns.

## Exports

Only export from `src/index.ts` when the symbol is part of the package's public API.

Keep implementation helpers as local exports from their own files only when tests or nearby modules need them. Avoid widening the package API for test convenience.

## TypeScript Style

Follow the repository rules:

- Do not add explicit function or method return type annotations unless they are strictly needed, such as preserving a public contract, narrowing an inferred type, satisfying an override/interface requirement, or supporting recursive inference.
- Prefer interfaces over type aliases for object shapes.
- Use `unknown` and narrowing instead of `any`.
- Prefer early returns for validation and edge cases.
- Keep functions pure when practical.
- Match Biome formatting: tabs, single quotes, no semicolons.

```typescript
interface SizeLimitOptions {
	limit?: string | number
}

export function getLimitValue(options: SizeLimitOptions = {}) {
	if (!options.limit) return

	return options.limit
}
```

## Documentation

Use JSDoc for exported helpers when the behavior is not obvious from the name and types, or when the helper encodes edge cases that future maintainers need to preserve.

Avoid comments that merely restate the code.

```typescript
/**
 * Matches request paths against exact paths, wildcard routes, and regular expressions.
 * @param path - Incoming request path.
 * @param pattern - Path pattern to compare with.
 * @returns Whether the path matches the pattern.
 */
export function isPathMatch(path: string, pattern: string | RegExp) {
	if (pattern instanceof RegExp) return pattern.test(path)

	return path === pattern
}
```

## Pure Helpers

Prefer pure functions for reusable behavior.

```typescript
export function normalizeHeaderName(name: string) {
	return name.toLowerCase()
}
```

Avoid hidden mutation unless the surrounding framework API requires it. When mutation is required, keep it contained and name the function around the side effect.

## Anti-Patterns

- Adding a catch-all `src/utils.ts`.
- Moving one-off three-line logic into a new file.
- Exporting internals through `src/index.ts` only to make tests easier.
- Adding return type annotations that TypeScript can infer.
- Using `type` aliases for object shapes that should be interfaces.
- Adding comments instead of clearer names or focused JSDoc.
- Putting adapter-specific logic in a broadly named utility.

## Verification

```bash
bun run typecheck
bun run check
bun run test
```
