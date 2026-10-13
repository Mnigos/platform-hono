import type { NestApplicationOptions } from '@nestjs/common'
import type {
	CorsOptions,
	CorsOptionsDelegate,
	CustomOrigin,
} from '@nestjs/common/interfaces/external/cors-options.interface'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { getNestRequest } from '../request/nest-request'

export type NestCorsOptions = Exclude<
	NestApplicationOptions['cors'],
	boolean | undefined
>
type StaticOrigin = Exclude<CorsOptions['origin'], CustomOrigin>

function normalizeCorsList(value?: string | string[]) {
	if (!value) return
	return Array.isArray(value)
		? value
		: value
				.split(',')
				.map(item => item.trim())
				.filter(Boolean)
}

function isAllowedOrigin(
	requestOrigin: string,
	allowedOrigin: boolean | string | RegExp | (string | RegExp)[]
): boolean {
	if (allowedOrigin === true) return true
	if (!allowedOrigin) return false
	if (Array.isArray(allowedOrigin)) {
		return allowedOrigin.some(origin => isAllowedOrigin(requestOrigin, origin))
	}
	if (allowedOrigin instanceof RegExp) {
		allowedOrigin.lastIndex = 0
		return allowedOrigin.test(requestOrigin)
	}
	return allowedOrigin === requestOrigin
}

function normalizeCorsOrigin(origin: StaticOrigin | undefined) {
	if (origin === undefined || origin === '*') return '*'
	return (requestOrigin: string) =>
		isAllowedOrigin(requestOrigin, origin) ? requestOrigin : undefined
}

function resolveCorsOrigin(
	origin: CorsOptions['origin'],
	requestOrigin: string | undefined
) {
	if (typeof origin !== 'function') return origin
	const originCallback = origin as (
		requestOrigin: string | undefined,
		callback: Parameters<CustomOrigin>[1]
	) => void
	return new Promise<StaticOrigin | undefined>((resolve, reject) => {
		originCallback(requestOrigin || undefined, (error, allowedOrigin) => {
			if (error) reject(error)
			else resolve(allowedOrigin ?? false)
		})
	})
}

function normalizeCorsOptions(options: CorsOptions, origin?: StaticOrigin) {
	const allowHeaders = normalizeCorsList(options.allowedHeaders)
	const allowMethods = normalizeCorsList(options.methods)
	const exposeHeaders = normalizeCorsList(options.exposedHeaders)
	return {
		...(allowHeaders ? { allowHeaders } : {}),
		...(allowMethods ? { allowMethods } : {}),
		...(options.credentials === undefined
			? {}
			: { credentials: options.credentials }),
		...(exposeHeaders ? { exposeHeaders } : {}),
		...(options.maxAge === undefined ? {} : { maxAge: options.maxAge }),
		origin: normalizeCorsOrigin(origin),
	}
}

function resolveCorsOptions(
	delegate: CorsOptionsDelegate<Context['req']>,
	request: Context['req']
) {
	return new Promise<CorsOptions>((resolve, reject) => {
		delegate(request, (error, options) => {
			if (error) reject(error)
			else resolve(options)
		})
	})
}

/**
 * Translates Nest CORS options, including origin callbacks and per-request
 * delegates, into Hono's `cors` middleware.
 */
export function createCorsMiddleware(options: NestCorsOptions = {}) {
	return async (ctx: Context, next: () => Promise<void>) => {
		const resolvedOptions =
			typeof options === 'function'
				? await resolveCorsOptions(options, getNestRequest(ctx.req))
				: options
		const origin = await resolveCorsOrigin(
			resolvedOptions.origin,
			ctx.req.header('origin')
		)
		if (origin === false) {
			await next()
			return
		}
		const corsMiddleware = cors(normalizeCorsOptions(resolvedOptions, origin))

		if (ctx.req.method === 'OPTIONS' && resolvedOptions.preflightContinue) {
			await corsMiddleware(ctx, async () => undefined)
			await next()
			return
		}

		const response = await corsMiddleware(ctx, next)
		if (
			ctx.req.method === 'OPTIONS' &&
			resolvedOptions.optionsSuccessStatus &&
			response instanceof Response
		) {
			return new Response(null, {
				headers: response.headers,
				status: resolvedOptions.optionsSuccessStatus,
			})
		}
		return response
	}
}
