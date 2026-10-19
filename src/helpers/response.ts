import { Readable } from 'node:stream'
import { StreamableFile } from '@nestjs/common'
import type { Context } from 'hono'
import { getUntouchedTracking } from '../response/context-tracking'
import {
	createFetchResponse,
	createNodeStreamResponse,
	createStreamableFileResponse,
	createStreamResponse,
	getClientSocket,
} from '../response/stream-response'
import {
	getLightweightResponse,
	withLightweightResponse,
} from '../server/node-response'

/**
 * The response stored on a context and the response it was built from.
 * Per-request records are built by constructors, not object literals, so V8
 * cannot pretenure them (see `RequestStateRecord`).
 */
class FinalizedResponse {
	response: Response
	source: Response

	constructor(response: Response, source: Response) {
		this.response = response
		this.source = source
	}
}

const FINALIZED_RESPONSE = Symbol('platformHonoFinalizedResponse')
/**
 * `Content-Type` of direct JSON replies built with the native `Response`,
 * which copies init headers, so one `Headers` instance serves every reply and
 * spares converting a header object per reply.
 */
const JSON_HEADERS = new Headers({ 'content-type': 'application/json' })
const FINALIZE_LISTENERS = Symbol('platformHonoFinalizeListeners')

interface FinalizableContext extends Context {
	[FINALIZED_RESPONSE]?: FinalizedResponse
	[FINALIZE_LISTENERS]?: Set<() => void>
}

/**
 * Registers a listener called when a response is finalized on the Hono
 * context and returns a function that removes it.
 */
export function onResponseFinalized(ctx: Context, listener: () => void) {
	const finalizable = ctx as FinalizableContext
	const listeners = finalizable[FINALIZE_LISTENERS] ?? new Set()
	listeners.add(listener)
	finalizable[FINALIZE_LISTENERS] = listeners
	return () => listeners.delete(listener)
}

/**
 * Reads `ctx.res` once so Hono creates its response from the headers prepared
 * with `ctx.header()`; Hono's `res` setter then merges them into the
 * response assigned next.
 */
function materializeContextResponse(ctx: Context) {
	return ctx.res
}

/**
 * Stores the Fetch response on the Hono context and returns it for Hono's
 * middleware pipeline. Pass `includesContextHeaders` for responses built with
 * `ctx.body()`/`ctx.newResponse()`, which already carry the context headers,
 * so Hono does not copy the response to merge the same headers again. Other
 * responses (a native `Response`, a fetch body) first materialize `ctx.res`,
 * so headers set with `ctx.header()` are merged into them.
 */
export function finalizeResponse(
	ctx: Context,
	response: Response,
	includesContextHeaders = false
) {
	const finalizable = ctx as FinalizableContext
	const finalized = finalizable[FINALIZED_RESPONSE]
	if (
		ctx.finalized &&
		(finalized?.response === response || finalized?.source === response)
	) {
		return finalized.response
	}

	if (includesContextHeaders) ctx.res = undefined
	else materializeContextResponse(ctx)
	ctx.res = response
	const contextResponse = ctx.res
	finalizable[FINALIZED_RESPONSE] = new FinalizedResponse(
		contextResponse,
		response
	)
	const listeners = finalizable[FINALIZE_LISTENERS]
	if (listeners) for (const listener of listeners) listener()
	return contextResponse
}

export function isJsonContentType(contentType: string | null) {
	if (contentType === null) return false
	if (contentType === 'application/json') return true
	const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
	return mediaType === 'application/json' || mediaType?.endsWith('+json')
}

class BuiltResponse {
	includesContextHeaders: boolean
	response: Response

	constructor(includesContextHeaders: boolean, response: Response) {
		this.includesContextHeaders = includesContextHeaders
		this.response = response
	}
}

/** `ResponseInit` of a direct reply, kept by `@hono/node-server`'s response. */
class DirectResponseInit implements ResponseInit {
	headers?: ResponseInit['headers']
	status: number

	constructor(status: number, headers?: ResponseInit['headers']) {
		this.headers = headers
		this.status = status
	}
}

const fromContext = (response: Response) => new BuiltResponse(true, response)

const fromElsewhere = (response: Response) => new BuiltResponse(false, response)

function buildResponse(ctx: Context, body?: unknown): BuiltResponse {
	if (body instanceof Response)
		return fromElsewhere(createFetchResponse(ctx, body))

	if (body instanceof StreamableFile)
		return fromContext(createStreamableFileResponse(ctx, body))

	if (body instanceof Readable)
		return fromContext(createNodeStreamResponse(ctx, body))

	if (body instanceof ReadableStream)
		return fromContext(createStreamResponse(ctx, body))

	const finalized = (ctx as FinalizableContext)[FINALIZED_RESPONSE]
	if (body === undefined && finalized) return fromElsewhere(finalized.response)

	if (body === undefined && ctx.res && ctx.res.body !== null) {
		return fromElsewhere(ctx.res)
	}

	const directResponse = buildDirectResponse(ctx, body)
	if (directResponse) return fromContext(directResponse)

	if (typeof body === 'object' && !(body instanceof Buffer))
		return fromContext(createJsonResponse(ctx, body))
	if (body instanceof Buffer)
		return fromContext(createBufferResponse(ctx, body))

	return fromContext(
		withNodeResponse(ctx, () =>
			body === undefined
				? ctx.newResponse(null)
				: ctx.body(body as unknown as string)
		)
	)
}

