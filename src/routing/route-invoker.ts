import type { RequestHandler } from '@nestjs/common/interfaces/http/http-server.interface'
import type { Context, MiddlewareHandler } from 'hono'
import {
	finalizeResponse,
	getFinalizedResponse,
	onResponseFinalized,
} from '../helpers/response'
import type { HonoAdapterOptions } from '../options'
import { getNestRequest } from '../request/nest-request'
import {
	getRequestState,
	type RequestState,
	syncRawRequest,
} from '../request/request-state'
import { setRouteParams } from '../request/route-params'
import type { OptionalParameterSuffix } from './route-paths'

const noop = () => undefined

function finalizeRouteResponse(
	ctx: Context,
	adapterOptions: HonoAdapterOptions,
	response?: Response
) {
	const finalized = getFinalizedResponse(ctx, response)
	const state = getRequestState(ctx, adapterOptions)
	if (state.method !== 'HEAD' || !finalized.body) return finalized
	return finalizeHeadResponse(ctx, state, finalized)
}

async function finalizeHeadResponse(
	ctx: Context,
	state: RequestState,
	finalized: Response
) {
	const sseStream = state.sse?.started ? state.sse.stream : undefined
	if (sseStream) {
		state.socketBridge?.signalClose()
		await new Promise<void>(resolve => {
			if (sseStream.closed) {
				resolve()
				return
			}
			sseStream.once('close', resolve)
			sseStream.destroy()
		})
	} else await finalized.body?.cancel().catch(() => undefined)
	return finalizeResponse(
		ctx,
		new Response(null, {
			headers: finalized.headers,
			status: finalized.status,
			statusText: finalized.statusText,
		})
	)
}

/**
 * Calls a Nest handler with Express-style `(req, res, next)` arguments. For
 * middleware, waits until it calls `next()` or finalizes the response.
 */
export function invokeHandler(
	handler: RequestHandler | Function,
	ctx: Context,
	next: () => Promise<void>,
	waitForNext = false
): Promise<unknown> {
	let nextPromise: Promise<void> | undefined
	let notifyNextCall: () => void = noop
	const nestNext = (error?: unknown) => {
		nextPromise ??=
			error === undefined || error === null
				? next()
				: Promise.reject(
						error instanceof Error ? error : new Error(String(error))
					)
		notifyNextCall()
		return nextPromise
	}
	const afterNext = (response: unknown) =>
		nextPromise ? nextPromise.then(() => response) : response
	const settle = (response: unknown) => {
		if (
			nextPromise ||
			!waitForNext ||
			response instanceof Response ||
			ctx.finalized
		)
			return afterNext(response)
		let removeFinalizeListener: () => void = noop
		return new Promise<void>(resolve => {
			notifyNextCall = resolve
			removeFinalizeListener = onResponseFinalized(ctx, resolve)
		}).then(() => {
			removeFinalizeListener()
			return afterNext(response)
		})
	}
	try {
		return Promise.resolve(
			handler(getNestRequest(ctx.req), ctx, nestNext)
		).then(settle)
	} catch (error) {
		return Promise.reject(error)
	}
}

interface RouteHandlerOptions {
	adapterOptions: HonoAdapterOptions
	optionalParameterSuffixes?: OptionalParameterSuffix[]
	routeHandler: RequestHandler
	waitForNext?: boolean
}

/**
 * Wraps a Nest route or middleware handler as a Hono middleware that sets
 * request params, waits for the handler or the start of an SSE stream, and
 * finalizes the Hono response.
 */
export function createRouteHandler({
	adapterOptions,
	optionalParameterSuffixes = [],
	routeHandler,
	waitForNext = false,
}: RouteHandlerOptions): MiddlewareHandler {
	return (ctx, next) => {
		const state = getRequestState(ctx, adapterOptions)
		syncRawRequest(state)
		setRouteParams(state, optionalParameterSuffixes)
		const handlerPromise = invokeHandler(routeHandler, ctx, next, waitForNext)
		return new Promise<Response | undefined>((resolve, reject) => {
			let settled = false
			const finish = (response: Response | undefined) => {
				if (settled) return
				settled = true
				try {
					resolve(finalizeRouteResponse(ctx, adapterOptions, response))
				} catch (error) {
					reject(error)
				}
			}
			const finishSse = (response: Response) => {
				handlerPromise.catch(error => {
					state.sse?.stream.destroy(error)
				})
				finish(response)
			}
			const sseResponse = state.sse?.response
			if (sseResponse) {
				finishSse(sseResponse)
				return
			}
			handlerPromise.then(
				response => finish(response instanceof Response ? response : undefined),
				error => {
					if (settled) return
					settled = true
					reject(error)
				}
			)
			const previousWaiter = state.sseWaiter
			state.sseWaiter = previousWaiter
				? response => {
						previousWaiter(response)
						finishSse(response)
					}
				: finishSse
		})
	}
}

/**
 * Runs Hono middleware handlers in order, then `next`.
 */
export function runHandlers(
	ctx: Context,
	handlers: MiddlewareHandler[],
	next: () => Promise<void>
) {
	const dispatch = async (index: number): Promise<Response | undefined> => {
		const handler = handlers[index]
		if (!handler) {
			await next()
			return
		}
		return (
			(await handler(ctx, async () => {
				await dispatch(index + 1)
			})) ?? undefined
		)
	}
	return dispatch(0)
}
