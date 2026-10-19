import type { Context } from 'hono'
import { getNestHonoRequest, type NestHonoRequest } from '../helpers/request'
import type { HonoAdapterOptions } from '../options'
import type { ContextTracking } from '../response/context-tracking'
import type { SseBridge } from '../response/sse-bridge'
import type { NodeIncoming } from './request-headers'
import {
	createRequestSocketBridge,
	type RequestSocketBridge,
} from './socket-bridge'

export type Listener = (...args: unknown[]) => void

/**
 * Per-request adapter state, computed once and shared by every middleware and
 * route layer instead of being recomputed per layer.
 */
export interface RequestState extends ContextTracking {
	contentType?: string | null
	ctx: Context
	currentRaw?: Request
	headers?: Record<string, string>
	headersSource?: Request
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

export const REQUEST_STATE = Symbol('platformHonoRequestState')

export interface StateCarrier {
	on?: unknown
	socket?: unknown
	[REQUEST_STATE]: RequestState
}

/**
 * The request's socket bridge on Node.js, created on first use.
 */
export function getSocketBridge(state: RequestState) {
	const socket = state.incoming?.socket
	if (!socket) return
	state.socketBridge ??= createRequestSocketBridge(socket)
	return state.socketBridge
}

/**
 * Defines a plain own data property, as an assignment would without the
 * accessor in the way.
 */
export function defineValue(target: object, name: string, value: unknown) {
	Object.defineProperty(target, name, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	})
}

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

export const SOCKET_ACCESSOR = {
	configurable: true,
	enumerable: true,
	get(this: StateCarrier) {
		return getSocketBridge(this[REQUEST_STATE])?.socket
	},
	set(this: StateCarrier, value: unknown) {
		defineValue(this, 'socket', value)
	},
} as const satisfies PropertyDescriptor

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
 * The request Nest-facing metadata describes: the replacement installed by
 * middleware, or the server's request. The adapter's own unread copy of a
 * parsed body has the same headers, so it is not materialized for this.
 */
export function getCurrentRequest(state: RequestState) {
	if (state.pendingRawRequest) return state.currentRaw ?? state.rawRequest
	return state.ctx.req.raw
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
 * The state of an adapter-managed request, if there is one.
 */
export function getExistingState(ctx: Context) {
	return (
		getNestHonoRequest(ctx.req) as NestHonoRequest & Partial<StateCarrier>
	)[REQUEST_STATE]
}
