import { type Context, Hono, type NotFoundHandler } from 'hono'

/**
 * The options Hono's `#dispatch()` creates every request `Context` with.
 */
export interface ContextOptions {
	env: unknown
	executionCtx: undefined
	matchResult: unknown
	notFoundHandler: NotFoundHandler
	path: string
}

/**
 * `ContextOptions` built by a constructor, so V8 cannot pretenure the options
 * of every fast path request (see `RequestStateRecord`).
 */
export class ContextOptionsRecord implements ContextOptions {
	env: unknown
	executionCtx: undefined
	matchResult: unknown
	notFoundHandler: NotFoundHandler
	path: string

	constructor(
		env: unknown,
		matchResult: unknown,
		notFoundHandler: NotFoundHandler,
		path: string
	) {
		this.env = env
		this.executionCtx = undefined
		this.matchResult = matchResult
		this.notFoundHandler = notFoundHandler
		this.path = path
	}
}

export type ContextClass = new (
	request: Request,
	options: ContextOptions
) => Context

const PROBE_URL = 'http://localhost/probe'

/**
 * Captures Hono's `Context` class from one request through a probe app, and
 * checks that a context created with `ContextOptions` has the same own
 * properties and request data as the one `hono.fetch()` created.
 */
function captureContextClass() {
	let probeContext: Context | undefined
	const probe = new Hono()
	probe.get('*', ctx => {
		probeContext = ctx
		return new Response(null)
	})
	const env = {}
	probe.fetch(new Request(PROBE_URL), env)
	if (!probeContext) return
	const HonoContext = probeContext.constructor as ContextClass
	const request = new Request(PROBE_URL)
	const ctx = new HonoContext(request, {
		env,
		executionCtx: undefined,
		matchResult: [[]],
		notFoundHandler: () => new Response(null),
		path: '/probe',
	})
	if (
		ctx.env !== env ||
		ctx.req.raw !== request ||
		ctx.req.path !== '/probe' ||
		Object.keys(ctx).join() !== Object.keys(probeContext).join() ||
		Object.keys(ctx.req).join() !== Object.keys(probeContext.req).join()
	)
		return
	return HonoContext
}

let contextClass: ContextClass | null | undefined

/**
 * Returns Hono's `Context` class, captured once from the installed version,
 * or `undefined` when it does not match what the Node.js fast path expects.
 */
export function getContextClass() {
	if (contextClass === undefined) {
		try {
			contextClass = captureContextClass() ?? null
		} catch {
			contextClass = null
		}
	}
	return contextClass ?? undefined
}
