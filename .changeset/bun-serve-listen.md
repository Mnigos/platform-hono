---
"@mnigos/platform-hono": minor
---

Serve with `Bun.serve` on Bun instead of going through `node:http` compatibility and `@hono/node-server`. The new `runtime` option defaults to `'auto'`, which picks Bun when the `Bun` global exists and `@hono/node-server` otherwise; set `runtime: 'node'` to keep the previous server on Bun.

On Bun, `app.getHttpServer()` now returns a `Bun.serve` wrapper with `listen()`, `address()`, `close()`, `closeAllConnections()`, and the `listening`, `error`, and `close` events instead of a Node.js `http.Server`. HTTPS maps Nest `httpsOptions` to Bun TLS options and throws at setup for unsupported options such as `pfx`. Bun's idle timeout defaults to 255 seconds, is configurable through `bun.idleTimeout`, and is disabled for `@Sse()` streams.

Add `multipartLimits` (`fileSize`, `files`, `fields`, `parts`) for `multipart/form-data` bodies. The limits are enforced while the body streams in and reject before the rest of the body is read, with 413 for `fileSize` and 400 for the count limits, matching Nest's multer mapping; `bodyLimit` and `requestSizeLimits` still cap the whole body.

`req.query` is now built on an object without a prototype, so query keys such as `__proto__`, `constructor`, or `toString` no longer shadow `Object.prototype` members.

Cut per-request overhead on both runtimes: request metadata is computed once per request instead of in every middleware layer, `req.ip` and `req.headers` are computed on first read, body limits skip requests without a body and trust a `Content-Length` within the limit instead of buffering the body, bodies are read once without `Request.clone()`, the default parsers run as one middleware, SSE and socket bridges are created only when used, and replies build one `Response` (a lightweight `@hono/node-server` response on Node.js). On an Apple M4, a three-route Nest app went from 44.6k/40.3k/15.2k to about 121k/102k/83k req/s on Bun and from 32.2k/30.5k/18.1k to about 86k/74k/53k req/s on Node.js (`GET /`, `GET /users/:id`, `POST /echo`). `bun run bench` measures it locally.
