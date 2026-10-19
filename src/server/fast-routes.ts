import type { Hono, MiddlewareHandler, NotFoundHandler } from 'hono'
import type { SecurityRequestHook } from '../helpers/nest-12'
import type { HonoAdapterOptions } from '../options'
import { isBodyLimitLayer } from '../request/body-limit-middleware'
import type { RouteRegistry } from '../routing/route-registry'

type MatchedHandlers = [[Function, unknown], unknown][]

type MatchResult = ReturnType<Hono['router']['match']>

export interface FastPathOptions {
	adapterOptions: HonoAdapterOptions
	hono: Hono
	requestLayer: MiddlewareHandler
	routes: RouteRegistry
	securityHooks: readonly SecurityRequestHook[]
}

/**
 * Decides which `GET` requests the runtime fast paths may serve: those whose
 * matched handlers are exactly the adapter's request layer, its body layer,
 * and a Nest `GET` or `ALL` route, while the app has a known not-found
 * handler, Hono's default `getPath`, and no catch-all middleware of its own.
 */
export class FastRoutes {
	private catchAllMiddleware = false
	private readonly honoFetch: Hono['fetch']
	private readonly honoGetPath: Hono['getPath']
	private readonly hono: Hono
	private notFound?: NotFoundHandler
	private readonly requestLayer: MiddlewareHandler
	private routeCount = 0
	private readonly routes: RouteRegistry

	constructor({ hono, requestLayer, routes }: FastPathOptions) {
		this.honoFetch = hono.fetch
		this.honoGetPath = hono.getPath
		this.hono = hono
		this.requestLayer = requestLayer
		this.routes = routes
		const setNotFoundHandler = hono.notFound
		const notFound: Hono['notFound'] = handler => {
			this.notFound = handler
			return setNotFoundHandler(handler)
		}
		hono.notFound = notFound
	}

	/**
	 * Whether a server's `fetch` is Hono's own. A fast path only stands in for
	 * Hono's own `fetch`; an app that replaced `hono.fetch` before the server
	 * was created keeps every request on its replacement.
	 */
	isHonoFetch(fetch: Hono['fetch']) {
		return fetch === this.honoFetch
	}

	/** The not-found handler `hono.fetch()` would pass to the context. */
	get notFoundHandler() {
		return this.notFound
	}

	/**
	 * Whether any request can be served: the not-found handler is known,
	 * `hono.getPath` is Hono's own, and no middleware other than the adapter's
	 * layers runs for every request (such as CORS or Nest's `app.use()`).
	 */
	isEnabled() {
		return (
			this.notFound !== undefined &&
			this.hono.getPath === this.honoGetPath &&
			!this.hasCatchAllMiddleware()
		)
	}

	/**
	 * The path `hono.fetch()` routes a request by. While `isEnabled()`, this is
	 * Hono's default `getPath`, which only reads the request URL.
	 */
	getPath(request: Request) {
		return this.honoGetPath(request)
	}

	/**
	 * Matches a `GET` path with Hono's router. A router error is left to
	 * `hono.fetch()`, which reports it as on the Hono path.
	 */
	match(path: string) {
		try {
			return this.hono.router.match('GET', path)
		} catch {
			return
		}
	}

	/**
	 * The Nest route of a match whose handlers are exactly the adapter's
	 * request layer, its body layer, and a Nest `GET` or `ALL` route.
	 */
	getRoute(matchResult: MatchResult) {
		const handlers = matchResult[0] as unknown as MatchedHandlers
		if (
			handlers.length !== 3 ||
			handlers[0]?.[0][0] !== this.requestLayer ||
			!isBodyLimitLayer(handlers[1]?.[0][0])
		)
			return
		return this.routes.getRouteForGet(handlers[2]?.[0][0])
	}

	/** Checked again only when routes were added. */
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
}
