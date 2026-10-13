import { getRequestListener } from '@hono/node-server'

type ResponseConstructor = typeof Response

let lightweightResponse: ResponseConstructor | undefined

function captureLightweightResponse() {
	const globals = globalThis as { Request: unknown; Response: unknown }
	const nativeRequest = globals.Request
	const nativeResponse = globals.Response
	getRequestListener(() => new Response(), { overrideGlobalObjects: true })
	const capturedResponse = globals.Response as ResponseConstructor
	Object.defineProperty(globalThis, 'Request', { value: nativeRequest })
	Object.defineProperty(globalThis, 'Response', { value: nativeResponse })
	return capturedResponse
}

/**
 * Returns `@hono/node-server`'s lightweight `Response` class, which the Node.js
 * server writes without reading a Fetch body stream. It is captured once by
 * letting the server install its globals and restoring the native ones right
 * away, so the process keeps its native `Request` and `Response`.
 */
export function getLightweightResponse() {
	lightweightResponse ??= captureLightweightResponse()
	return lightweightResponse
}

/**
 * Runs `build` with the lightweight `Response` as the global constructor, so
 * Hono's `ctx.body()`/`ctx.newResponse()` create responses the Node.js server
 * can write directly. The swap is synchronous and restored before returning.
 */
export function withLightweightResponse<TResult>(build: () => TResult) {
	const globals = globalThis as { Response: ResponseConstructor }
	const nativeResponse = globals.Response
	const responseClass = getLightweightResponse()
	if (responseClass === nativeResponse) return build()
	globals.Response = responseClass
	try {
		return build()
	} finally {
		globals.Response = nativeResponse
	}
}
