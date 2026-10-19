import type { Context, Hono, NotFoundHandler } from 'hono'
import { prepareRequest } from '../request/request-layer'
import { FastExchange } from './fast-dispatch'
import { type FastPathOptions, FastRoutes } from './fast-routes'
import {
	type ContextClass,
	ContextOptionsRecord,
	getAdapterContextClass,
} from './hono-context'

type Resolve = (result: unknown) => void

/** A fast path request on Bun, answered through the promise `fetch` returns. */
class BunExchange extends FastExchange {
	resolve?: Resolve

	protected respond(result: unknown) {
		this.resolve?.(result)
	}
}

/**
 * Serves plain Nest `GET` routes on Bun without `hono.fetch()`: Hono's
 * router, an adapter-owned `Context` (see `getAdapterContextClass`), and the
 * adapter's request state, with the route run by `FastExchange` with
 * `hono.fetch()`'s semantics minus its promise plumbing. The body layer is
 * skipped: Bun never exposes a `GET` body, and a `GET` without a body is not
 * parsed. Requests it does not cover go to `hono.fetch()` unchanged.
 */
export class BunFastPath {
	private readonly AdapterContext: ContextClass
	private readonly fastRoutes: FastRoutes
	private readonly hono: Hono
	private readonly prepare: (ctx: Context) => void

	constructor(options: FastPathOptions, AdapterContext: ContextClass) {
		const { adapterOptions, hono, securityHooks } = options
		this.AdapterContext = AdapterContext
		this.fastRoutes = new FastRoutes(options)
		this.hono = hono
		this.prepare = ctx => prepareRequest(ctx, adapterOptions, securityHooks)
	}

	/**
	 * Puts the fast path in front of the server's `fetch` handler, which is
	 * `hono.fetch` as read when the server is created. A replaced
	 * `hono.fetch` keeps every request on the replacement.
	 */
	wrapFetch(fetch: Hono['fetch']): Hono['fetch'] {
		if (!this.fastRoutes.isHonoFetch(fetch)) return fetch
		return (request, server) => this.serve(request, server, fetch)
	}

	private serve(request: Request, server: unknown, fetch: Hono['fetch']) {
		const fastRoutes = this.fastRoutes
		if (
			request.method !== 'GET' ||
			request.body !== null ||
			!fastRoutes.isEnabled()
		)
			return fetch(request, server)
		const path = fastRoutes.getPath(request)
		const matchResult = fastRoutes.match(path)
		const route = matchResult && fastRoutes.getRoute(matchResult)
		if (!route) return fetch(request, server)
		const notFoundHandler = fastRoutes.notFoundHandler as NotFoundHandler
		const exchange = new BunExchange(
			new this.AdapterContext(
				request,
				new ContextOptionsRecord(server, matchResult, notFoundHandler, path)
			),
			this.hono,
			notFoundHandler
		)
		return new Promise<Response>(resolve => {
			exchange.resolve = resolve as Resolve
			exchange.dispatch(this.prepare, route)
		})
	}
}

/**
 * Creates the fast path on Bun when the adapter-owned `Context` class passes
 * its self-check, or returns `undefined`, which hands every request to
 * `hono.fetch()` as before.
 */
export function createBunFastPath(options: FastPathOptions) {
	if (typeof Bun === 'undefined' || options.adapterOptions.runtime === 'node')
		return
	const AdapterContext = getAdapterContextClass(false)
	if (!AdapterContext) return
	return new BunFastPath(options, AdapterContext)
}
