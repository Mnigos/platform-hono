import type { Context } from 'hono'
import { extractClientIp } from '../helpers/client-ip'
import { isPathMatch } from '../helpers/path-matching'
import { getNestHonoRequest, type NestHonoRequest } from '../helpers/request'
import type { HonoAdapterOptions } from '../options'
import {
	type ContextTracking,
	trackContext,
} from '../response/context-tracking'
import {
	getResponseHeaders,
	getSseBridge,
	type SseBridge,
} from '../response/sse-bridge'
import {
	getNodeBindings,
	getRequestHeader,
	isTransportFramed,
	type NodeIncoming,
	readRequestHeader,
} from './request-headers'
import {
	createRequestSocketBridge,
	type RequestSocketBridge,
} from './socket-bridge'

type Listener = (...args: unknown[]) => void

/**
 * Per-request adapter state, computed once and shared by every middleware and
 * route layer instead of being recomputed per layer.
 */
export interface RequestState extends ContextTracking {
	contentType?: string | null
	ctx: Context
	currentRaw?: Request
	headers?: Record<string, string>
	incoming?: NodeIncoming
	ip?: string | null
	method: string
	on: (event: string, listener: Listener) => unknown
	options: HonoAdapterOptions
	pathname: string
	pendingRawRequest?: () => Request
	rawRequest: Request
	routeParams?: Record<string, string>
	skipBodyParser?: boolean
	socketBridge?: RequestSocketBridge
	sse?: SseBridge
	sseWaiter?: (response: Response) => void
}

const REQUEST_STATE = Symbol('platformHonoRequestState')

interface StateCarrier {
	on?: unknown
	socket?: unknown
	[REQUEST_STATE]: RequestState
}

function getSocketBridge(state: RequestState) {
	const socket = state.incoming?.socket
	if (!socket) return
	state.socketBridge ??= createRequestSocketBridge(socket)
	return state.socketBridge
}

function defineValue(target: object, name: string, value: unknown) {
	Object.defineProperty(target, name, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	})
}

const REQUEST_ACCESSORS = {
	headers: {
		configurable: true,
		enumerable: true,
		get(this: StateCarrier) {
			const state = this[REQUEST_STATE]
			state.headers ??= Object.fromEntries(state.rawRequest.headers)
			return state.headers
		},
		set(this: StateCarrier, value: unknown) {
			defineValue(this, 'headers', value)
		},
	},
	ip: {
		configurable: true,
		enumerable: true,
		get(this: StateCarrier) {
			const state = this[REQUEST_STATE]
			if (state.ip === undefined)
				state.ip =
					extractClientIp(state.ctx, state.options, state.rawRequest) ?? null
			return state.ip ?? undefined
		},
		set(this: StateCarrier, value: unknown) {
			defineValue(this, 'ip', value)
		},
	},
} as const satisfies PropertyDescriptorMap

const LAZY_RAW_ACCESSOR = {
	configurable: true,
	enumerable: true,
	get(this: StateCarrier) {
		return materializeRawRequest(this[REQUEST_STATE])
	},
	set(this: StateCarrier, value: unknown) {
		const state = this[REQUEST_STATE]
		state.pendingRawRequest = undefined
		defineValue(this, 'raw', value)
		syncRawRequest(state)
	},
} as const satisfies PropertyDescriptor

function materializeRawRequest(state: RequestState) {
	const { ctx, pendingRawRequest } = state
	state.pendingRawRequest = undefined
	const rawRequest = pendingRawRequest ? pendingRawRequest() : state.rawRequest
	defineValue(ctx.req, 'raw', rawRequest)
	syncRawRequest(state)
	return rawRequest
}

/**
 * Replaces `ctx.req.raw` with a request built on first access, so an unread
 * copy of an already consumed body is only created when something reads it.
 * Falls back to an immediate replacement outside adapter-managed requests.
 */
