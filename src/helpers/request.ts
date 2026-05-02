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
