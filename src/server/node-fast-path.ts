import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { getRequestListener } from '@hono/node-server'
import type { Context, Hono, MiddlewareHandler, NotFoundHandler } from 'hono'
import type { SecurityRequestHook } from '../helpers/nest-12'
import type { HonoAdapterOptions } from '../options'
import { isBodyLimitLayer } from '../request/body-limit-middleware'
import { prepareRequest } from '../request/request-layer'
import type { RouteRegistry } from '../routing/route-registry'
import { type DispatchTarget, FastExchange } from './fast-dispatch'
import {
	type ContextClass,
	ContextOptionsRecord,
	getContextClass,
} from './hono-context'
import {
	createAbortOnClose,
	getNodeServerInternals,
	type NodeServerInternals,
} from './node-internals'
import { getVerbatimPath, isVerbatimHost } from './node-request-target'
import {
	type CachedResponseWriter,
	getCachedResponseWriter,
	type ResponseCache,
} from './node-response-writer'

export type NodeListener = (
	incoming: IncomingMessage,
	outgoing: ServerResponse
) => unknown

type MatchedHandlers = [[Function, unknown], unknown][]

/**
 * `ctx.env` as `@hono/node-server` passes it, created without an object
 * literal (see `RequestStateRecord`) but with the same keys and prototype.
 */
interface NodeEnv {
	incoming: IncomingMessage
	outgoing: ServerResponse
}

export interface NodeFastPathOptions {
	adapterOptions: HonoAdapterOptions
	hono: Hono
	requestLayer: MiddlewareHandler
	routes: RouteRegistry
	securityHooks: readonly SecurityRequestHook[]
}

interface FastPathRuntime {
	HonoContext: ContextClass
	internals: NodeServerInternals
	writeCachedResponse?: CachedResponseWriter
}

/**
 * Writes a cached response directly. A failed write is left to
 * `@hono/node-server`'s writer, which reports it as on the Hono path.
 */
function tryWriteDirectly(
	write: CachedResponseWriter,
	outgoing: ServerResponse,
	cache: ResponseCache
) {
	try {
		return write(outgoing, cache)
	} catch {
		return false
	}
}

/**
 * Serves plain Nest `GET` routes on Node.js without the Fetch round trip:
 * `@hono/node-server`'s lightweight request, Hono's `Context`, and the
 * adapter's request state are created exactly as on the Hono path, and the
 * route runs with `hono.fetch()`'s semantics (`FastExchange`), minus its
 * promise plumbing. Requests it does not cover go to `@hono/node-server`'s
 * listener unchanged.
 */
export class NodeFastPath implements DispatchTarget {
	private catchAllMiddleware = false
	private readonly getPath: Hono['getPath']
	private readonly hono: Hono
	private notFoundHandler?: NotFoundHandler
	private readonly prepare: (ctx: Context) => void
	private prepared?: Promise<unknown>
	private readonly requestLayer: MiddlewareHandler
	private routeCount = 0
	private readonly routes: RouteRegistry
	private readonly runtime: FastPathRuntime
	private verbatimHost?: string
	private readonly writer: NodeListener

	constructor(
		{
			adapterOptions,
			hono,
			requestLayer,
			routes,
			securityHooks,
		}: NodeFastPathOptions,
		runtime: FastPathRuntime
	) {
		this.getPath = hono.getPath
		this.hono = hono
		this.prepare = ctx => prepareRequest(ctx, adapterOptions, securityHooks)
		this.requestLayer = requestLayer
		this.routes = routes
		this.runtime = runtime
		this.writer = getRequestListener(() => this.takePrepared(), {
			overrideGlobalObjects: false,
		}) as NodeListener
		const setNotFoundHandler = hono.notFound
		const notFound: Hono['notFound'] = handler => {
			this.notFoundHandler = handler
			return setNotFoundHandler(handler)
		}
		hono.notFound = notFound
	}

	/**
	 * Puts the fast path in front of `@hono/node-server`'s listener.
	 */
	wrapListener(listener: NodeListener): NodeListener {
		return (incoming, outgoing) =>
			this.serve(incoming, outgoing) ? undefined : listener(incoming, outgoing)
	}

	/**
	 * Writes the result of a fast path request: string responses directly,
	 * with the same calls as `@hono/node-server`, and everything else through
	 * its writer, as the promise `hono.fetch()` would have returned.
	 */
	respond({ incoming, outgoing }: FastExchange, result: unknown) {
		const { writeCachedResponse } = this.runtime
		const cache = this.getResponseCache(result)
		if (
			writeCachedResponse &&
			cache &&
			!outgoing.headersSent &&
			tryWriteDirectly(writeCachedResponse, outgoing, cache)
		)
			return
		this.prepared = Promise.resolve(result)
		this.writer(incoming, outgoing)
	}

