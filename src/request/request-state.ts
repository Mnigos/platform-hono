import type { Context } from 'hono'
import { isPathMatch } from '../helpers/path-matching'
import { getNestHonoRequest, type NestHonoRequest } from '../helpers/request'
import type { HonoAdapterOptions } from '../options'
import { trackContext } from '../response/context-tracking'
import { getResponseHeaders } from '../response/sse-bridge'
import { defineOwnAccessors, isAdapterContext } from './request-accessors'
import {
	getNodeBindings,
	getRequestHeader,
	isTransportFramed,
	type NodeIncoming,
	readRequestHeader,
} from './request-headers'
import {
	getExistingState,
	getSocketBridge,
	getUrlPathname,
	type Listener,
	REQUEST_STATE,
	type RequestState,
	type StateCarrier,
	syncRawRequest,
} from './request-state-core'

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
 * Request state built by a constructor instead of an object literal. V8 can
 * pretenure an object literal's allocation site (allocate it straight in old
 * space) after a burst of surviving objects; a pretenured state then keeps the
 * request's whole context alive until the next full GC, which made Nest 12 on
 * Node.js spend most of its time in GC.
 */
class RequestStateRecord implements RequestState {
	ctx: Context
	incoming?: NodeIncoming
	method: string
	on: RequestState['on']
	options: HonoAdapterOptions
	pathname: string
	rawRequest: Request
	touched = false

	constructor(ctx: Context, options: HonoAdapterOptions) {
		const rawRequest = ctx.req.raw
		this.ctx = ctx
		this.incoming = getNodeBindings(ctx).incoming
		this.method = rawRequest.method
		this.on = (event, listener) => requestOn(this, event, listener)
		this.options = options
		this.pathname = getUrlPathname(rawRequest.url)
		this.rawRequest = rawRequest
	}
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

	const state: RequestState = new RequestStateRecord(ctx, options)
	req[REQUEST_STATE] = state
	if (!isAdapterContext(ctx)) defineOwnAccessors(ctx, req, state)
	else if (state.incoming && !options.trustProxy)
		state.ip = state.incoming.socket?.remoteAddress || null
	trackContext(ctx, state)
	;(ctx as Context & { getHeaders?: unknown }).getHeaders = () =>
		getResponseHeaders(ctx)
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
