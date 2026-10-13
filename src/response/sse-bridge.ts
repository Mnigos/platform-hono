import type { OutgoingHttpHeaders } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import type { Context } from 'hono'
import { getBunServer } from '../helpers/bun-server'
import { finalizeResponse } from '../helpers/response'
import type { RequestState } from '../request/request-state'

export interface HonoSseWritable extends PassThrough {
	flushHeaders: () => void
	getHeaders: () => OutgoingHttpHeaders
	setHeader: (name: string, value: number | string | string[]) => void
	statusCode?: number
	writeHead: (
		statusCode: number,
		reasonPhraseOrHeaders?: OutgoingHttpHeaders | string,
		headers?: OutgoingHttpHeaders
	) => HonoSseWritable
}

/**
 * Node-style response facade Nest writes `@Sse()` streams to. It is created
 * lazily, on the first `res.raw` access, which only Nest's SSE path makes.
 */
export interface SseBridge {
	response?: Response
	started: boolean
	stream: HonoSseWritable
}

/**
 * Collects the response headers in Node's `getHeaders()` shape, keeping
 * repeated `set-cookie` values as an array.
 */
export function getResponseHeaders(ctx: Context) {
	const headers: OutgoingHttpHeaders = Object.fromEntries(ctx.res.headers)
	const setCookies = ctx.res.headers.getSetCookie()
	if (setCookies.length) headers['set-cookie'] = setCookies
	return headers
}

function setResponseHeader(
	ctx: Context,
	name: string,
	value: number | string | string[] | undefined
) {
	if (value === undefined) return
	if (!Array.isArray(value)) {
		ctx.res.headers.set(name, String(value))
		return
	}

	ctx.res.headers.delete(name)
	for (const item of value) ctx.res.headers.append(name, String(item))
}

function createSseBridge(state: RequestState) {
	const { ctx } = state
	const stream = new PassThrough() as HonoSseWritable
	const bridge: SseBridge = { started: false, stream }
	if (state.statusCode !== undefined) stream.statusCode = state.statusCode
	stream.getHeaders = () => getResponseHeaders(ctx)
	stream.setHeader = (name, value) => {
		setResponseHeader(ctx, name, value)
	}
	stream.flushHeaders = () => undefined
	stream.writeHead = (statusCode, reasonPhraseOrHeaders, headers) => {
		bridge.started = true
		getBunServer(ctx)?.timeout(state.rawRequest, 0)
		const outgoingHeaders =
			typeof reasonPhraseOrHeaders === 'string'
				? headers
				: reasonPhraseOrHeaders

		stream.statusCode = statusCode
		ctx.status(statusCode as Parameters<Context['status']>[0])

		if (outgoingHeaders) {
			for (const [name, value] of Object.entries(outgoingHeaders))
				setResponseHeader(ctx, name, value)
		}
		if (!ctx.finalized) {
			const response = finalizeResponse(
				ctx,
				ctx.body(Readable.toWeb(stream) as ReadableStream<Uint8Array>)
			)
			bridge.response = response
			state.sseWaiter?.(response)
		}

		return stream
	}
	return bridge
}

/**
 * Returns the SSE bridge of a request, creating it on first use.
 */
export function getSseBridge(state: RequestState) {
	state.sse ??= createSseBridge(state)
	return state.sse
}
