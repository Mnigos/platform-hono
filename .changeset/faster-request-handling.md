---
"@mnigos/platform-hono": minor
---

Faster request handling on Node.js and Bun.

- `GET` requests to Nest routes without Nest middleware, CORS, static assets, or other Hono middleware in front of them take a fast path. On Node.js it skips `@hono/node-server`'s Fetch request/response round trip, on Bun it skips `hono.fetch()`'s middleware chain, and on both it skips Hono's promise plumbing between layers. The fast paths check the installed Hono (and on Node.js `@hono/node-server`) once at startup and turn themselves off when they do not behave as expected, or when the app replaced `hono.fetch` before the server was created; every other request is handled as before.
- NestJS 12 on Node.js no longer spends most of its time in garbage collection: the adapter's per-request objects are now built so that V8 does not allocate them straight in old space.

Behaviour changes:

- On requests the fast path serves, `req.headers`, `req.ip`, and on Node.js `req.socket` (on the Nest request and on `ctx.req`), `ctx.raw`, and `ctx.res` are inherited from adapter-owned prototypes instead of being own properties. Their values are unchanged, `instanceof`, `constructor`, and `for...in` still see them, but `Object.keys()`, object spread, `JSON.stringify()`, `Object.hasOwn()`, and own property descriptors do not, and `Object.getPrototypeOf()` returns the adapter's prototype, which inherits from Hono's `Context` or `HonoRequest` prototype. Requests outside the fast path keep them as own properties, and Hono's own classes are not modified.
- `GET` requests are no longer run through the body parsers: `req.body` stays `undefined` instead of `{}` (JSON, form) or `''` (text), `req.rawBody` is not set, and a `multipart/form-data` `GET` is no longer rejected with 400. Neither `Bun.serve` nor `@hono/node-server` ever exposes a `GET` request body, so the parsers only ever saw an empty body for these requests, even when one was sent. `HEAD` and all other methods are parsed as before.
