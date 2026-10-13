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
 * Runs Nest 12 security hooks (`app.useSecurityHeaders()`,
 * `app.enableCsrfProtection()`) for a request: headers go onto the Hono
 * context, and the first returned error is thrown to Nest's exception layer
 * through Hono's error handler. Hooks receive Nest's request view, the same
 * object Nest middleware and handlers get.
 */
export function runSecurityHooks(
	ctx: Context,
	request: Context['req'],
	hooks: readonly SecurityRequestHook[]
) {
	const response: SecurityHookResponse = {
		removeHeader: name => ctx.header(name, undefined),
		setHeader: (name, value) => ctx.header(name, value),
	}
	for (const hook of hooks) {
		const error = hook(request, response)
		if (error) throw error
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

interface Nest12Members {
	beforeClose: Function
	query: Function
	registerSecurityHook: Function
}

/**
 * Nest 12 adds `query()`, `registerSecurityHook()` and `beforeClose()` to
 * `AbstractHttpAdapter`. Declaring them in the adapter class would need
 * `override` on Nest 12 types and reject it on Nest 11 types, so the
 * implementations are installed under those names on the prototype instead,
 * and the class compiles against both versions.
 */
export function installNest12Members(
	prototype: object,
	members: Nest12Members
) {
	for (const [name, method] of Object.entries(members))
		Object.defineProperty(prototype, name, {
			configurable: true,
			value: method,
			writable: true,
		})
}
