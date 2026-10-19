import type { Context } from 'hono'
import { getBunServer } from '../helpers/bun-server'
import type { RequestState } from './request-state-core'
import type { NodeSocketLike } from './socket-bridge'

type Listener = (...args: unknown[]) => void

export interface NodeIncoming {
	headers: Record<string, string | string[] | undefined>
	on: (event: string, listener: Listener) => unknown
	socket?: NodeSocketLike & { remoteAddress?: string }
}

export interface NodeRequestBindings {
	incoming?: NodeIncoming
	outgoing?: NodeSocketLike
}

/**
 * Returns the `@hono/node-server` bindings (`incoming`, `outgoing`) of a
 * request, or an empty object on other runtimes.
 */
export function getNodeBindings(ctx: Context) {
	return (ctx.env as NodeRequestBindings | undefined) ?? {}
}

/**
 * Reads a request header from Node's parsed `IncomingMessage` headers when
 * available, avoiding a Fetch `Headers` allocation on the Node.js path.
 */
export function getRequestHeader(ctx: Context, name: string) {
	return readRequestHeader(ctx.req.raw, getNodeBindings(ctx).incoming, name)
}

/**
 * Reads a header from Node's parsed headers or the Fetch request.
 */
export function readRequestHeader(
	rawRequest: Request,
	incoming: NodeIncoming | undefined,
	name: string
) {
	const incomingHeaders = incoming?.headers
	if (!incomingHeaders) return rawRequest.headers.get(name) ?? undefined
	const value = incomingHeaders[name]
	return Array.isArray(value) ? value.join(', ') : value
}

/**
 * Whether the request arrived through a server that enforces HTTP framing
 * (`@hono/node-server` or `Bun.serve`), so its body cannot be longer than the
 * declared `Content-Length`. Direct `hono.fetch()`/`hono.request()` calls are
 * not framed and must have their bodies counted.
 */
export function isTransportFramed(ctx: Context) {
	return (
		getNodeBindings(ctx).incoming !== undefined ||
		getBunServer(ctx) !== undefined
	)
}

/**
 * Whether the request can carry a body. For transport-framed requests,
 * HTTP/1.1 requests without `Content-Length` or `Transfer-Encoding` have none,
 * and `Bun.serve` never exposes `GET`/`HEAD` bodies, so body limits can skip
 * them without touching the body stream. Other requests are checked by body.
 */
export function mayHaveRequestBody(state: RequestState) {
	const { incoming, method, rawRequest } = state
	const currentRequest = state.ctx.req.raw
	if (currentRequest !== rawRequest || !(incoming || getBunServer(state.ctx)))
		return currentRequest.body !== null
	if (!incoming && (method === 'GET' || method === 'HEAD')) return false
	if (
		readRequestHeader(rawRequest, incoming, 'transfer-encoding') !== undefined
	)
		return true
	const contentLength = readRequestHeader(
		rawRequest,
		incoming,
		'content-length'
	)
	return contentLength !== undefined && contentLength !== '0'
}

/**
 * The request `Content-Type`, read once per request.
 */
export function getContentType(state: RequestState) {
	if (state.contentType === undefined)
		state.contentType =
			(state.currentRaw
				? state.currentRaw.headers.get('content-type')
				: readRequestHeader(
						state.rawRequest,
						state.incoming,
						'content-type'
					)) ?? null
	return state.contentType ?? undefined
}
