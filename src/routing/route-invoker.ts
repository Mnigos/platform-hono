import type { RequestHandler } from '@nestjs/common/interfaces'
import type { Context, MiddlewareHandler } from 'hono'
import {
	finalizeResponse,
	getFinalizedResponse,
	onResponseFinalized,
} from '../helpers/response'
import type { HonoAdapterOptions } from '../options'
import {
	getRequestState,
	setRouteParams,
	syncRawRequest,
} from '../request/request-state'
import { waitForRouteResult } from '../response/sse-bridge'
import type { OptionalParameterSuffix } from './route-paths'

const noop = () => undefined

async function finalizeRouteResponse(
	ctx: Context,
	adapterOptions: HonoAdapterOptions,
	response?: Response
) {
	const finalized = getFinalizedResponse(ctx, response)
	const state = getRequestState(ctx, adapterOptions)
	if (state.method !== 'HEAD' || !finalized.body) return finalized

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
	} else await finalized.body.cancel().catch(() => undefined)
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
export async function invokeHandler(
	handler: RequestHandler | Function,
	ctx: Context,
	next: () => Promise<void>,
	waitForNext = false
) {
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
	const response = await handler(ctx.req, ctx, nestNext)
	if (
		!nextPromise &&
		waitForNext &&
		!(response instanceof Response) &&
		!ctx.finalized
	) {
		const nextCalled = new Promise<void>(resolve => {
			notifyNextCall = resolve
		})
		const removeFinalizeListener = onResponseFinalized(ctx, notifyNextCall)
		await nextCalled
		removeFinalizeListener()
	}
	if (nextPromise) await nextPromise
	return response
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
	return async (ctx, next) => {
		const state = getRequestState(ctx, adapterOptions)
		syncRawRequest(state)
		setRouteParams(ctx, optionalParameterSuffixes)
		const handlerPromise = invokeHandler(routeHandler, ctx, next, waitForNext)
		const result = await waitForRouteResult(state, handlerPromise)
		if (result.type === 'sse') {
			handlerPromise.catch(error => {
				state.sse?.stream.destroy(error)
			})
			return finalizeRouteResponse(ctx, adapterOptions, result.response)
		}
		return finalizeRouteResponse(
			ctx,
			adapterOptions,
			result.response instanceof Response ? result.response : undefined
		)
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
