---
"@mnigos/platform-hono": patch
---

Faster request handling on Node.js. `GET` requests to Nest routes without Nest middleware, CORS, static assets, or other Hono middleware in front of them now skip `@hono/node-server`'s Fetch request/response round trip and Hono's promise chain; everything Nest and Hono code can observe (the request object, the Hono context, responses on the wire, aborts, errors) stays the same. The fast path checks the installed `@hono/node-server` and Hono once at startup and turns itself off when they do not behave as it expects. Bun is unchanged.
