---
"@mnigos/platform-hono": minor
---

Complete Nest route, middleware, CORS, static asset, parser, SSE, and HTTP method compatibility; harden body limits, trusted proxy resolution, and stream lifecycle handling; and require Node 20, Hono 4.12.25+, and `@hono/node-server` 2.0.5+.

`useBodyParser` now throws on invalid `limit` strings (supported units: b, kb, mb, gb, tb, pb) instead of silently disabling that parser's limit.
