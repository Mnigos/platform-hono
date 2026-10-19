import type { Context } from 'hono'
import { extractClientIp } from '../helpers/client-ip'
import { getNestHonoRequest, type NestHonoRequest } from '../helpers/request'
import {
	createResponseReadsDescriptor,
	observeResponseReads,
} from '../response/context-tracking'
import { getSseBridge } from '../response/sse-bridge'
import {
	defineValue,
	getCurrentRequest,
	REQUEST_STATE,
	type RequestState,
	SOCKET_ACCESSOR,
	type StateCarrier,
} from './request-state-core'

const REQUEST_ACCESSORS = {
	headers: {
		configurable: true,
		enumerable: true,
		get(this: StateCarrier) {
			const state = this[REQUEST_STATE]
			const source = getCurrentRequest(state)
			if (!state.headers || state.headersSource !== source) {
				state.headers = Object.fromEntries(source.headers)
				state.headersSource = source
			}
			return state.headers
		},
		set(this: StateCarrier, value: unknown) {
			defineValue(this, 'headers', value)
		},
	},
	ip: {
		configurable: true,
		enumerable: true,
		get(this: StateCarrier) {
			const state = this[REQUEST_STATE]
			if (state.ip === undefined)
				state.ip =
					extractClientIp(state.ctx, state.options, state.rawRequest) ?? null
			return state.ip ?? undefined
		},
		set(this: StateCarrier, value: unknown) {
			defineValue(this, 'ip', value)
		},
	},
} as const satisfies PropertyDescriptorMap

function getContextState(ctx: Context) {
	return (getNestHonoRequest(ctx.req) as NestHonoRequest & StateCarrier)[
		REQUEST_STATE
	]
}

const CONTEXT_RAW_ACCESSOR = {
	configurable: true,
	enumerable: true,
	get(this: Context) {
		return getSseBridge(getContextState(this)).stream
	},
	set(this: Context, value: unknown) {
		defineValue(this, 'raw', value)
	},
} as const satisfies PropertyDescriptor

/**
 * Attaches the request fields Nest reads (`ip`, `headers`, `socket`) and the
 * SSE facade `ctx.raw` as own accessors; `ip` and `headers` are computed only
 * when read.
 */
export function defineOwnAccessors(
	ctx: Context,
	req: NestHonoRequest,
	state: RequestState
) {
	if (req.ip === undefined) {
		if (state.incoming && !state.options.trustProxy)
			req.ip = state.incoming.socket?.remoteAddress || undefined
		else Object.defineProperty(req, 'ip', REQUEST_ACCESSORS.ip)
	}
	if (req.headers === undefined)
		Object.defineProperty(req, 'headers', REQUEST_ACCESSORS.headers)
	Object.defineProperty(ctx, 'raw', CONTEXT_RAW_ACCESSOR)
	observeResponseReads(ctx)
	if (state.incoming?.socket && !req.socket)
		Object.defineProperty(req, 'socket', SOCKET_ACCESSOR)
}

const ADAPTER_CONTEXT = Symbol('platformHonoAdapterContext')

interface MarkedContext extends Context {
	[ADAPTER_CONTEXT]?: true
}

/**
 * Whether a context was created from an adapter-owned Context class, whose
 * prototypes already carry the accessors `defineOwnAccessors()` defines.
 */
export function isAdapterContext(ctx: Context) {
	return (ctx as MarkedContext)[ADAPTER_CONTEXT] === true
}

/**
 * Members of an adapter-owned HonoRequest prototype: the accessors
 * `defineOwnAccessors()` defines on other requests, with `socket` on Node.js.
 */
export function getAdapterRequestMembers(withSocket: boolean) {
	return withSocket
		? { ...REQUEST_ACCESSORS, socket: SOCKET_ACCESSOR }
		: REQUEST_ACCESSORS
}

/**
 * Members of an adapter-owned Context prototype: the SSE facade `ctx.raw`,
 * `ctx.res` recording reads, and the mark `isAdapterContext()` checks.
 */
export function getAdapterContextMembers(honoPrototype: object) {
	return {
		[ADAPTER_CONTEXT]: { value: true },
		raw: CONTEXT_RAW_ACCESSOR,
		res: createResponseReadsDescriptor(honoPrototype),
	} satisfies PropertyDescriptorMap
}
