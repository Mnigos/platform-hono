# Benchmark

`bench/app.mjs` is a three-route Nest app (`GET /`, `GET /users/:id`,
`POST /echo`) that runs the built adapter from `dist/`. `bench/run.sh` builds
the package, starts the app on each target, and measures it with
[wrk](https://github.com/wg/wrk) (`brew install wrk`), 4 threads and 100
connections, after a 3 second warmup.

```bash
bun run bench              # Bun.serve on Bun, @hono/node-server on Node.js
bun run bench bun-node     # Bun with runtime: 'node' (node:http compatibility)
DURATION=15s bun run bench node
```

Run it on an otherwise idle machine and compare runs against each other, not
against numbers from other hardware. It is not part of `prepublish:check`.
