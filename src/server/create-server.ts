import {
	createServer as createHttpServer,
	type Server as HttpServer,
} from 'node:http'
import {
	createServer as createHttpsServer,
	type Server as HttpsServer,
} from 'node:https'
import { createAdaptorServer } from '@hono/node-server'
import type { NestApplicationOptions } from '@nestjs/common'
import type { Hono } from 'hono'
import type { HonoAdapterOptions } from '../options'
import { BunHttpServer } from './bun-http-server'
import { resolveRuntime } from './runtime'

export type HonoHttpServer = HttpServer | HttpsServer | BunHttpServer

/**
 * Creates the HTTP server for the resolved runtime: `Bun.serve` on Bun and
 * `@hono/node-server` on Node.js or when `runtime: 'node'` is forced.
 */
export function createServer(
	hono: Hono,
	options: NestApplicationOptions,
	adapterOptions: HonoAdapterOptions
): HonoHttpServer {
	if (resolveRuntime(adapterOptions.runtime) === 'bun')
		return new BunHttpServer(hono.fetch, {
			forceCloseConnections: options.forceCloseConnections,
			httpsOptions: options.httpsOptions,
			idleTimeout: adapterOptions.bun?.idleTimeout,
		})

	return (
		options.httpsOptions
			? createAdaptorServer({
					fetch: hono.fetch,
					createServer: createHttpsServer,
					overrideGlobalObjects: false,
					serverOptions: options.httpsOptions,
				})
			: createAdaptorServer({
					fetch: hono.fetch,
					createServer: createHttpServer,
					overrideGlobalObjects: false,
				})
	) as HttpServer | HttpsServer
}