	private takePrepared() {
		const prepared = this.prepared as Promise<Response>
		this.prepared = undefined
		return prepared
	}

	private getResponseCache(result: unknown) {
		if (typeof result !== 'object' || !result) return
		return (result as Record<symbol, ResponseCache | undefined>)[
			this.runtime.internals.responseCacheKey
		]
	}

	/**
	 * Serves a `GET` request without body headers, with a request target and
	 * `Host` that `@hono/node-server` uses verbatim, whose matched handlers are
	 * exactly the adapter's request layer, its body layer, and a Nest route.
	 * Returns `false` for any other request.
	 */
	private serve(incoming: IncomingMessage, outgoing: ServerResponse) {
		const { headers, url } = incoming
		const notFoundHandler = this.notFoundHandler
		if (
			incoming.method !== 'GET' ||
			!notFoundHandler ||
			url === undefined ||
			headers['content-length'] !== undefined ||
			headers['transfer-encoding'] !== undefined ||
			headers['content-type'] !== undefined ||
			this.hasCatchAllMiddleware()
		)
			return false
		const { host } = headers
		if (!(host && this.isVerbatimHost(host))) return false
		const path = getVerbatimPath(url)
		if (path === undefined || this.hono.getPath !== this.getPath) return false
		const matchResult = this.match(path)
		const route = matchResult && this.getRoute(matchResult)
		if (!route) return false

		const request = this.createRequest(incoming, host, url)
		const env: NodeEnv = Object.create(Object.prototype)
		env.incoming = incoming
		env.outgoing = outgoing
		const exchange = new FastExchange(
			new this.runtime.HonoContext(
				request,
				new ContextOptionsRecord(env, matchResult, notFoundHandler, path)
			),
			this.hono,
			incoming,
			notFoundHandler,
			outgoing,
			this
		)
		exchange.dispatch(this.prepare, route)
		outgoing.on(
			'close',
			createAbortOnClose(this.runtime.internals, request, incoming, outgoing)
		)
		return true
	}

	/**
	 * Whether a middleware other than the adapter's layers runs for every
	 * request (such as CORS or Nest's `app.use()`), so no request can be served.
	 * Checked again only when routes were added.
	 */
	private hasCatchAllMiddleware() {
		const { routes } = this.hono
		if (routes.length === this.routeCount) return this.catchAllMiddleware
		this.routeCount = routes.length
		this.catchAllMiddleware = routes.some(
			({ handler, method, path }) =>
				method === 'ALL' &&
				path === '/*' &&
				handler !== this.requestLayer &&
				!isBodyLimitLayer(handler)
		)
		return this.catchAllMiddleware
	}

	private isVerbatimHost(host: string) {
		if (host === this.verbatimHost) return true
		if (!isVerbatimHost(host)) return false
		this.verbatimHost = host
		return true
	}

	/**
	 * Matches the path with Hono's router. A router error is left to
	 * `hono.fetch()`, which reports it as on the Hono path.
	 */
	private match(path: string) {
		try {
			return this.hono.router.match('GET', path)
		} catch {
			return
		}
	}

	private getRoute(matchResult: ReturnType<Hono['router']['match']>) {
		const handlers = matchResult[0] as unknown as MatchedHandlers
		if (
			handlers.length !== 3 ||
			handlers[0]?.[0][0] !== this.requestLayer ||
			!isBodyLimitLayer(handlers[1]?.[0][0])
		)
			return
		return this.routes.getRouteForGet(handlers[2]?.[0][0])
	}

	/** `@hono/node-server`'s `newRequest()` for a verbatim target and host. */
	private createRequest(incoming: IncomingMessage, host: string, url: string) {
		const { incomingKey, methodKey, requestPrototype, urlKey } =
			this.runtime.internals
		const request = Object.create(requestPrototype) as Request &
			Record<symbol, unknown>
		const scheme = (incoming.socket as TLSSocket | null)?.encrypted
			? 'https'
			: 'http'
		request[incomingKey] = incoming
		request[methodKey] = 'GET'
		request[urlKey] = `${scheme}://${host}${url}`
		return request
	}
}

/**
 * Creates the fast path on Node.js when the installed `@hono/node-server` and
 * Hono pass their self-checks, or returns `undefined`, which keeps every
 * request on `@hono/node-server` and `hono.fetch()`.
 */
export function createNodeFastPath(options: NodeFastPathOptions) {
	if (typeof Bun !== 'undefined' || options.adapterOptions.runtime === 'bun')
		return
	const internals = getNodeServerInternals()
	const HonoContext = getContextClass()
	if (!(internals && HonoContext)) return
	return new NodeFastPath(options, {
		HonoContext,
		internals,
		writeCachedResponse: getCachedResponseWriter(internals.responseCacheKey),
	})
}
