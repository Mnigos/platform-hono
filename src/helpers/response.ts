import type { Context } from 'hono'

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
	if (ctx.finalized && ctx.res === response) return response
	ctx.res = response
	return response
}

/**
 * Converts Nest reply bodies into Hono responses while preserving already-built
 * responses and inferring JSON/binary content types when Nest has not set one.
 */
export async function createResponse(ctx: Context, body?: unknown) {
	const normalizedCtx = await normalizeContext(ctx)

	if (body instanceof Response) return body

	if (
		body === undefined &&
		normalizedCtx.res &&
		normalizedCtx.res.body !== null
	) {
		return normalizedCtx.res
	}

	let responseContentType = normalizedCtx.res.headers.get('Content-Type')

	if (!responseContentType || responseContentType.startsWith('text/plain')) {
		if (body instanceof Buffer) {
			responseContentType = 'application/octet-stream'
		} else if (typeof body === 'object') {
			responseContentType = 'application/json'
		}
		if (responseContentType)
			normalizedCtx.res.headers.set('Content-Type', responseContentType)
	}

	if (responseContentType === 'application/json' && typeof body === 'object') {
		return normalizedCtx.json(body as object)
	}
	if (body === undefined) return normalizedCtx.newResponse(null)
	return normalizedCtx.body(body as string)
}

/**
 * Builds and stores the final Hono response in one step for handlers that need
 * to return the response immediately.
 */
export async function getFinalizedResponse(ctx: Context, body?: unknown) {
	const normalizedCtx = await normalizeContext(ctx)
	return finalizeResponse(
		normalizedCtx,
		await createResponse(normalizedCtx, body)
	)
}
