import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { getLightweightResponse } from './node-response'

/**
 * The parts of `@hono/node-server` the Node.js fast path reuses: the prototype
 * and symbol keys of its lightweight `Request`, the method that aborts the
 * request's signal, and the key of the lightweight `Response` body cache.
 */
export interface NodeServerInternals {
	abortRequest: symbol
	incomingKey: symbol
	methodKey: symbol
	requestPrototype: object
	responseCacheKey: symbol
	urlKey: symbol
}

type InternalRequest = Request & Record<symbol, unknown>

interface ProbeIncoming {
	errored?: Error
	socket?: { encrypted: boolean }
}

interface ProbeExchange {
	closeHandler?: () => void
	request?: InternalRequest
}

interface CloseCase {
	incoming: ProbeIncoming
	writableFinished: boolean
}

const PREMATURE_CLOSE = 'Client connection prematurely closed.'
const CLOSE_CASES: readonly CloseCase[] = [
	{ incoming: {}, writableFinished: false },
	{ incoming: { errored: new Error('probe') }, writableFinished: false },
	{ incoming: {}, writableFinished: true },
]
const PROBE_TARGETS = [
	['localhost', '/', undefined],
	['127.0.0.1:3000', '/users/42?sort=asc&tags=a,b#top', undefined],
	['example.com', '/a/b', { encrypted: true }],
] as const
const noop = () => undefined

function findSymbol(target: object, description: string) {
	return Object.getOwnPropertySymbols(target).find(
		symbol => symbol.description === description
	)
}

/**
 * Runs one synthetic `GET` request through a `@hono/node-server` listener and
 * returns the lightweight request it created and the `close` handler it
 * attached. The response never settles, so nothing is written.
 */
function runProbe(
	host: string,
	url: string,
	incoming: ProbeIncoming = {},
	writableFinished = false
) {
	const exchange: ProbeExchange = {}
	const listener = getRequestListener(
		request => {
			exchange.request = request as InternalRequest
			return new Promise<Response>(noop)
		},
		{ overrideGlobalObjects: false }
	)
	const outgoing = {
		on(event: string, handler: () => void) {
			if (event === 'close') exchange.closeHandler = handler
		},
		writableFinished,
	}
	listener(
		{ headers: { host }, method: 'GET', url, ...incoming } as never,
		outgoing as never
	).catch(noop)
	return exchange
}

/**
 * Aborts a fast path request when its connection closes before the response
 * finished, with the same reasons as `@hono/node-server`'s close handler.
 */
export function createAbortOnClose(
	internals: NodeServerInternals,
	request: Request,
	incoming: IncomingMessage,
	outgoing: ServerResponse
) {
	return () => {
		const abort = (request as InternalRequest)[internals.abortRequest] as (
			reason: string
		) => void
		if (incoming.errored) abort.call(request, incoming.errored.toString())
		else if (!outgoing.writableFinished) abort.call(request, PREMATURE_CLOSE)
	}
}

/**
 * Whether `createAbortOnClose()` aborts like the installed version's close
 * handler, compared by signal state: a client disconnect, a request error, and
 * a close after the response finished.
 */
function abortsLikeNodeServer(internals: NodeServerInternals) {
	return CLOSE_CASES.every(({ incoming, writableFinished }) => {
		const probe = runProbe('localhost', '/', incoming, writableFinished)
		const copy = runProbe('localhost', '/', incoming).request
		if (!(probe.request && probe.closeHandler && copy)) return false
		probe.closeHandler()
		createAbortOnClose(
			internals,
			copy,
			incoming as unknown as IncomingMessage,
			{ writableFinished } as ServerResponse
		)()
		return (
			probe.request.signal.aborted === copy.signal.aborted &&
			probe.request.signal.reason === copy.signal.reason
		)
	})
}

/**
 * Whether `@hono/node-server` builds requests the way the fast path does: an
 * object with the request prototype and exactly the incoming message, method,
 * and verbatim URL as own symbol properties.
 */
function buildsRequestsLikeFastPath(internals: NodeServerInternals) {
	const { incomingKey, methodKey, requestPrototype, urlKey } = internals
	return PROBE_TARGETS.every(([host, url, socket]) => {
		const request = runProbe(host, url, { socket }).request
		if (!request || Object.getPrototypeOf(request) !== requestPrototype)
			return false
		const keys = Reflect.ownKeys(request)
		const scheme = socket?.encrypted ? 'https' : 'http'
		return (
			keys.length === 3 &&
			keys[0] === incomingKey &&
			keys[1] === methodKey &&
			keys[2] === urlKey &&
			request.method === 'GET' &&
			request.url === `${scheme}://${host}${url}`
		)
	})
}

function captureInternals() {
	const request = runProbe('localhost', '/').request
	if (!request) return
	const requestPrototype = Object.getPrototypeOf(request) as object
	const incomingKey = findSymbol(request, 'incomingKey')
	const methodKey = findSymbol(request, 'methodKey')
	const urlKey = findSymbol(request, 'urlKey')
	const abortRequest = findSymbol(requestPrototype, 'abortRequest')
	const responseCacheKey = findSymbol(
		new (getLightweightResponse())('probe'),
		'cache'
	)
	if (!(incomingKey && methodKey && urlKey && abortRequest && responseCacheKey))
		return
	const internals = {
		abortRequest,
		incomingKey,
		methodKey,
		requestPrototype,
		responseCacheKey,
		urlKey,
	}
	if (
		!(buildsRequestsLikeFastPath(internals) && abortsLikeNodeServer(internals))
	)
		return
	return internals
}

let internals: NodeServerInternals | null | undefined

/**
 * Captures the `@hono/node-server` internals once, by running synthetic
 * requests through its listener, and checks that they behave as the fast path
 * expects. Returns `undefined` when they do not, which turns the fast path
 * off.
 */
export function getNodeServerInternals() {
	if (internals === undefined) {
		try {
			internals = captureInternals() ?? null
		} catch {
			internals = null
		}
	}
	return internals ?? undefined
}
