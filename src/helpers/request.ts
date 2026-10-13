import type { Context } from 'hono'

/**
 * Nest reads adapter request state from Express/Fastify-style properties.
 * Hono exposes most of the same data through methods, so the adapter attaches
 * these compatibility fields to the existing Hono request object.
 */
export interface NestHonoRequest extends Record<string, unknown> {
	baseUrl?: string
	body?: unknown
	headers?: Record<string, string>
	ip?: string
	params?: Record<string, string>
	query?:
		| (() => Record<string, string | string[]>)
		| Record<string, string | string[]>
	rawBody?: Buffer
}

export function getNestHonoRequest(req: Context['req']) {
	return req as unknown as NestHonoRequest
}

/**
 * Host name of a request, from the `Host` header or else the request URL.
 */
export function getRequestHostname(request: Context['req']) {
	const host = request.header('host')
	return host
		? new URL(`http://${host}`).hostname
		: new URL(request.url).hostname
}

/**
 * Path and query string of a request URL, as Express `req.originalUrl`.
 */
export function getRequestPathWithSearch(request: Context['req']) {
	const url = new URL(request.url)
	return `${url.pathname}${url.search}`
}