export function replaceRawRequest(
	ctx: Context,
	createRawRequest: () => Request
) {
	const state = (
		getNestHonoRequest(ctx.req) as NestHonoRequest & Partial<StateCarrier>
	)[REQUEST_STATE]
	if (!state) {
		ctx.req.raw = createRawRequest()
		return
	}
	state.pendingRawRequest = createRawRequest
	Object.defineProperty(ctx.req, 'raw', LAZY_RAW_ACCESSOR)
}

const SOCKET_ACCESSOR = {
	configurable: true,
	enumerable: true,
	get(this: StateCarrier) {
		return getSocketBridge(this[REQUEST_STATE])?.socket
	},
	set(this: StateCarrier, value: unknown) {
		defineValue(this, 'socket', value)
	},
} as const satisfies PropertyDescriptor

function getContextState(ctx: Context) {
	return (getNestHonoRequest(ctx.req) as NestHonoRequest & StateCarrier)[
		REQUEST_STATE
	]
}

const CONTEXT_RAW_ACCESSOR = {
	configurable: true,
	enumerable: true,
	get(this: Context) {
		return getSseBridge(getContextState(this)).stream
	},
	set(this: Context, value: unknown) {
		defineValue(this, 'raw', value)
	},
} as const satisfies PropertyDescriptor

function requestOn(state: RequestState, event: string, listener: Listener) {
	const { ctx } = state
	const req = getNestHonoRequest(ctx.req)
	const { incoming, outgoing } = getNodeBindings(ctx)
	if (event !== 'close') return incoming ? incoming.on(event, listener) : req

	const socket = getSocketBridge(state)?.socket
	const signal = state.rawRequest.signal
	const sseStream = state.sse?.stream
	let called = false
	const cleanup = () => {
		signal.removeEventListener('abort', invokeListener)
		socket?.removeListener('close', invokeListener)
		sseStream?.removeListener('close', invokeListener)
		outgoing?.removeListener('close', invokeListener)
	}
	const invokeListener = (...args: unknown[]) => {
		if (called) return
		called = true
		cleanup()
		listener(...args)
	}
	if (signal.aborted) queueMicrotask(invokeListener)
	else {
		signal.addEventListener('abort', invokeListener, { once: true })
		socket?.once('close', invokeListener)
		sseStream?.once('close', invokeListener)
		outgoing?.once('close', invokeListener)
	}
	return req
}

/**
 * Returns the path of an already serialized request URL without parsing it
 * again with `new URL()`.
 */
export function getUrlPathname(url: string) {
	const start = url.indexOf('/', url.indexOf(':') + 3)
	if (start === -1) return '/'
	let end = start
	while (end < url.length) {
		const charCode = url.charCodeAt(end)
		if (charCode === 63 || charCode === 35) break
		end += 1
	}
	return url.slice(start, end)
}

/**
 * Recomputes request metadata after middleware replaced `ctx.req.raw`, for
 * example to rewrite the URL. The original transport request stays in
 * `state.rawRequest` for runtime APIs such as Bun's `requestIP()`.
 */
function adoptReplacedRequest(state: RequestState, rawRequest: Request) {
	state.currentRaw = rawRequest
	state.contentType = undefined
	state.method = rawRequest.method
	state.pathname = getUrlPathname(rawRequest.url)
	state.skipBodyParser = undefined
	getNestHonoRequest(state.ctx.req).baseUrl = state.pathname
}

/**
 * Attaches the Nest `req.on()` bridge and, on Node.js, the lazy socket bridge
 * to the current raw request. Call it again after `ctx.req.raw` is replaced.
 */
export function syncRawRequest(state: RequestState) {
	if (state.pendingRawRequest) return
	const rawRequest = state.ctx.req.raw as Request & Partial<StateCarrier>
	if (rawRequest[REQUEST_STATE] === state) return
	if (rawRequest !== state.rawRequest) adoptReplacedRequest(state, rawRequest)
	rawRequest[REQUEST_STATE] = state
	rawRequest.on = state.on
	if (state.incoming?.socket && !rawRequest.socket)
		Object.defineProperty(rawRequest, 'socket', SOCKET_ACCESSOR)
}

