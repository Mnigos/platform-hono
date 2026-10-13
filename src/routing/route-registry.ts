import { RequestMethod } from '@nestjs/common'
import type { RequestHandler } from '@nestjs/common/interfaces'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import type { HonoAdapterOptions } from '../options'
import {
	getRequestState,
	setRouteParams,
	syncRawRequest,
} from '../request/request-state'
import { createRouteHandler, invokeHandler, runHandlers } from './route-invoker'
import {
	getOptionalParameterSuffixes,
	normalizeHonoMiddlewarePath,
	normalizeHonoPaths,
} from './route-paths'

export type RouteHandler = (
	req: Context['req'],
	res: Context,
	next: () => Promise<void>
) => Response | undefined | Promise<Response | undefined>

export type RouteArguments = [
	pathOrHandler: string | RouteHandler,
	handler?: RouteHandler,
]

export type HonoRouteMethod =
	| 'all'
	| 'copy'
	| 'delete'
	| 'get'
	| 'head'
	| 'lock'
	| 'mkcol'
	| 'move'
	| 'options'
	| 'patch'
	| 'post'
	| 'propfind'
	| 'proppatch'
	| 'put'
	| 'search'
	| 'unlock'
	| 'use'

function getRouteAndHandler(
	pathOrHandler: string | RouteHandler,
	handler?: RouteHandler
): [string, RouteHandler] {
	const path = typeof pathOrHandler === 'function' ? '' : pathOrHandler
	const routeHandler =
		typeof pathOrHandler === 'function' ? pathOrHandler : handler
	if (!routeHandler) throw new Error('Route handler is required')
	return [path, routeHandler]
}

/**
 * Registers Nest routes and middleware on the Hono app, including HEAD
 * handling where explicit `@Head()` handlers take precedence over GET routes.
 */
export class RouteRegistry {
	private readonly headRouteHandlers = new Map<string, MiddlewareHandler[]>()
	private readonly triedHeadRoutes = new WeakMap<Context, Set<string>>()
	private readonly adapterOptions: HonoAdapterOptions
	private readonly hono: Hono

	constructor(hono: Hono, adapterOptions: HonoAdapterOptions) {
		this.hono = hono
		this.adapterOptions = adapterOptions
	}

	register(
		method: HonoRouteMethod,
		pathOrHandler: string | RouteHandler,
		handler?: RouteHandler
	) {
		const [routePath, routeHandler] = getRouteAndHandler(pathOrHandler, handler)
		const wrappedHandler = createRouteHandler({
			adapterOptions: this.adapterOptions,
			optionalParameterSuffixes: getOptionalParameterSuffixes(routePath),
			routeHandler: routeHandler as RequestHandler,
			waitForNext: method === 'use',
		})

		if (method === 'use' && typeof pathOrHandler === 'function') {
			this.hono.use(wrappedHandler)
			return
		}

		const middlewareContexts = new WeakSet<Context>()
		const middlewareHandler: MiddlewareHandler = (ctx, next) => {
			if (middlewareContexts.has(ctx)) return next()
			middlewareContexts.add(ctx)
			return wrappedHandler(ctx, next)
		}

		for (const honoPath of new Set(normalizeHonoPaths(routePath))) {
			if (method === 'all') {
				this.hono.all(honoPath, wrappedHandler)
				continue
			}
			if (method === 'use') {
				this.hono.use(normalizeHonoMiddlewarePath(honoPath), middlewareHandler)
				continue
			}
			if (method === 'head') {
				const headHandlers = this.headRouteHandlers.get(honoPath) ?? []
				headHandlers.push(wrappedHandler)
				this.headRouteHandlers.set(honoPath, headHandlers)
				this.hono.on('GET', honoPath, (ctx, next) =>
					ctx.req.method === 'HEAD' && this.markHeadRouteTried(ctx, honoPath)
						? runHandlers(ctx, headHandlers, next)
						: next()
				)
				continue
			}

			const handlerForMethod: MiddlewareHandler =
				method === 'get'
					? (ctx, next) => {
							const headHandlers = this.headRouteHandlers.get(honoPath)
							return ctx.req.method === 'HEAD' &&
								headHandlers &&
								this.markHeadRouteTried(ctx, honoPath)
								? runHandlers(ctx, [...headHandlers, wrappedHandler], next)
								: wrappedHandler(ctx, next)
						}
					: wrappedHandler
			this.hono.on(method.toUpperCase(), honoPath, handlerForMethod)
		}
	}

	registerMiddleware(
		requestMethod: RequestMethod,
		path: string,
		callback: Function
	) {
		const isAllMethods =
			requestMethod === RequestMethod.ALL || (requestMethod as number) === -1
		const method = RequestMethod[requestMethod]
		const optionalParameterSuffixes = getOptionalParameterSuffixes(path)
		if (!(method || isAllMethods))
			throw new Error(`Unsupported request method: ${requestMethod}`)

		const invokedContexts = new WeakSet<Context>()
		const middleware: MiddlewareHandler = async (ctx, next) => {
			if (invokedContexts.has(ctx)) return next()
			invokedContexts.add(ctx)
			syncRawRequest(getRequestState(ctx, this.adapterOptions))
			setRouteParams(ctx, optionalParameterSuffixes)
			const response = await invokeHandler(callback, ctx, next, true)
			if (response instanceof Response) return response
		}

		for (const honoPath of new Set(normalizeHonoPaths(path))) {
			if (isAllMethods) {
				this.hono.all(honoPath, middleware)
				continue
			}
			if (requestMethod === RequestMethod.HEAD) {
				this.hono.on('GET', honoPath, (ctx, next) =>
					ctx.req.method === 'HEAD' ? middleware(ctx, next) : next()
				)
				continue
			}
			this.hono.on(method, honoPath, middleware)
		}
	}

	private markHeadRouteTried(ctx: Context, path: string) {
		const triedPaths = this.triedHeadRoutes.get(ctx) ?? new Set<string>()
		if (triedPaths.has(path)) return false
		triedPaths.add(path)
		this.triedHeadRoutes.set(ctx, triedPaths)
		return true
	}
}
