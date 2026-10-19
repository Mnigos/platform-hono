import { type Context, Hono, type NotFoundHandler } from 'hono'
import {
	getAdapterContextMembers,
	getAdapterRequestMembers,
	isAdapterContext,
} from '../request/request-accessors'

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

type HonoRequestClass = new (
	request: Request,
	path?: string,
	matchResult?: unknown
) => Context['req']

interface HonoClasses {
	HonoContext: ContextClass
	HonoRequest: HonoRequestClass
}

const PROBE_URL = 'http://localhost/probe'

/**
 * Captures Hono's `Context` and `HonoRequest` classes from one request through
 * a probe app, and checks that a context created with `ContextOptions` has the
 * same own properties and request data as the one `hono.fetch()` created.
 */
function captureHonoClasses() {
	let probeContext: Context | undefined
	const probe = new Hono()
	probe.get('*', ctx => {
		probeContext = ctx
		return new Response(null)
	})
	const env = {}
	probe.fetch(new Request(PROBE_URL), env)
	if (!probeContext) return
	const classes: HonoClasses = {
		HonoContext: probeContext.constructor as ContextClass,
		HonoRequest: probeContext.req.constructor as HonoRequestClass,
	}
	const request = new Request(PROBE_URL)
	const ctx = new classes.HonoContext(
		request,
		new ContextOptionsRecord(env, [[]], () => new Response(null), '/probe')
	)
	if (
		ctx.env !== env ||
		ctx.req.raw !== request ||
		ctx.req.path !== '/probe' ||
		Object.keys(ctx).join() !== Object.keys(probeContext).join() ||
		Object.keys(ctx.req).join() !== Object.keys(probeContext.req).join()
	)
		return
	return classes
}

/**
 * Creates adapter-owned subclasses of Hono's `Context` and `HonoRequest` for
 * the requests the fast paths create. Their prototypes carry the accessors
 * other requests get as own properties (`req.ip`, `req.headers`, `req.socket`
 * on Node.js, `ctx.raw`, `ctx.res`), so a request needs no `defineProperty()`
 * calls, and Hono's own classes stay untouched. The prototypes have no own
 * `constructor`, so `ctx.constructor` and `ctx.req.constructor` are still
 * Hono's classes.
 */
function createAdapterContextClass(
	{ HonoContext, HonoRequest }: HonoClasses,
	withSocket: boolean
) {
	class AdapterRequest extends HonoRequest {}

	class AdapterContext extends HonoContext {
		readonly #matchResult: unknown
		readonly #path: string
		#req?: Context['req']
		readonly #request: Request

		constructor(request: Request, options: ContextOptions) {
			super(request, options)
			this.#matchResult = options.matchResult
			this.#path = options.path
			this.#request = request
		}

		override get req() {
			this.#req ??= new AdapterRequest(
				this.#request,
				this.#path,
				this.#matchResult
			)
			return this.#req
		}
	}

	Object.defineProperties(
		AdapterRequest.prototype,
		getAdapterRequestMembers(withSocket)
	)
	Object.defineProperties(
		AdapterContext.prototype,
		getAdapterContextMembers(HonoContext.prototype)
	)
	Reflect.deleteProperty(AdapterRequest.prototype, 'constructor')
	Reflect.deleteProperty(AdapterContext.prototype, 'constructor')
	return AdapterContext as ContextClass
}

/**
 * Whether the adapter-owned classes create contexts and requests that look
 * like Hono's: same own properties, constructors, and request data.
 */
function isLikeHonoContext(
	AdapterContext: ContextClass,
	{ HonoContext, HonoRequest }: HonoClasses
) {
	const request = new Request(PROBE_URL)
	const options = new ContextOptionsRecord(
		{},
		[[]],
		() => new Response(null),
		'/probe'
	)
	const ctx = new AdapterContext(request, options)
	const honoCtx = new HonoContext(request, options)
	return (
		isAdapterContext(ctx) &&
		ctx instanceof HonoContext &&
		ctx.constructor === HonoContext &&
		ctx.req instanceof HonoRequest &&
		ctx.req.constructor === HonoRequest &&
		ctx.req.raw === request &&
		ctx.req.path === '/probe' &&
		Object.keys(ctx).join() === Object.keys(honoCtx).join() &&
		Object.keys(ctx.req).join() === Object.keys(honoCtx.req).join()
	)
}

let honoClasses: HonoClasses | null | undefined
const adapterContextClasses = new Map<boolean, ContextClass | null>()

function getHonoClasses() {
	if (honoClasses === undefined) {
		try {
			honoClasses = captureHonoClasses() ?? null
		} catch {
			honoClasses = null
		}
	}
	return honoClasses ?? undefined
}

/**
 * Returns the adapter-owned `Context` class for fast path requests (with
 * `req.socket` on Node.js), created once from the installed Hono, or
 * `undefined` when Hono's classes do not match what the fast paths expect.
 */
export function getAdapterContextClass(withSocket: boolean) {
	let AdapterContext = adapterContextClasses.get(withSocket)
	if (AdapterContext === undefined) {
		const classes = getHonoClasses()
		try {
			const created = classes && createAdapterContextClass(classes, withSocket)
			AdapterContext =
				created && classes && isLikeHonoContext(created, classes)
					? created
					: null
		} catch {
			AdapterContext = null
		}
		adapterContextClasses.set(withSocket, AdapterContext)
	}
	return AdapterContext ?? undefined
}