/**
 * Builds string and JSON replies directly while no middleware or handler has
 * touched the Hono response state, which gives the same response as Hono's
 * `ctx.body()`/`ctx.newResponse()` without merging empty header sets. On
 * Node.js the plain header object lets `@hono/node-server` write the head
 * without converting a `Headers` instance. The header object is created per
 * response because `@hono/node-server` adds `Content-Length` to it; the
 * native `Response` (Bun, direct `hono.fetch()` calls) copies the shared
 * `JSON_HEADERS` instead.
 */
function buildDirectResponse(ctx: Context, body: unknown) {
	const isJson = typeof body === 'object' && !(body instanceof Buffer)
	if (!(isJson || typeof body === 'string')) return
	const tracking = getUntouchedTracking(ctx)
	if (!tracking || contextsWithHeaders.has(ctx)) return
	const ResponseClass = getClientSocket(ctx)
		? getLightweightResponse()
		: Response
	const status = tracking.statusCode ?? 200
	if (!isJson)
		return new ResponseClass(body as string, new DirectResponseInit(status))
	if (ResponseClass === Response)
		return new Response(
			JSON.stringify(body),
			new DirectResponseInit(status, JSON_HEADERS)
		)
	const headers: Record<string, string> = Object.create(Object.prototype)
	headers['content-type'] = 'application/json'
	return new ResponseClass(
		JSON.stringify(body),
		new DirectResponseInit(status, headers)
	)
}

function createBufferResponse(ctx: Context, body: Buffer) {
	const responseContentType = ctx.res.headers.get('Content-Type')
	if (!responseContentType || responseContentType.startsWith('text/plain'))
		ctx.res.headers.set('Content-Type', 'application/octet-stream')
	return withNodeResponse(ctx, () => ctx.body(body as unknown as string))
}

const contextsWithHeaders = new WeakSet<Context>()

/**
 * Records that response headers were set through the adapter, so object
 * replies read the `Content-Type` before serializing instead of after.
 */
export function markResponseHeadersSet(ctx: Context) {
	contextsWithHeaders.add(ctx)
}

function usesJsonBody(contentType: string | null) {
	return (
		contentType === null ||
		contentType.startsWith('text/plain') ||
		isJsonContentType(contentType)
	)
}

function createPlainResponse(ctx: Context, body: object | null) {
	return withNodeResponse(ctx, () => ctx.body(body as unknown as string))
}

function createSerializedResponse(ctx: Context, json: string) {
	const response = withNodeResponse(ctx, () => ctx.newResponse(json))
	const contentType = response.headers.get('Content-Type')
	if (contentType === null || contentType.startsWith('text/plain'))
		response.headers.set('Content-Type', 'application/json')
	return response
}

/**
 * Serializes object bodies (and `null`) as JSON. A missing or `text/plain`
 * type becomes `application/json`, JSON types are kept, and any other
 * explicit type keeps the plain body conversion. When headers were set
 * through the adapter, the type is checked before serializing; otherwise the
 * type is read from the built response, which avoids materializing
 * `ctx.res`, and a serialization error falls back to the type check.
 */
function createJsonResponse(ctx: Context, body: object | null) {
	if (contextsWithHeaders.has(ctx)) {
		if (!usesJsonBody(ctx.res.headers.get('Content-Type')))
			return createPlainResponse(ctx, body)
		return createSerializedResponse(ctx, JSON.stringify(body))
	}

	let json: string
	try {
		json = JSON.stringify(body)
	} catch (error) {
		if (usesJsonBody(ctx.res.headers.get('Content-Type'))) throw error
		return createPlainResponse(ctx, body)
	}
	const response = createSerializedResponse(ctx, json)
	if (usesJsonBody(response.headers.get('Content-Type'))) return response
	return createPlainResponse(ctx, body)
}

function withNodeResponse(ctx: Context, build: () => Response) {
	return getClientSocket(ctx) ? withLightweightResponse(build) : build()
}

/**
 * Converts Nest reply bodies into Hono responses while preserving already-built
 * responses and inferring JSON/binary content types when Nest has not set one.
 */
export function createResponse(ctx: Context, body?: unknown) {
	return buildResponse(ctx, body).response
}

/**
 * Builds and stores the final Hono response in one step for handlers that need
 * to return the response immediately.
 */
export function getFinalizedResponse(ctx: Context, body?: unknown) {
	const { includesContextHeaders, response } = buildResponse(ctx, body)
	return finalizeResponse(ctx, response, includesContextHeaders)
}
