# @mnigos/platform-hono

## 0.4.0

### Minor Changes

- 7b5caf0: Serve with `Bun.serve` on Bun instead of going through `node:http` compatibility and `@hono/node-server`. The new `runtime` option defaults to `'auto'`, which picks Bun when the `Bun` global exists and `@hono/node-server` otherwise; set `runtime: 'node'` to keep the previous server on Bun.

  On Bun, `app.getHttpServer()` now returns a `Bun.serve` wrapper with `listen()`, `address()`, `close()`, `closeAllConnections()`, and the `listening`, `error`, and `close` events instead of a Node.js `http.Server`. HTTPS maps Nest `httpsOptions` to Bun TLS options and throws at setup for unsupported options such as `pfx`. Bun's idle timeout defaults to 255 seconds, is configurable through `bun.idleTimeout`, and is disabled for `@Sse()` streams.

  Add `multipartLimits` (`fileSize`, `files`, `fields`, `parts`) for `multipart/form-data` bodies. The limits are enforced while the body streams in and reject before the rest of the body is read, with 413 for `fileSize` and 400 for the count limits, matching Nest's multer mapping; `bodyLimit` and `requestSizeLimits` still cap the whole body.

  `req.query` is now built on an object without a prototype, so query keys such as `__proto__`, `constructor`, or `toString` no longer shadow `Object.prototype` members.

  Cut per-request overhead on both runtimes: request metadata is computed once per request instead of in every middleware layer, `req.ip` and `req.headers` are computed on first read, body limits skip requests without a body and trust a `Content-Length` within the limit instead of buffering the body, bodies are read once without `Request.clone()`, the default parsers run as one middleware, SSE and socket bridges are created only when used, and replies build one `Response` (a lightweight `@hono/node-server` response on Node.js). On an Apple M4, a three-route Nest app went from 44.6k/40.3k/15.2k to about 121k/102k/83k req/s on Bun and from 32.2k/30.5k/18.1k to about 86k/74k/53k req/s on Node.js (`GET /`, `GET /users/:id`, `POST /echo`). `bun run bench` measures it locally.

  Fix an uncaught `ERR_INVALID_STATE` that crashed Node.js processes when a `HEAD` request was answered with a `StreamableFile` or a Node.js stream.

  Support NestJS 12 alongside NestJS 11: the `@nestjs/common` and `@nestjs/core` peer range is now `>=11.0.0 <13`. On NestJS 12 the adapter implements `@QueryMethod()` (HTTP `QUERY`) routes, the security hook behind `app.useSecurityHeaders()` and `app.enableCsrfProtection()`, `return503OnClosing`, and reports route-order sensitivity, so Nest keeps declaration-order route registration.

  Fix Hono routes mounted on the adapter's Hono instance (for example `@bull-board/hono` via `getInstance().route()`) failing with `c.req.query is not a function`. Nest now receives a request view whose `query` is the parsed object, while Hono's `ctx.req` keeps its `query()` method.

  Harden request and response handling: Node.js stream replies no longer crash the process when the stream fails before its first read; multipart part headers that Bun and Node.js parse differently (leading whitespace, bare CR or LF) are rejected with 400 so `multipartLimits` also hold on routes with parsing skipped or disabled; a request body replaced by middleware is always counted against the body limit; headers set by Hono middleware registered before Nest are kept on direct replies; and on NestJS 12 the security headers hook runs before body limits and parsing, applies to native `Response` and stream replies, and receives the same request object as Nest middleware.

  `req.query` is built from the raw URL with `URLSearchParams`, so it keeps `__proto__`-style keys on every supported Hono version. Nest's `req.headers` and the body limit path lookup follow a request replaced by earlier Hono middleware, and quoted multipart boundaries with a backslash or quote are rejected with 400 when `multipartLimits` are set.

## 0.3.0

### Minor Changes

- 0b7d41d: Complete Nest route, middleware, CORS, static asset, parser, SSE, and HTTP method compatibility; harden body limits, trusted proxy resolution, and stream lifecycle handling; and require Node 20, Hono 4.12.25+, and `@hono/node-server` 2.0.5+.

  `useBodyParser` now throws on invalid `limit` strings (supported units: b, kb, mb, gb, tb, pb) instead of silently disabling that parser's limit.

  Parser types registered with `useBodyParser` before `NestFactory.create` no longer suppress the remaining default JSON, text, form, and multipart parsers.

  Explicit `@Head()` handlers take precedence over the GET fallback for HEAD requests regardless of registration order (Express answers with whichever matching route was registered first); when every explicit HEAD handler passes the request on, for example on a host mismatch, the GET handler still answers it.

### Patch Changes

- cded3dd: Security: a `'*'` entry inside a CORS `origin` array is now matched literally, like Express `cors`, instead of allowing every origin. Configs such as `origin: ['https://app.example', '*']` with `credentials: true` previously reflected any request origin; they now only allow the listed origins. Use `origin: '*'` or `origin: true` to allow every origin.

## 0.2.0

### Minor Changes

- Add support for Nest StreamableFile, direct Node and Web stream returns, and server-sent events in the Hono adapter.

## 0.1.4

### Patch Changes

- Restore request body compatibility for Nest guards and middleware while preserving the raw Hono request body for downstream consumers like oRPC.

## 0.1.3

### Patch Changes

- Support named wildcard route params from Nest route patterns.

## 0.1.2

### Patch Changes

- Allow Node 18-compatible Hono dependencies by supporting `@hono/node-server` 1.19.11 and newer with `hono` 4.10.7 and newer.

## 0.1.1

### Patch Changes

- Loosen peer dependency ranges to support compatible Hono and NestJS versions.

## 0.1.0

### Minor Changes

- 9001e41: Initial public release of the NestJS Hono HTTP adapter.

  This release includes:

  - `HonoAdapter` for booting NestJS applications on Hono.
  - Bun-first HTTP serving through `@hono/node-server`.
  - Nest-compatible route registration for common HTTP methods and middleware.
  - Request metadata normalization for params, query strings, headers, base URL,
    and trusted proxy IPs.
  - JSON, text, form, and multipart body parsing.
  - Raw body support for JSON and text requests.
  - Segment-aware body parser skips for auth and webhook routes.
  - Global and route-specific request size limits.
  - Nest-compatible response handling for JSON, text, buffers, empty responses,
    redirects, headers, custom errors, and not found handlers.
  - CORS and static asset support.
  - `NestHonoRequest` type for adapter-provided request fields such as `body`,
    `rawBody`, `params`, `query`, `headers`, `ip`, and `baseUrl`.
