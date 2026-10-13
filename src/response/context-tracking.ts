import type { Context } from 'hono'

const CONTEXT_TRACKING = Symbol('platformHonoContextTracking')

/**
 * Records whether anything could have changed the Hono response state
 * (`ctx.header()`, `ctx.res`) before the reply, and the status set through
 * `ctx.status()`. While untouched, replies can be built directly from the
 * body and status instead of through Hono's response merging.
 */
export interface ContextTracking {
	statusCode?: number
	touched: boolean
}

interface TrackedContext extends Context {
	[CONTEXT_TRACKING]?: ContextTracking
}

let responseDescriptor: PropertyDescriptor | undefined

function getResponseDescriptor(ctx: Context) {
	responseDescriptor ??= Object.getOwnPropertyDescriptor(
		Object.getPrototypeOf(ctx),
		'res'
	)
	return responseDescriptor as PropertyDescriptor
}

const RESPONSE_ACCESSOR = {
	configurable: true,
	enumerable: false,
	get(this: TrackedContext) {
		const tracking = this[CONTEXT_TRACKING]
		if (tracking) tracking.touched = true
		return getResponseDescriptor(this).get?.call(this)
	},
	set(this: TrackedContext, value: Response | undefined) {
		getResponseDescriptor(this).set?.call(this, value)
	},
} as const satisfies PropertyDescriptor

/**
 * Starts tracking a context: wraps `ctx.header()` and `ctx.status()` and
 * observes reads of `ctx.res`. `tracking` is usually the request state, so no
 * separate object is allocated per request.
 */
export function trackContext(ctx: Context, tracking: ContextTracking) {
	const trackedContext = ctx as TrackedContext
	tracking.touched = false
	trackedContext[CONTEXT_TRACKING] = tracking
	Object.defineProperty(ctx, 'res', RESPONSE_ACCESSOR)
	const { header, status } = ctx
	ctx.header = ((...args: Parameters<Context['header']>) => {
		tracking.touched = true
		return header(...args)
	}) as Context['header']
	ctx.status = statusCode => {
		tracking.statusCode = statusCode
		status(statusCode)
	}
	return tracking
}

/**
 * Returns the tracking of a context while its response state is untouched.
 */
export function getUntouchedTracking(ctx: Context) {
	const tracking = (ctx as TrackedContext)[CONTEXT_TRACKING]
	if (!tracking || tracking.touched || ctx.finalized) return
	return tracking
}
