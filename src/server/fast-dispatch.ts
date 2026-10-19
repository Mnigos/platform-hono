import type { Context, ErrorHandler, Hono, NotFoundHandler } from 'hono'
import { type RouteHandlerOptions, runRoute } from '../routing/route-invoker'

interface HonoWithErrorHandler {
	errorHandler: ErrorHandler
}

/** Index of the adapter's request layer in the matched handlers. */
const REQUEST_LAYER = 0
/**
 * Index of the route. The body layer between them only passes on to `next()`
 * for requests without body headers, so it is not called.
 */
const ROUTE_LAYER = 2
const NOT_FINALIZED =
	'Context is not finalized. Did you forget to return a Response object or `await next()`?'

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
	typeof (value as PromiseLike<unknown> | undefined)?.then === 'function'

/**
 * One fast path request, dispatched through the adapter's layers with the
 * semantics of Hono's `#dispatch()` and `compose()`: the same `routeIndex`
 * updates, `next()` reaching the not-found handler, every layer's error
 * handling, and the "not finalized" check. Only the promise plumbing between
 * the layers is left out. Each runtime delivers the result in `respond()`.
 */
export abstract class FastExchange {
	readonly ctx: Context
	private readonly errorHandler: ErrorHandler
	private readonly hono: Hono
	private readonly notFoundHandler: NotFoundHandler
	private routeSettled = false

	/**
	 * Positional parameters: an options object literal per request could be
	 * pretenured by V8 (see `RequestStateRecord`).
	 */
	constructor(ctx: Context, hono: Hono, notFoundHandler: NotFoundHandler) {
		this.ctx = ctx
		this.hono = hono
		this.notFoundHandler = notFoundHandler
		this.errorHandler = (hono as unknown as HonoWithErrorHandler).errorHandler
	}

	/**
	 * Receives what `hono.fetch()` would have returned: the response, a
	 * promise of it, or a rejected promise.
	 */
	protected abstract respond(result: unknown): void

	/**
	 * Runs the request layer's work (`prepare`), then the route.
	 */
	dispatch(prepare: (ctx: Context) => void, route: RouteHandlerOptions) {
		const { ctx } = this
		ctx.req.routeIndex = REQUEST_LAYER
		try {
			prepare(ctx)
		} catch (error) {
			this.fail(REQUEST_LAYER, error)
			return
		}
		ctx.req.routeIndex = ROUTE_LAYER
		try {
			runRoute(
				ctx,
				route,
				this.createNext(),
				response => this.settleRoute(response, false),
				error => this.settleRoute(error, true)
			)
		} catch (error) {
			this.settleRoute(error, true)
		}
	}

	/** The route layer settles once, like the promise it returns on the Hono path. */
	private settleRoute(result: unknown, isRejected: boolean) {
		if (this.routeSettled) return
		this.routeSettled = true
		if (isRejected) this.fail(ROUTE_LAYER, result)
		else this.settle(ROUTE_LAYER, result, false)
	}

	/** `compose()`'s `next` for the route: the end of the chain. */
	private createNext() {
		let called = false
		const next = async () => {
			if (called) throw new Error('next() called multiple times')
			called = true
			const { ctx } = this
			if (ctx.finalized === false) {
				const response = await this.notFoundHandler(ctx)
				if (response && ctx.finalized === false) ctx.res = response
			}
			return ctx
		}
		return next as unknown as () => Promise<void>
	}

	/**
	 * A layer's result becomes `ctx.res` while the context is not finalized, or
	 * always after its error handler ran. The layers outside it return
	 * `next()`, so their result is the context. An error from these
	 * assignments escapes the layer.
	 */
	private settle(layer: number, result: unknown, isError: boolean) {
		if (isThenable(result)) {
			Promise.resolve(result).then(
				response => this.settle(layer, response, isError),
				error =>
					isError ? this.failOuter(layer, error) : this.fail(layer, error)
			)
			return
		}
		const { ctx } = this
		let current = layer
		try {
			if (result && (ctx.finalized === false || isError))
				ctx.res = result as Response
			for (current = layer - 1; current >= REQUEST_LAYER; current--)
				if (ctx.finalized === false) ctx.res = ctx as unknown as Response
		} catch (error) {
			this.failOuter(current, error)
			return
		}
		this.finish()
	}

	/** `#dispatch()` after `compose()`: the finalized context's response. */
	private finish() {
		const { ctx } = this
		let response: Response
		try {
			if (!ctx.finalized) throw new Error(NOT_FINALIZED)
			response = ctx.res
		} catch (error) {
			this.handleError(error)
			return
		}
		this.respond(response)
	}

	/** `compose()`'s error handling for an error thrown by a layer. */
	private fail(layer: number, error: unknown) {
		if (!(error instanceof Error)) {
			this.handleError(error)
			return
		}
		this.ctx.error = error
		let result: unknown
		try {
			result = this.errorHandler(error, this.ctx)
		} catch (handlerError) {
			this.failOuter(layer, handlerError)
			return
		}
		this.settle(layer, result, true)
	}

	/** An error handler failed: the layer outside handles that error. */
	private failOuter(layer: number, error: unknown) {
		if (layer > REQUEST_LAYER) this.fail(layer - 1, error)
		else this.handleError(error)
	}

	/** `#dispatch()`'s `#handleError()`: the error handler's result is the response. */
	private handleError(error: unknown) {
		if (!(error instanceof Error)) {
			this.respond(Promise.reject(error))
			return
		}
		let result: unknown
		try {
			result = (this.hono as unknown as HonoWithErrorHandler).errorHandler(
				error,
				this.ctx
			)
		} catch (handlerError) {
			result = Promise.reject(handlerError)
		}
		this.respond(result)
	}
}
