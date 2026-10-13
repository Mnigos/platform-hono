import type { Context, MiddlewareHandler } from 'hono'

/**
 * Nest 12 security hook: sets or removes response headers and returns the
 * error to reject the request with, such as a CSRF `ForbiddenException`.
 */
export type SecurityRequestHook = (
	request: Context['req'],
	response: SecurityHookResponse
) => Error | undefined

interface SecurityHookResponse {
	removeHeader(name: string): unknown
	setHeader(name: string, value: string): unknown
}

/**
 * Nest 12 `NestApplicationOptions` fields the adapter reads. They are declared
 * here so the adapter also compiles against Nest 11 types.
 */
export interface Nest12ApplicationOptions {
	return503OnClosing?: boolean
}

/**
 * Wraps a Nest 12 security hook (`app.useSecurityHeaders()`,
 * `app.enableCsrfProtection()`) as Hono middleware. Thrown errors reach the
 * Nest exception layer through Hono's error handler.
 */
export function createSecurityHookMiddleware(
	hook: SecurityRequestHook
): MiddlewareHandler {
	return (ctx, next) => {
		const error = hook(ctx.req, {
			removeHeader: name => ctx.header(name, undefined),
			setHeader: (name, value) => ctx.header(name, value),
		})
		if (error) throw error
		return next()
	}
}

/**
 * Answers new requests with 503 and `Connection: close` once the application
 * is shutting down, for Nest 12's `return503OnClosing` option.
 */
export function createShutdownMiddleware(
	isShuttingDown: () => boolean
): MiddlewareHandler {
	return (_ctx, next) => {
		if (!isShuttingDown()) return next()
		return Promise.resolve(
			new Response('Service Unavailable', {
				headers: { connection: 'close' },
				status: 503,
			})
		)
	}
}
