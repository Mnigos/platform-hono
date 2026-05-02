# platform-hono

NestJS HTTP adapter package for Hono.

This repository contains the extracted Hono HTTP adapter used by `rigtch.fm`.
The adapter is intended to integrate with NestJS, Hono, oRPC, better-auth, and
`nestjs-better-auth`.

## Usage

```ts
import { NestFactory } from '@nestjs/core'
import { HonoAdapter } from '@mnigos/platform-hono'
import { AppModule } from './app.module'

const adapter = new HonoAdapter({
	skipBodyParserFor: ['/api/auth'],
	requestSizeLimits: [
		{
			path: '/api/uploads',
			maxBytes: 10 * 1024 * 1024,
			errorMessage: 'Upload payload too large',
		},
	],
})

const app = await NestFactory.create(AppModule, adapter)
await app.listen(3000)
```

## Body Parsing and Limits

Request body parsing is enabled by default unless Nest is bootstrapped with
`bodyParser: false`.

The adapter applies a default body limit of 1 MiB before parsing JSON, text,
form, or multipart bodies. Configure `bodyLimit` to change the global default,
or set `bodyLimit: false` to disable the global default. Route-specific
`requestSizeLimits` still apply when configured.

`requestSizeLimits` and `skipBodyParserFor` use route-aware matching. A policy
for `/api/auth` matches `/api/auth` and `/api/auth/session`, but not
`/api/authentication`. If multiple request size limits match, the longest path
wins.

Use `skipBodyParserFor` for routes that need the original request stream, such
as better-auth or webhook endpoints:

```ts
new HonoAdapter({
	skipBodyParserFor: ['/api/auth', '/webhooks/stripe'],
})
```

When Nest enables `rawBody`, JSON and text bodies are read once. The adapter
stores `req.rawBody` and parses the same payload, avoiding a second stream read.

Malformed JSON and form bodies are rejected as bad requests. Payloads exceeding
the configured limit are rejected as payload-too-large errors.

## Proxy Trust

Forwarded client IP headers are ignored by default. This prevents direct clients
from spoofing `req.ip` with headers such as `x-forwarded-for`.

Enable `trustProxy` only when the application is deployed behind a trusted proxy:

```ts
new HonoAdapter({
	trustProxy: true,
})
```

By default, trusted proxy mode considers common proxy headers including
`cf-connecting-ip`, `x-forwarded-for`, `x-real-ip`, `forwarded`, and
`true-client-ip`. To restrict the accepted headers:

```ts
new HonoAdapter({
	trustProxy: {
		headers: ['cf-connecting-ip'],
	},
})
```

Host headers and redirect targets remain caller-controlled HTTP input. Validate
public origins and redirect destinations in application code before using them
for security-sensitive flows.

## Commands

```bash
bun install
bun run check
bun run typecheck
bun run test
bun run test:integration
bun run build
```
