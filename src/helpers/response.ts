import { Readable } from 'node:stream'
import { StreamableFile } from '@nestjs/common'
import type { Context } from 'hono'
import { withLightweightResponse } from '../server/node-response'

interface FinalizedResponse {
	response: Response
	source: Response
}

interface SocketLike {
	destroyed?: boolean
	off(event: 'close', listener: () => void): void
	once(event: 'close', listener: () => void): void
}

interface NodeRequestEnvironment {
	incoming?: { socket?: SocketLike }
}

const finalizedResponses = new WeakMap<Context, FinalizedResponse>()
const finalizeListeners = new WeakMap<Context, Set<() => void>>()

/**
 * Registers a listener called when a response is finalized on the Hono
 * context and returns a function that removes it.
 */
export function onResponseFinalized(ctx: Context, listener: () => void) {
	const listeners = finalizeListeners.get(ctx) ?? new Set()
	listeners.add(listener)
	finalizeListeners.set(ctx, listeners)
	return () => listeners.delete(listener)
}

/**
 * Stores the Fetch response on the Hono context and returns it for Hono's
 * middleware pipeline. Pass `includesContextHeaders` for responses built with
 * `ctx.body()`/`ctx.newResponse()`, which already carry the context headers,
 * so Hono does not copy the response to merge the same headers again.
 */
export function finalizeResponse(
	ctx: Context,
	response: Response,
	includesContextHeaders = false
) {
	const finalized = finalizedResponses.get(ctx)
	if (
		ctx.finalized &&
		(finalized?.response === response || finalized?.source === response)
	) {
		return finalized.response
	}

	if (includesContextHeaders) ctx.res = undefined
	ctx.res = response
	const contextResponse = ctx.res
	finalizedResponses.set(ctx, { response: contextResponse, source: response })
	for (const listener of finalizeListeners.get(ctx) ?? []) listener()
	return contextResponse
}

function setStreamableFileHeader(
	headers: Headers,
	name: string,
	value: number | string | string[] | undefined
) {
	if (value === undefined || headers.has(name)) return
	headers.set(name, Array.isArray(value) ? value.join(', ') : String(value))
}

function toUint8Array(chunk: unknown) {
	if (typeof chunk === 'string') return new TextEncoder().encode(chunk)
	if (chunk instanceof Uint8Array) return chunk
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)

	const constructorName =
		chunk === null ? 'null' : (new Object(chunk).constructor?.name ?? 'unknown')
	throw new TypeError(
		`Unsupported response stream chunk type: ${typeof chunk}, constructor: ${constructorName}`
	)
}

function getClientSocket(ctx: Context) {
	return (ctx.env as NodeRequestEnvironment | undefined)?.incoming?.socket
}

function registerClientDisconnect(ctx: Context, listener: () => void) {
	const socket = getClientSocket(ctx)
	const signal = ctx.req.raw.signal
	if (socket?.destroyed || signal.aborted) queueMicrotask(listener)
	else {
		socket?.once('close', listener)
		signal.addEventListener('abort', listener, { once: true })
	}

	return () => {
		socket?.off('close', listener)
		signal.removeEventListener('abort', listener)
	}
}

function createByteStream(ctx: Context, stream: ReadableStream<unknown>) {
	const reader = stream.getReader()
	let finished = false
	let cleanup: () => void = () => undefined
	const cancelSource = async (reason?: unknown) => {
		if (finished) return
		finished = true
		cleanup()
		await reader.cancel(reason).catch(() => undefined)
	}
	cleanup = registerClientDisconnect(ctx, () => {
		cancelSource(new Error('Client disconnected')).catch(() => undefined)
	})

	return new ReadableStream<Uint8Array>({
		async cancel(reason) {
			await cancelSource(reason)
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read()
				if (finished || done) {
					finished = true
					cleanup()
					controller.close()
					return
				}
				controller.enqueue(toUint8Array(value))
			} catch (error) {
				await cancelSource(error)
				controller.error(error)
			}
		},
	})
}

