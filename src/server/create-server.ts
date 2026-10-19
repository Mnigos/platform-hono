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
import { BunFastPath } from './bun-fast-path'
import { BunHttpServer } from './bun-http-server'
import { NodeFastPath, type NodeListener } from './node-fast-path'
import { resolveRuntime } from './runtime'

export type HonoHttpServer = HttpServer | HttpsServer | BunHttpServer

type CreateNodeServer = (
	options: object,
	listener: NodeListener
) => HttpServer | HttpsServer

/**
 * Lets `@hono/node-server` create the server as usual, with the fast path in
 * front of the request listener it passes.
 */
function withFastPath<TCreate>(
	create: TCreate,
	fetch: Hono['fetch'],
	fastPath?: BunFastPath | NodeFastPath
) {
	if (!(fastPath instanceof NodeFastPath && fastPath.servesFetch(fetch)))
		return create
	const createServerWithFastPath: CreateNodeServer = (options, listener) =>
		(create as unknown as CreateNodeServer)(
			options,
			fastPath.wrapListener(listener)
		)
	return createServerWithFastPath as TCreate
}

/**
 * Creates the HTTP server for the resolved runtime: `Bun.serve` on Bun and
 * `@hono/node-server` on Node.js or when `runtime: 'node'` is forced, with the
 * runtime's fast path in front of `hono.fetch()` when there is one.
 * `hono.fetch` is read once, here, so a replacement installed before the
 * server is created handles requests and later ones do not.
 */
export function createServer(
	hono: Hono,
	options: NestApplicationOptions,
	adapterOptions: HonoAdapterOptions,
	fastPath?: BunFastPath | NodeFastPath
): HonoHttpServer {
	const { fetch } = hono
	if (resolveRuntime(adapterOptions.runtime) === 'bun')
		return new BunHttpServer(
			fastPath instanceof BunFastPath ? fastPath.wrapFetch(fetch) : fetch,
			{
				forceCloseConnections: options.forceCloseConnections,
				httpsOptions: options.httpsOptions,
				idleTimeout: adapterOptions.bun?.idleTimeout,
			}
		)

	return (
		options.httpsOptions
			? createAdaptorServer({
					fetch,
					createServer: withFastPath(createHttpsServer, fetch, fastPath),
					overrideGlobalObjects: false,
					serverOptions: options.httpsOptions,
				})
			: createAdaptorServer({
					fetch,
					createServer: withFastPath(createHttpServer, fetch, fastPath),
					overrideGlobalObjects: false,
				})
	) as HttpServer | HttpsServer
}