/**
 * Returns the request state, creating it on first use. Request fields Nest
 * reads (`headers`, `ip`, `baseUrl`, `on`) are attached once; `ip` and
 * `headers` are computed only when read. `query` lives on the Nest request
 * view (`getNestRequest`), so Hono's `ctx.req.query()` is never shadowed.
 */
export function getRequestState(ctx: Context, options: HonoAdapterOptions) {
	const req = getNestHonoRequest(ctx.req) as NestHonoRequest &
		Partial<StateCarrier>
	const existingState = req[REQUEST_STATE]
	if (existingState) return existingState

	const rawRequest = ctx.req.raw
	const state: RequestState = {
		ctx,
		incoming: getNodeBindings(ctx).incoming,
		method: rawRequest.method,
		on: (event, listener) => requestOn(state, event, listener),
		options,
		pathname: getUrlPathname(rawRequest.url),
		rawRequest,
		touched: false,
	}
	req[REQUEST_STATE] = state
	if (req.ip === undefined) {
		if (state.incoming && !options.trustProxy)
			req.ip = state.incoming.socket?.remoteAddress || undefined
		else Object.defineProperty(req, 'ip', REQUEST_ACCESSORS.ip)
	}
	if (req.headers === undefined)
		Object.defineProperty(req, 'headers', REQUEST_ACCESSORS.headers)
	Object.defineProperty(ctx, 'raw', CONTEXT_RAW_ACCESSOR)
	trackContext(ctx, state)
	;(ctx as Context & { getHeaders?: unknown }).getHeaders = () =>
		getResponseHeaders(ctx)
	if (state.incoming?.socket && !req.socket)
		Object.defineProperty(req, 'socket', SOCKET_ACCESSOR)
	req.baseUrl = state.pathname
	req.on = state.on
	syncRawRequest(state)
	return state
}

/**
 * Whether `skipBodyParserFor` matches the request path, computed once.
 */
export function shouldSkipBodyParser(state: RequestState) {
	state.skipBodyParser ??= (state.options.skipBodyParserFor ?? []).some(path =>
		isPathMatch(state.pathname, path)
	)
	return state.skipBodyParser
}

function getExistingState(ctx: Context) {
	return (
		getNestHonoRequest(ctx.req) as NestHonoRequest & Partial<StateCarrier>
	)[REQUEST_STATE]
}

/**
 * Whether `ctx.req.raw` is still the request the server received. Requests
 * replaced by middleware (or created by the adapter after parsing) were never
 * framed by the runtime, so their bodies must be counted.
 */
function isOriginalRequest(state: RequestState) {
	return !state.pendingRawRequest && state.ctx.req.raw === state.rawRequest
}

/**
 * Reads a header of the current request: from Node's parsed headers while the
 * original request is in place, from the replacement request otherwise.
 */
export function getCurrentRequestHeader(ctx: Context, name: string) {
	const state = getExistingState(ctx)
	if (!state) return getRequestHeader(ctx, name)
	if (isOriginalRequest(state))
		return readRequestHeader(state.rawRequest, state.incoming, name)
	const request = state.pendingRawRequest
		? (state.currentRaw ?? state.rawRequest)
		: ctx.req.raw
	return request.headers.get(name) ?? undefined
}

/**
 * Whether the request body is framed by the server (`Content-Length` can be
 * trusted): the transport request is unchanged and came through
 * `@hono/node-server` or `Bun.serve`.
 */
export function hasTrustedFraming(ctx: Context) {
	const state = getExistingState(ctx)
	return (
		state !== undefined && isOriginalRequest(state) && isTransportFramed(ctx)
	)
}
