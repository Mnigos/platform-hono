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
 * Observes reads of `ctx.res` through an own accessor on the context.
 */
export function observeResponseReads(ctx: Context) {
	Object.defineProperty(ctx, 'res', RESPONSE_ACCESSOR)
}

/**
 * `ctx.res` for an adapter-owned Context prototype: Hono's accessor from
 * `honoPrototype`, recording reads like the own accessor of other contexts.
 */
export function createResponseReadsDescriptor(
	honoPrototype: object
): PropertyDescriptor {
	const { get, set } = Object.getOwnPropertyDescriptor(
		honoPrototype,
		'res'
	) as PropertyDescriptor
	return {
		configurable: true,
		enumerable: false,
		get(this: TrackedContext) {
			const tracking = this[CONTEXT_TRACKING]
			if (tracking) tracking.touched = true
			return get?.call(this)
		},
		set(this: TrackedContext, value: Response | undefined) {
			set?.call(this, value)
		},
	}
}

/**
 * `ctx.header()` that records the call. Per-request closures are returned from
 * functions instead of being assigned to a property where they are created:
 * V8 allocates a function literal assigned straight to a property in old
 * space, and such a closure keeps the whole request alive past young GCs.
 */
function trackHeaderCalls(
	tracking: ContextTracking,
	header: Context['header']
) {
	return ((...args: Parameters<Context['header']>) => {
		tracking.touched = true
		return header(...args)
	}) as Context['header']
}

/** `ctx.status()` that records the status (see `trackHeaderCalls`). */
function trackStatusCalls(
	tracking: ContextTracking,
	status: Context['status']
) {
	return ((statusCode: Parameters<Context['status']>[0]) => {
		tracking.statusCode = statusCode
		status(statusCode)
	}) as Context['status']
}

/**
 * Starts tracking a context: wraps `ctx.header()` and `ctx.status()`. Reads
 * of `ctx.res` are observed by `observeResponseReads()` or the adapter-owned
 * Context prototype. `tracking` is usually the request state, so no separate
 * object is allocated per request.
 */
export function trackContext(ctx: Context, tracking: ContextTracking) {
	const trackedContext = ctx as TrackedContext
	tracking.touched = false
	trackedContext[CONTEXT_TRACKING] = tracking
	const { header, status } = ctx
	ctx.header = trackHeaderCalls(tracking, header)
	ctx.status = trackStatusCalls(tracking, status)
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
