---
"@mnigos/platform-hono": minor
---

Serve with `Bun.serve` on Bun instead of going through `node:http` compatibility and `@hono/node-server`. The new `runtime` option defaults to `'auto'`, which picks Bun when the `Bun` global exists and `@hono/node-server` otherwise; set `runtime: 'node'` to keep the previous server on Bun.

On Bun, `app.getHttpServer()` now returns a `Bun.serve` wrapper with `listen()`, `address()`, `close()`, `closeAllConnections()`, and the `listening`, `error`, and `close` events instead of a Node.js `http.Server`. HTTPS maps Nest `httpsOptions` to Bun TLS options and throws at setup for unsupported options such as `pfx`. Bun's idle timeout defaults to 255 seconds, is configurable through `bun.idleTimeout`, and is disabled for `@Sse()` streams.

Add `multipartLimits` (`fileSize`, `files`, `fields`, `parts`) for `multipart/form-data` bodies. The limits are enforced while the body streams in and reject with a payload-too-large error before the rest of the body is read; `bodyLimit` and `requestSizeLimits` still cap the whole body.

`req.query` is now built on an object without a prototype, so query keys such as `__proto__`, `constructor`, or `toString` no longer shadow `Object.prototype` members.
