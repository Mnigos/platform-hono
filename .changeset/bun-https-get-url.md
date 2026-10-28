---
"@mnigos/platform-hono": patch
---

Fix `app.getUrl()` returning an `http://` URL for an HTTPS app on Bun with NestJS 12.3 and later, which made clients that follow it connect to the TLS server over plain HTTP. NestJS 12.3 picks the protocol with `httpServer instanceof tls.Server` instead of reading `httpsOptions`, and the adapter's `Bun.serve` wrapper was not a `tls.Server`. With `httpsOptions`, the wrapper returned by `app.getHttpServer()` now inherits from `tls.Server.prototype`, like Node.js' `https.Server`, so `app.getUrl()` reports `https://` with every supported NestJS version. HTTP servers and the `@hono/node-server` path are unchanged.

Bun's own `node:https` server is not a `tls.Server`, so with `runtime: 'node'` on Bun, NestJS 12.3 and later still report `http://` for an HTTPS app.
