import type { Context, MiddlewareHandler } from 'hono'
import { runSecurityHooks, type SecurityRequestHook } from '../helpers/nest-12'
import type { HonoAdapterOptions } from '../options'
import { getNestRequest } from './nest-request'
import { getRequestState } from './request-state'

/**
 * The work of the adapter's first Hono layer: sets up the request state and
 * runs the Nest 12 security hooks, which throw to reject the request.
 */
export function prepareRequest(
	ctx: Context,
	options: HonoAdapterOptions,
	securityHooks: readonly SecurityRequestHook[]
) {
	getRequestState(ctx, options)
	if (securityHooks.length > 0)
		runSecurityHooks(ctx, getNestRequest(ctx.req), securityHooks)
}

/**
 * Creates the adapter's first Hono layer, registered for every request before
 * any other middleware.
 */
export function createRequestLayer(
	options: HonoAdapterOptions,
	securityHooks: readonly SecurityRequestHook[]
): MiddlewareHandler {
	return (ctx, next) => {
		prepareRequest(ctx, options, securityHooks)
		return next()
	}
}
