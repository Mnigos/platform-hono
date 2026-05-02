---
name: testing-vitest
description: Write or fix tests in this Bun + Vitest package using globals, focused Hono/Nest adapter assertions, and the repository verification scripts.
---

## Repository Test Setup

This package uses Bun and Vitest 4.

- Unit tests run with `bun run test`.
- Coverage runs with `bun run test:coverage`.
- Integration tests run with `bun run test:integration`.
- Type checking runs with `bun run typecheck`.
- Formatting/linting runs with `bun run check` or `bun run check:fix`.

`vitest.config.ts` excludes `tests/integration/**/*.integration.spec.ts`.
`vitest.integration.config.ts` includes only `tests/integration/**/*.integration.spec.ts`, disables file parallelism, and uses one worker.

## Vitest Globals

Vitest globals are enabled. Do not import `describe`, `test`, `expect`, `vi`, or hooks from `vitest`.

```typescript
// Wrong - unnecessary imports
import { describe, expect, test, vi } from 'vitest'
```

Use `test`, not `it`.

## Test Placement

- Put focused unit tests near the behavior they exercise, using `*.spec.ts`.
- Put tests that boot a server, bind ports, or exercise full request flow under `tests/integration/**/*.integration.spec.ts`.
- Prefer testing exported behavior from `src/index.ts` or public module exports. Reach into internal files only when the behavior is intentionally internal and difficult to verify through the public adapter.

## Spy Naming

Name spies after the method, suffixed with `Spy`.

```typescript
const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
const jsonSpy = vi.spyOn(ctx, 'json').mockReturnValue(response)

// Wrong - generic name
const spy = vi.spyOn(Logger.prototype, 'warn')
```

Set up `vi.spyOn()` before calling the function under test.

## Assertions

Assert inline when there is only one meaningful assertion against the value.

```typescript
expect(await adapter.reply(ctx, { ok: true })).toBeUndefined()
```

Use a named value only when it improves readability or supports multiple assertions.

```typescript
const response = await app.request('/health')

expect(response.status).toBe(200)
await expect(response.json()).resolves.toEqual({ ok: true })
```

## Error Testing

Use `.rejects` or `.toThrow`, not `try/catch`.

```typescript
await expect(adapter.reply(ctx, body)).rejects.toBeInstanceOf(Error)
expect(() => adapter.render()).toThrow('Method not implemented.')
```

For multiple async error assertions, store the promise.

```typescript
const promise = adapter.reply(ctx, body)

await expect(promise).rejects.toBeInstanceOf(Error)
await expect(promise).rejects.toMatchObject({ message: 'boom' })
```

## Mock Placement

Always put imports first. Write `vi.mock(...)` after imports, even though Vitest hoists mock calls.

Do not declare mock variables above imports. Prefer inline mock factories and assert through the mocked import.

```typescript
import { serveStatic } from '@hono/node-server/serve-static'

vi.mock('@hono/node-server/serve-static', () => ({
	serveStatic: vi.fn()
}))

vi.mocked(serveStatic).mockReturnValue(async () => undefined)
```

## Hono Adapter Tests

Prefer real Hono requests for route behavior.

```typescript
const adapter = new HonoAdapter()

adapter.get('/hello', (_req, ctx) => {
	return ctx.text('hello')
})

const response = await adapter.hono.request('/hello')

expect(response.status).toBe(200)
await expect(response.text()).resolves.toBe('hello')
```

For behavior that depends on Nest abstractions, use the smallest fake `Context` or request object needed. Keep the fake local to the spec unless the same shape repeats across multiple files.

## Cleanup

Use `afterEach` for mock cleanup.

```typescript
afterEach(() => {
	vi.restoreAllMocks()
})
```

Use `vi.clearAllMocks()` only when keeping the same mocked implementations matters. Close any servers started in integration tests.

## TypeScript Style In Tests

Follow the repository rules:

- Do not add explicit function or method return type annotations unless they are strictly needed.
- Prefer interfaces over type aliases for object shapes.
- Avoid `any`; test files allow it, but use `unknown`, narrow fakes, or imported types when reasonable.
- Match existing Biome formatting: tabs, single quotes, no semicolons.

## Anti-Patterns

- Importing Vitest globals.
- Using `it` instead of `test`.
- Generic spy names such as `const spy = ...`.
- Creating spies after the code under test has already run.
- `try/catch` for error testing.
- Over-building Nest testing modules for behavior that can be tested with the adapter or Hono directly.
- Leaving bound servers open in integration tests.
- Adding return type annotations just because a function is exported.

## Verification

```bash
bun run test
bun run test:integration
bun run typecheck
bun run check
```
