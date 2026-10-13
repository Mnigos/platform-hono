import type { Readable } from 'node:stream'
import type { StreamableFile } from '@nestjs/common'
import type { Context } from 'hono'

interface SocketLike {
	destroyed?: boolean
	off(event: 'close', listener: () => void): void
	once(event: 'close', listener: () => void): void
}

interface NodeRequestEnvironment {
	incoming?: { socket?: SocketLike }
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

/**
 * Returns the Node.js socket of the request on the `@hono/node-server` path.
 */
export function getClientSocket(ctx: Context) {
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

/**
 * Streams a Web `ReadableStream` reply, cancelling it on client disconnect.
 */
export function createStreamResponse(
	ctx: Context,
	stream: ReadableStream<unknown>
) {
	const responseContentType = ctx.res.headers.get('Content-Type')
	if (!responseContentType) {
		ctx.res.headers.set('Content-Type', 'application/octet-stream')
	}

	return ctx.body(createByteStream(ctx, stream))
}

/**
 * Streams a Node.js `Readable` reply, destroying it on client disconnect.
 */
export function createNodeStreamResponse(ctx: Context, readable: Readable) {
	return createStreamResponse(ctx, toWebStream(readable))
}

/**
 * Streams a Nest `StreamableFile` with its content headers.
 */
export function createStreamableFileResponse(
	ctx: Context,
	file: StreamableFile
) {
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

/**
 * Wraps a Fetch response body so it is cancelled when the client disconnects.
 */
export function createFetchResponse(ctx: Context, response: Response) {
	if (!response.body) return response
	return new Response(createByteStream(ctx, response.body), {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	})
}
