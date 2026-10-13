import type { Context, MiddlewareHandler } from 'hono'
import { enforceRequestBodyLimit } from '../helpers/body-parser'
import { getRequestSizeLimit } from '../helpers/path-matching'
import type { HonoAdapterOptions } from '../options'
import { mayHaveRequestBody } from './request-headers'
import { getRequestState, syncRawRequest } from './request-state'

type Next = () => Promise<void>

interface BodyLimitMiddlewareOptions {
	adapterOptions: HonoAdapterOptions
	parse?: MiddlewareHandler
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

	return (ctx, next) => {
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
}
