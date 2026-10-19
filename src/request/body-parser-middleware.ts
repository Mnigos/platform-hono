import type { Context } from 'hono'
import {
	parseRequestBody,
	shouldParseRequestBody,
} from '../helpers/body-parser'
import type { HonoAdapterOptions } from '../options'
import { getContentType, mayHaveRequestBody } from './request-headers'
import { getRequestState, shouldSkipBodyParser } from './request-state'
import { syncRawRequest } from './request-state-core'

interface ParserMiddlewareOptions {
	adapterOptions: HonoAdapterOptions
	parserTypes: readonly string[]
	rawBody: boolean
}

/**
 * Creates one Hono middleware for one or more parser types. The first
 * applicable type parses the body; requests without a matching `Content-Type`
 * and `GET` requests without a body continue synchronously, without an extra
 * async frame or reading the `Content-Type`.
 */
export function createParserMiddleware({
	adapterOptions,
	parserTypes,
	rawBody,
}: ParserMiddlewareOptions) {
	return (ctx: Context, next: () => Promise<void>) => {
		const state = getRequestState(ctx, adapterOptions)
		syncRawRequest(state)
		if (state.method === 'GET' && !mayHaveRequestBody(state)) return next()
		const contentType = getContentType(state)
		if (contentType === undefined) return next()
		const parserType = parserTypes.find(type =>
			shouldParseRequestBody(ctx, type, contentType)
		)
		if (parserType === undefined || shouldSkipBodyParser(state)) return next()
		return parseRequestBody(
			ctx,
			rawBody,
			parserType,
			contentType,
			adapterOptions.multipartLimits
		).then(() => {
			syncRawRequest(state)
			return next()
		})
	}
}
