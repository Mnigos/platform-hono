# @mnigos/platform-hono

NestJS HTTP adapter for Hono.

This package provides the extracted Hono adapter used by `rigtch.fm`. It is
designed for Bun-first NestJS applications and keeps the adapter surface small:
`HonoAdapter`, `HonoAdapterOptions`, and the `NestHonoRequest` request type.

## Installation

```bash
bun add @mnigos/platform-hono hono @hono/node-server @nestjs/common @nestjs/core
```

`@nestjs/common`, `@nestjs/core`, `hono`, and `@hono/node-server` are peer
dependencies.

This package is ESM-only. CommonJS `require()` is not supported.

## Bootstrap

```ts
import { NestFactory } from '@nestjs/core'
import { HonoAdapter } from '@mnigos/platform-hono'
import { AppModule } from './app.module'

const adapter = new HonoAdapter()
const app = await NestFactory.create(AppModule, adapter)

await app.listen(3000)
```

## CORS

Use Nest's normal CORS API:

```ts
const adapter = new HonoAdapter()
const app = await NestFactory.create(AppModule, adapter)

app.enableCors({
	origin: 'https://example.com',
})
```

## Body Parsing

Request body parsing is enabled by default unless Nest is bootstrapped with
`bodyParser: false`.

The adapter parses JSON, text, form, and multipart request bodies and stores the
parsed value on `req.body` for Nest controllers and decorators.

```ts
const app = await NestFactory.create(AppModule, new HonoAdapter(), {
	bodyParser: false,
})
```

## Parser Skips

Use `skipBodyParserFor` for routes that need the original request stream, such
as better-auth or webhook endpoints:

```ts
const adapter = new HonoAdapter({
	skipBodyParserFor: ['/api/auth', '/webhooks/stripe'],
})
```

Path matching is segment-aware. A policy for `/api/auth` matches `/api/auth`
and `/api/auth/session`, but not `/api/authentication`.

## Raw Body

When Nest enables `rawBody`, JSON and text bodies are read once. The adapter
stores `req.rawBody` and parses the same payload, avoiding a second stream read.

```ts
const app = await NestFactory.create(AppModule, new HonoAdapter(), {
	rawBody: true,
})
```

## Request Size Limits

The adapter applies a default body limit of 1 MiB to every request body,
including routes where parsing is skipped or disabled.

Configure `bodyLimit` to change the global default, or set `bodyLimit: false`
to disable the global default:

```ts
const adapter = new HonoAdapter({
	bodyLimit: 2 * 1024 * 1024,
})
```

Use route-specific `requestSizeLimits` for upload-heavy paths:

```ts
const adapter = new HonoAdapter({
	requestSizeLimits: [
		{
			path: '/api/uploads',
			maxBytes: 10 * 1024 * 1024,
			errorMessage: 'Upload payload too large',
		},
	],
})
```

If multiple request size limits match, the longest matching path wins.

Malformed JSON and form bodies are rejected as bad requests. Payloads exceeding
the configured limit are rejected as payload-too-large errors.

## Proxy Trust

Forwarded client IP headers are ignored by default. This prevents direct clients
from spoofing `req.ip` with headers such as `x-forwarded-for`.

Enable `trustProxy` only when the application is deployed behind a trusted proxy:

```ts
const adapter = new HonoAdapter({
	trustProxy: true,
})
```

By default, trusted proxy mode accepts only `x-forwarded-for`. Without trusted
proxy mode, `req.ip` comes from the direct socket connection when available.
The rightmost forwarded address is used, which is safe for a trusted proxy that
appends the connecting client address.

To restrict the accepted headers:

```ts
const adapter = new HonoAdapter({
	trustProxy: {
		headers: ['cf-connecting-ip'],
	},
})
```

For multiple trusted proxies, set `trustedHops` to select the client address
from right to left:

```ts
const adapter = new HonoAdapter({
	trustProxy: { trustedHops: 2 },
})
```

Host headers and redirect targets remain caller-controlled HTTP input. Validate
public origins and redirect destinations in application code before using them
for security-sensitive flows.

## Request Type

The adapter attaches Nest-compatible fields to Hono's request object. Use
`NestHonoRequest` when a controller needs to type `@Req()` access:

```ts
import { Controller, Post, Req } from '@nestjs/common'
import type { NestHonoRequest } from '@mnigos/platform-hono'

@Controller()
export class WebhookController {
	@Post('/webhooks/example')
	handleWebhook(@Req() req: NestHonoRequest) {
		return {
			body: req.body,
			rawBody: req.rawBody,
		}
	}
}
```

Adapter-provided request fields include `body`, `rawBody`, `params`, `query`,
`headers`, `ip`, and `baseUrl`.

## Response Support

The adapter supports common Nest controller return values:

- JSON-serializable objects and arrays
- strings, numbers, booleans, buffers, and empty responses
- `Promise` and non-SSE `Observable` values resolved by Nest
- `Response` instances from the Fetch API
- `StreamableFile`
- Node.js `Readable` streams
- Web `ReadableStream` streams
- `@Redirect()`, `@Header()`, and `@HttpCode()`
- `@Sse()` handlers returning `Observable<MessageEvent>`

Stream chunks must be strings, `Uint8Array`/`Buffer`, or `ArrayBuffer`.
Object-mode stream chunks are rejected instead of being stringified.

```ts
import { Controller, Get, Sse, StreamableFile } from '@nestjs/common'
import { createReadStream } from 'node:fs'
import { interval, map } from 'rxjs'

@Controller()
export class FilesController {
	@Get('/file')
	file() {
		return new StreamableFile(createReadStream('report.pdf'), {
			type: 'application/pdf',
			disposition: 'attachment; filename="report.pdf"',
		})
	}

	@Get('/raw-stream')
	rawStream() {
		return createReadStream('report.pdf')
	}

	@Sse('/events')
	events() {
		return interval(1000).pipe(map(() => ({ data: { ok: true } })))
	}
}
```

The following Nest response features are intentionally deferred:

- `@Render()` and template/view-engine rendering
- Express/Fastify-style manual response APIs via `@Res()`, such as `res.send()`,
  `res.json()`, `res.end()`, or `stream.pipe(res)`

## Compatibility

| Area | Status |
| --- | --- |
| NestJS controllers and decorators | Supported |
| Hono node server | Supported |
| JSON, text, form, and multipart bodies | Supported |
| Raw body for JSON and text | Supported |
| Controller `Response`, `StreamableFile`, Node stream, and Web stream returns | Supported |
| Nest `@Sse()` server-sent events | Supported |
| Static assets | Supported |
| CORS | Supported |
| Standard and WebDAV HTTP method decorators | Supported |
| oRPC | Not yet verified |
| better-auth | Planned |
| nestjs-better-auth | Planned |
| Express/Fastify-style manual `@Res()` APIs | Deferred |
| Nest versioning | Unsupported |
| Nest views/templates | Unsupported |
