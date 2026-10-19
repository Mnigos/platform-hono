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
	fastPath?: BunFastPath | NodeFastPath
) {
	if (!(fastPath instanceof NodeFastPath)) return create
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
 */
export function createServer(
	hono: Hono,
	options: NestApplicationOptions,
	adapterOptions: HonoAdapterOptions,
	fastPath?: BunFastPath | NodeFastPath
): HonoHttpServer {
	if (resolveRuntime(adapterOptions.runtime) === 'bun')
		return new BunHttpServer(
			fastPath instanceof BunFastPath ? fastPath.fetch : hono.fetch,
			{
				forceCloseConnections: options.forceCloseConnections,
				httpsOptions: options.httpsOptions,
				idleTimeout: adapterOptions.bun?.idleTimeout,
			}
		)

	return (
		options.httpsOptions
			? createAdaptorServer({
					fetch: hono.fetch,
					createServer: withFastPath(createHttpsServer, fastPath),
					overrideGlobalObjects: false,
					serverOptions: options.httpsOptions,
				})
			: createAdaptorServer({
					fetch: hono.fetch,
					createServer: withFastPath(createHttpServer, fastPath),
					overrideGlobalObjects: false,
				})
	) as HttpServer | HttpsServer
}
