import { Readable } from 'node:stream'
import { StreamableFile } from '@nestjs/common'
import type { Context } from 'hono'

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

export async function normalizeContext(
	ctx: Context | (() => Promise<Context>)
) {
	if (typeof ctx === 'function') return await ctx()
	return ctx
}

/**
 * Stores the Fetch response on the Hono context and returns it for Hono's
 * middleware pipeline.
 */
export function finalizeResponse(ctx: Context, response: Response) {
	const finalized = finalizedResponses.get(ctx)
	if (
		ctx.finalized &&
		(finalized?.response === response || finalized?.source === response)
	) {
		return finalized.response
	}

	ctx.res = response
	const contextResponse = ctx.res
	finalizedResponses.set(ctx, { response: contextResponse, source: response })
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

function createReadableStream(ctx: Context, readable: Readable) {
	return createByteStream(
		ctx,
		Readable.toWeb(readable) as ReadableStream<unknown>
	)
}

function createStreamResponse(ctx: Context, stream: ReadableStream<unknown>) {
	const responseContentType = ctx.res.headers.get('Content-Type')
	if (!responseContentType) {
		ctx.res.headers.set('Content-Type', 'application/octet-stream')
	}

	return ctx.body(createByteStream(ctx, stream))
}

function createNodeStreamResponse(ctx: Context, readable: Readable) {
	return createStreamResponse(
		ctx,
		Readable.toWeb(readable) as ReadableStream<unknown>
	)
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

/**
 * Converts Nest reply bodies into Hono responses while preserving already-built
 * responses and inferring JSON/binary content types when Nest has not set one.
 */
export function createResponse(ctx: Context, body?: unknown) {
	if (body instanceof Response) return createFetchResponse(ctx, body)

	if (body instanceof StreamableFile) {
		return createStreamableFileResponse(ctx, body)
	}

	if (body instanceof Readable) {
		return createNodeStreamResponse(ctx, body)
	}

	if (body instanceof ReadableStream) {
		return createStreamResponse(ctx, body)
	}

	if (body === undefined && finalizedResponses.has(ctx)) {
		return (finalizedResponses.get(ctx) as FinalizedResponse).response
	}

	if (body === undefined && ctx.res && ctx.res.body !== null) {
		return ctx.res
	}

	let responseContentType = ctx.res.headers.get('Content-Type')

	if (!responseContentType || responseContentType.startsWith('text/plain')) {
		if (body instanceof Buffer) {
			responseContentType = 'application/octet-stream'
		} else if (typeof body === 'object') {
			responseContentType = 'application/json'
		}
		if (responseContentType)
			ctx.res.headers.set('Content-Type', responseContentType)
	}

	if (isJsonContentType(responseContentType) && typeof body === 'object') {
		return ctx.newResponse(JSON.stringify(body))
	}
	if (body === undefined) return ctx.newResponse(null)
	return ctx.body(body as string)
}

/**
 * Builds and stores the final Hono response in one step for handlers that need
 * to return the response immediately.
 */
export function getFinalizedResponse(ctx: Context, body?: unknown) {
	return finalizeResponse(ctx, createResponse(ctx, body))
}