/**
 * Converts a Node.js `Readable` into a pull-based Web stream. Unlike
 * `Readable.toWeb()`, a cancelled stream never receives a late `enqueue()`
 * from buffered data, which Node.js reports as an uncaught
 * `ERR_INVALID_STATE` (for example when a `HEAD` request cancels a file).
 */
function toWebStream(readable: Readable) {
	const iterator = readable[Symbol.asyncIterator]()
	let cancelled = false
	return new ReadableStream<unknown>({
		cancel() {
			cancelled = true
			readable.destroy()
			iterator.return?.().catch(() => undefined)
		},
		async pull(controller) {
			const result = await iterator.next().catch(error => {
				if (cancelled) return { done: true, value: undefined }
				throw error
			})
			if (cancelled) return
			if (result.done) controller.close()
			else controller.enqueue(result.value)
		},
	})
}

function createReadableStream(ctx: Context, readable: Readable) {
	return createByteStream(ctx, toWebStream(readable))
}

function createStreamResponse(ctx: Context, stream: ReadableStream<unknown>) {
	const responseContentType = ctx.res.headers.get('Content-Type')
	if (!responseContentType) {
		ctx.res.headers.set('Content-Type', 'application/octet-stream')
	}

	return ctx.body(createByteStream(ctx, stream))
}

function createNodeStreamResponse(ctx: Context, readable: Readable) {
	return createStreamResponse(ctx, toWebStream(readable))
}

function createStreamableFileResponse(ctx: Context, file: StreamableFile) {
	const { disposition, length, type } = file.getHeaders()
	const readable = file.getStream()
	const socket = getClientSocket(ctx)

	setStreamableFileHeader(ctx.res.headers, 'Content-Type', type)
	setStreamableFileHeader(ctx.res.headers, 'Content-Disposition', disposition)
	setStreamableFileHeader(ctx.res.headers, 'Content-Length', length)

	readable.once('error', error => {
		try {
			file.errorHandler(error, {
				get destroyed() {
					return socket?.destroyed ?? ctx.req.raw.signal.aborted
				},
				end() {
					readable.destroy()
				},
				get headersSent() {
					return ctx.finalized
				},
				send(body) {
					ctx.res = ctx.body(body)
				},
				get statusCode() {
					return ctx.res.status
				},
				set statusCode(statusCode) {
					ctx.status(statusCode as Parameters<Context['status']>[0])
				},
			})
		} finally {
			file.errorLogger(error)
		}
	})

	return ctx.body(createReadableStream(ctx, readable))
}

export function isJsonContentType(contentType: string | null) {
	if (contentType === null) return false
	if (contentType === 'application/json') return true
	const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
	return mediaType === 'application/json' || mediaType?.endsWith('+json')
}

function createFetchResponse(ctx: Context, response: Response) {
	if (!response.body) return response
	return new Response(createByteStream(ctx, response.body), {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	})
}

interface BuiltResponse {
	includesContextHeaders: boolean
	response: Response
}

function fromContext(response: Response): BuiltResponse {
	return { includesContextHeaders: true, response }
}

function fromElsewhere(response: Response): BuiltResponse {
	return { includesContextHeaders: false, response }
}

function buildResponse(ctx: Context, body?: unknown): BuiltResponse {
	if (body instanceof Response)
		return fromElsewhere(createFetchResponse(ctx, body))

	if (body instanceof StreamableFile)
		return fromContext(createStreamableFileResponse(ctx, body))

	if (body instanceof Readable)
		return fromContext(createNodeStreamResponse(ctx, body))

	if (body instanceof ReadableStream)
		return fromContext(createStreamResponse(ctx, body))

	if (body === undefined && finalizedResponses.has(ctx)) {
		return fromElsewhere(
			(finalizedResponses.get(ctx) as FinalizedResponse).response
		)
	}

	if (body === undefined && ctx.res && ctx.res.body !== null) {
		return fromElsewhere(ctx.res)
	}

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
