import type { Context, MiddlewareHandler } from 'hono'
import { enforceRequestBodyLimit } from '../helpers/body-parser'
import { getRequestSizeLimit } from '../helpers/path-matching'
import type { HonoAdapterOptions } from '../options'
import { mayHaveRequestBody } from './request-headers'
import { getRequestState } from './request-state'
import { syncRawRequest } from './request-state-core'

type Next = () => Promise<void>

interface BodyLimitMiddlewareOptions {
	adapterOptions: HonoAdapterOptions
	parse?: MiddlewareHandler
}

const bodyLimitLayers = new WeakSet<Function>()

/**
 * Whether a Hono handler is a body layer from `createBodyLimitMiddleware()`.
 * For a request without body headers it only passes on to `next()`.
 */
export function isBodyLimitLayer(handler: unknown) {
	return typeof handler === 'function' && bodyLimitLayers.has(handler)
}

/**
 * Creates the first adapter middleware: it sets up request state, enforces the
 * body limits, and then runs the default body parsers in the same Hono layer,
 * so requests pass one middleware instead of two before routing.
 */
export function createBodyLimitMiddleware({
	adapterOptions,
	parse,
}: BodyLimitMiddlewareOptions): MiddlewareHandler {
	const proceed: MiddlewareHandler =
		parse ?? ((_ctx: Context, next: Next) => next())

	const layer: MiddlewareHandler = (ctx, next) => {
		const state = getRequestState(ctx, adapterOptions)
		syncRawRequest(state)
		if (!mayHaveRequestBody(state)) return proceed(ctx, next)
		const pendingLimit = enforceRequestBodyLimit(
			ctx,
			adapterOptions,
			getRequestSizeLimit(state.pathname, adapterOptions.requestSizeLimits)
		)
		if (!pendingLimit) return proceed(ctx, next)
		return pendingLimit.then(() => {
			syncRawRequest(state)
			return proceed(ctx, next)
		})
	}
	bodyLimitLayers.add(layer)
	return layer
}
