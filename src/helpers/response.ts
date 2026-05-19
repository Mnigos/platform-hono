import { Readable } from 'node:stream'
import { StreamableFile } from '@nestjs/common'
import type { Context } from 'hono'

const finalizedResponses = new WeakMap<Context, Response>()

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
	if (ctx.finalized && finalizedResponses.get(ctx) === response) return response
	finalizedResponses.set(ctx, response)
	ctx.res = response.clone() as Response
	return response
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

function createByteStream(stream: ReadableStream<unknown>) {
	return stream.pipeThrough(
		new TransformStream<unknown, Uint8Array>({
			transform(chunk, controller) {
				controller.enqueue(toUint8Array(chunk))
			},
		})
	)
}

function createReadableStream(readable: Readable) {
	return createByteStream(Readable.toWeb(readable) as ReadableStream<unknown>)
}

function createStreamResponse(ctx: Context, stream: ReadableStream<unknown>) {
	const responseContentType = ctx.res.headers.get('Content-Type')
	if (!responseContentType || responseContentType.startsWith('text/plain')) {
		ctx.res.headers.set('Content-Type', 'application/octet-stream')
	}

	return ctx.body(createByteStream(stream))
}

function createNodeStreamResponse(ctx: Context, readable: Readable) {
	return createStreamResponse(
		ctx,
		Readable.toWeb(readable) as ReadableStream<unknown>
	)
}

function createStreamableFileResponse(ctx: Context, file: StreamableFile) {
	const { disposition, length, type } = file.getHeaders()

	setStreamableFileHeader(ctx.res.headers, 'Content-Type', type)
	setStreamableFileHeader(ctx.res.headers, 'Content-Disposition', disposition)
	setStreamableFileHeader(ctx.res.headers, 'Content-Length', length)

	return ctx.body(createReadableStream(file.getStream()))
}

/**
 * Converts Nest reply bodies into Hono responses while preserving already-built
 * responses and inferring JSON/binary content types when Nest has not set one.
 */
export function createResponse(ctx: Context, body?: unknown) {
	if (body instanceof Response) return body

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
		return finalizedResponses.get(ctx) as Response
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

	if (
		responseContentType?.startsWith('application/json') &&
		typeof body === 'object'
	) {
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
