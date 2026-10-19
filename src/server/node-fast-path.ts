import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { getRequestListener } from '@hono/node-server'
import type { Context, Hono, NotFoundHandler } from 'hono'
import { prepareRequest } from '../request/request-layer'
import { FastExchange } from './fast-dispatch'
import { type FastPathOptions, FastRoutes } from './fast-routes'
import {
	type ContextClass,
	ContextOptionsRecord,
	getAdapterContextClass,
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

/**
 * `ctx.env` as `@hono/node-server` passes it, created without an object
 * literal (see `RequestStateRecord`) but with the same keys and prototype.
 */
interface NodeEnv {
	incoming: IncomingMessage
	outgoing: ServerResponse
}

interface FastPathRuntime {
	AdapterContext: ContextClass
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

/** A fast path request on Node.js, answered on its `ServerResponse`. */
class NodeExchange extends FastExchange {
	readonly incoming: IncomingMessage
	readonly outgoing: ServerResponse
	private readonly fastPath: NodeFastPath

	constructor(
		ctx: Context,
		hono: Hono,
		notFoundHandler: NotFoundHandler,
		fastPath: NodeFastPath,
		incoming: IncomingMessage,
		outgoing: ServerResponse
	) {
		super(ctx, hono, notFoundHandler)
		this.fastPath = fastPath
		this.incoming = incoming
		this.outgoing = outgoing
	}

	protected respond(result: unknown) {
		this.fastPath.respond(this, result)
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
export class NodeFastPath {
	private readonly fastRoutes: FastRoutes
	private readonly hono: Hono
	private readonly prepare: (ctx: Context) => void
	private prepared?: Promise<unknown>
	private readonly runtime: FastPathRuntime
	private verbatimHost?: string
	private readonly writer: NodeListener

	constructor(options: FastPathOptions, runtime: FastPathRuntime) {
		const { adapterOptions, hono, securityHooks } = options
		this.fastRoutes = new FastRoutes(options)
		this.hono = hono
		this.prepare = ctx => prepareRequest(ctx, adapterOptions, securityHooks)
		this.runtime = runtime
		this.writer = getRequestListener(() => this.takePrepared(), {
			overrideGlobalObjects: false,
		}) as NodeListener
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
	respond({ incoming, outgoing }: NodeExchange, result: unknown) {
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
		const fastRoutes = this.fastRoutes
		if (
			incoming.method !== 'GET' ||
			url === undefined ||
			headers['content-length'] !== undefined ||
			headers['transfer-encoding'] !== undefined ||
			headers['content-type'] !== undefined ||
			!fastRoutes.isEnabled()
		)
			return false
		const { host } = headers
		if (!(host && this.isVerbatimHost(host))) return false
		const path = getVerbatimPath(url)
		if (path === undefined) return false
		const matchResult = fastRoutes.match(path)
		const route = matchResult && fastRoutes.getRoute(matchResult)
		if (!route) return false
		const notFoundHandler = fastRoutes.notFoundHandler as NotFoundHandler

		const request = this.createRequest(incoming, host, url)
		const env: NodeEnv = Object.create(Object.prototype)
		env.incoming = incoming
		env.outgoing = outgoing
		const exchange = new NodeExchange(
			new this.runtime.AdapterContext(
				request,
				new ContextOptionsRecord(env, matchResult, notFoundHandler, path)
			),
			this.hono,
			notFoundHandler,
			this,
			incoming,
			outgoing
		)
		exchange.dispatch(this.prepare, route)
		outgoing.on(
			'close',
			createAbortOnClose(this.runtime.internals, request, incoming, outgoing)
		)
		return true
	}

	private isVerbatimHost(host: string) {
		if (host === this.verbatimHost) return true
		if (!isVerbatimHost(host)) return false
		this.verbatimHost = host
		return true
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
export function createNodeFastPath(options: FastPathOptions) {
	if (typeof Bun !== 'undefined' || options.adapterOptions.runtime === 'bun')
		return
	const internals = getNodeServerInternals()
	const AdapterContext = getAdapterContextClass(true)
	if (!(internals && AdapterContext)) return
	return new NodeFastPath(options, {
		AdapterContext,
		internals,
		writeCachedResponse: getCachedResponseWriter(internals.responseCacheKey),
	})
}
