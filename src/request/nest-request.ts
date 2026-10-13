import type { Context } from 'hono'

type HonoRequest = Context['req']

const NEST_QUERY = Symbol('platformHonoNestQuery')
const NEST_REQUEST = Symbol('platformHonoNestRequest')

interface NestQueryCarrier {
	[NEST_QUERY]?: Record<string, string | string[]>
	[NEST_REQUEST]?: HonoRequest
}

/**
 * Builds Express-style `req.query` on an object without a prototype, so keys
 * such as `__proto__` or `toString` cannot shadow `Object.prototype` members.
 */
function createQuery(request: HonoRequest) {
	const query: Record<string, string | string[]> = Object.create(null)
	if (!request.url.includes('?')) return query
	for (const [key, values] of Object.entries(request.queries()))
		query[key] = values.length > 1 ? values : (values[0] ?? '')
	return query
}

function getNestQuery(target: HonoRequest & NestQueryCarrier) {
	target[NEST_QUERY] ??= createQuery(target)
	return target[NEST_QUERY]
}

const honoRequestMethods = new WeakSet<Function>()

function isHonoRequestMethod(value: unknown): value is Function {
	return typeof value === 'function' && honoRequestMethods.has(value)
}

function rememberHonoRequestMethods(request: HonoRequest) {
	if (honoRequestMethods.has(request.header)) return
	const prototype = Object.getPrototypeOf(request) as Record<string, unknown>
	for (const name of Object.getOwnPropertyNames(prototype)) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
		if (typeof descriptor?.value === 'function' && name !== 'constructor')
			honoRequestMethods.add(descriptor.value)
	}
}

const NEST_REQUEST_HANDLER = {
	get(target, property) {
		if (property === 'query') return getNestQuery(target)
		const value = Reflect.get(target, property, target)
		return isHonoRequestMethod(value) ? value.bind(target) : value
	},
	set(target, property, value) {
		if (property === 'query') {
			target[NEST_QUERY] = value
			return true
		}
		return Reflect.set(target, property, value, target)
	},
	has(target, property) {
		return property === 'query' || Reflect.has(target, property)
	},
} as const satisfies ProxyHandler<HonoRequest & NestQueryCarrier>

/**
 * Returns the request object Nest middleware, guards, pipes, and handlers
 * receive. It is a view over Hono's request: `query` is Express-style (a
 * parsed object), everything else reads and writes through to `ctx.req`, and
 * Hono request methods stay bound to it. Hono's own `ctx.req` keeps its
 * `query()` method, so Hono routes mounted on the same app keep working.
 */
export function getNestRequest(request: HonoRequest) {
	const carrier = request as HonoRequest & NestQueryCarrier
	if (carrier[NEST_REQUEST]) return carrier[NEST_REQUEST]
	rememberHonoRequestMethods(request)
	const nestRequest = new Proxy(carrier, NEST_REQUEST_HANDLER) as HonoRequest
	carrier[NEST_REQUEST] = nestRequest
	return nestRequest
}
