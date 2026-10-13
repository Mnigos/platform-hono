import {
	type ServeStaticOptions,
	serveStatic,
} from '@hono/node-server/serve-static'
import type { Context, Hono } from 'hono'
import { createResponse, finalizeResponse } from './response'

export interface StaticAssetsOptions extends ServeStaticOptions {
	prefix?: string
}

function normalizeStaticPrefix(prefix: string) {
	const normalized = `/${prefix.replace(/^\/+|\/+$/g, '')}`
	return normalized === '/' ? '' : normalized
}

function createStaticMiddleware(options: ServeStaticOptions) {
	const middleware = serveStatic(options)
	return async (ctx: Context, next: () => Promise<void>) => {
		if (ctx.req.method === 'GET' || ctx.req.method === 'HEAD') {
			let continued = false
			const response = await middleware(ctx, async () => {
				continued = true
				await next()
			})
			if (continued || !(response instanceof Response)) return response

			return finalizeResponse(ctx, createResponse(ctx, response))
		}
		return next()
	}
}

/**
 * Registers Nest `useStaticAssets()` on Hono. Without an explicit `root`, the
 * asset directory is `rootPath` and requests are matched under `prefix`.
 */
export function registerStaticAssets(
	hono: Hono,
	rootPath: string,
	options: StaticAssetsOptions = {}
) {
	const { prefix, ...staticOptions } = options
	if (staticOptions.root !== undefined) {
		hono.use(rootPath, createStaticMiddleware(staticOptions))
		return
	}

	const staticPrefix = normalizeStaticPrefix(prefix ?? '')
	const rewriteRequestPath = staticOptions.rewriteRequestPath
	const middleware = createStaticMiddleware({
		...staticOptions,
		rewriteRequestPath: (requestPath, ctx) => {
			const pathWithoutPrefix = staticPrefix
				? requestPath.slice(staticPrefix.length) || '/'
				: requestPath
			return rewriteRequestPath
				? rewriteRequestPath(pathWithoutPrefix, ctx)
				: pathWithoutPrefix
		},
		root: rootPath,
	})

	if (staticPrefix) hono.use(`${staticPrefix}/*`, middleware)
	else hono.use(middleware)
}
