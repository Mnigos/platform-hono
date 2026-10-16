import { type IncomingMessage, ServerResponse } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { getLightweightResponse } from './node-response'

/**
 * `[status, body, headers]` of a `@hono/node-server` lightweight response
 * that has not been converted to a native `Response`.
 */
export type ResponseCache = [number, unknown, unknown]

/**
 * Writes a cached lightweight response with a string body and no or plain
 * object headers, or returns `false`, without writing, for any other response.
 */
export type CachedResponseWriter = (
	outgoing: ServerResponse,
	cache: ResponseCache
) => boolean

type OutgoingHeaders = Record<string, number | string | string[]>

interface Http1Outgoing extends ServerResponse {
	_contentLength: number | null
	_hasBody: boolean
	_removedContLen: boolean
	outputData: { data: unknown }[]
}

interface ProbeResponse {
	body: string
	headers?: OutgoingHeaders
	httpVersionMinor: number
	status?: number
}

const DEFAULT_CONTENT_TYPE = 'text/plain; charset=UTF-8'
const JSON_HEADERS = { 'content-type': 'application/json' }
const PROBE_RESPONSES: readonly ProbeResponse[] = [
	{ body: 'probe', httpVersionMinor: 1 },
	{ body: 'probe', httpVersionMinor: 1, status: 204 },
	{ body: '{"ok":true}', headers: JSON_HEADERS, httpVersionMinor: 1 },
	{ body: '{"ok":true}', headers: JSON_HEADERS, httpVersionMinor: 0 },
	{ body: '', headers: JSON_HEADERS, httpVersionMinor: 1, status: 304 },
	{
		body: 'zażółć',
		headers: { 'Content-Length': 10, 'set-cookie': ['a=1', 'b=2'] },
		httpVersionMinor: 1,
	},
]

const noop = () => undefined

function isPlainObject(value: unknown): value is OutgoingHeaders {
	return (
		value !== null &&
		typeof value === 'object' &&
		Object.getPrototypeOf(value) === Object.prototype
	)
}

function isHeader(key: string, name: string) {
	return key.length === name.length && key.toLowerCase() === name
}

/**
 * Lets Node.js add `Content-Length` itself, as `@hono/node-server` 2.1.2+
 * does when nothing else decides the framing.
 */
function trySetContentLength(
	outgoing: ServerResponse,
	status: number,
	length: number
) {
	const http1 = outgoing as Http1Outgoing
	if (
		http1._contentLength !== null ||
		!http1._hasBody ||
		!http1.useChunkedEncodingByDefault ||
		http1._removedContLen ||
		status < 200 ||
		status === 204 ||
		status === 304 ||
		outgoing.hasHeader('content-length') ||
		outgoing.hasHeader('transfer-encoding') ||
		outgoing.hasHeader('trailer')
	)
		return false
	http1._contentLength = length
	return true
}

function getFramedHeaders(
	outgoing: ServerResponse,
	status: number,
	body: string,
	headers: OutgoingHeaders
) {
	let canAutoLength = true
	for (const key of Object.keys(headers)) {
		if (isHeader(key, 'content-length')) return headers
		if (isHeader(key, 'transfer-encoding') || isHeader(key, 'trailer'))
			canAutoLength = false
	}
	const length = Buffer.byteLength(body)
	if (canAutoLength && trySetContentLength(outgoing, status, length))
		return headers
	return { ...headers, 'Content-Length': length }
}

/** `responseViaCache()` of `@hono/node-server` 2.1.2 and later. */
const writeWithNodeLength: CachedResponseWriter = (
	outgoing,
	[status, body, headers]
) => {
	if (typeof body !== 'string') return false
	if (headers === undefined) {
		const length = Buffer.byteLength(body)
		outgoing.writeHead(
			status,
			trySetContentLength(outgoing, status, length)
				? { 'Content-Type': DEFAULT_CONTENT_TYPE }
				: { 'Content-Type': DEFAULT_CONTENT_TYPE, 'Content-Length': length }
		)
	} else if (isPlainObject(headers))
		outgoing.writeHead(
			status,
			getFramedHeaders(outgoing, status, body, headers)
		)
	else return false
	outgoing.end(body)
	return true
}

/**
 * `responseViaCache()` of `@hono/node-server` before 2.1.2, which adds
 * `Content-Length` to the response's own header object.
 */
const writeWithContentLength: CachedResponseWriter = (
	outgoing,
	[status, body, headers]
) => {
	if (typeof body !== 'string') return false
	if (headers === undefined)
		outgoing.writeHead(status, {
			'Content-Type': DEFAULT_CONTENT_TYPE,
			'Content-Length': Buffer.byteLength(body),
		})
	else if (isPlainObject(headers)) {
		if (!Object.keys(headers).some(key => isHeader(key, 'content-length')))
			headers['Content-Length'] = Buffer.byteLength(body)
		outgoing.writeHead(status, headers)
	} else return false
	outgoing.end(body)
	return true
}

function createProbeOutgoing(httpVersionMinor: number) {
	const outgoing = new ServerResponse({
		headers: {},
		httpVersionMajor: 1,
		httpVersionMinor,
		method: 'GET',
	} as IncomingMessage) as Http1Outgoing
	outgoing.sendDate = false
	return outgoing
}

function readOutput(outgoing: Http1Outgoing) {
	return outgoing.outputData.map(({ data }) => String(data)).join('')
}

/**
 * Whether a writer writes the same bytes as the installed
 * `@hono/node-server` for every probe response and leaves the response's
 * header object the same.
 */
function writesLikeNodeServer(
	write: CachedResponseWriter,
	responseCacheKey: symbol
) {
	const LightweightResponse = getLightweightResponse()
	return PROBE_RESPONSES.every(
		({ body, headers, httpVersionMinor, status }) => {
			const createResponse = () =>
				new LightweightResponse(body, {
					headers: headers && ({ ...headers } as ResponseInit['headers']),
					status,
				}) as Response & Record<symbol, ResponseCache | undefined>
			const expected = createResponse()
			const expectedOutgoing = createProbeOutgoing(httpVersionMinor)
			getRequestListener(() => expected, { overrideGlobalObjects: false })(
				{ headers: { host: 'localhost' }, method: 'GET', url: '/' } as never,
				expectedOutgoing
			).catch(noop)
			const cache = createResponse()[responseCacheKey]
			const actualOutgoing = createProbeOutgoing(httpVersionMinor)
			return (
				cache !== undefined &&
				write(actualOutgoing, cache) &&
				readOutput(actualOutgoing) === readOutput(expectedOutgoing) &&
				JSON.stringify(cache[2]) ===
					JSON.stringify(expected[responseCacheKey]?.[2])
			)
		}
	)
}

let cachedResponseWriter: CachedResponseWriter | null | undefined

/**
 * Returns the writer that matches the installed `@hono/node-server`, picked
 * once by comparing their output on probe responses, or `undefined` when none
 * does, which leaves every response to `@hono/node-server`'s own writer.
 */
export function getCachedResponseWriter(responseCacheKey: symbol) {
	if (cachedResponseWriter === undefined) {
		try {
			cachedResponseWriter =
				[writeWithNodeLength, writeWithContentLength].find(write =>
					writesLikeNodeServer(write, responseCacheKey)
				) ?? null
		} catch {
			cachedResponseWriter = null
		}
	}
	return cachedResponseWriter ?? undefined
}
