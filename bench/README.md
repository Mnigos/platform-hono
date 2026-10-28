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

## README chart

`bench/results.json` holds the numbers shown at the top of the main README,
measured with the [NestJS benchmark](https://github.com/nestjs/nest/pull/18063)
apps. After a new measurement, update it and regenerate the chart SVGs in
`assets/` and the README chart and table blocks:

```bash
bun bench/chart.ts
```

`setup.nest` is the NestJS version of every adapter not listed under the
optional `nestBuilds` or `unreleased`. `nestBuilds` names another NestJS build
that some released adapters run, and adapters listed under `unreleased` are
labelled as unreleased with their own NestJS version. An adapter only appears
for the runtimes that have a measurement. `platform-node` runs on Bun through
Bun's `node:http` compatibility. `bun run test` fails while the chart or README
is out of date with `results.json`.
