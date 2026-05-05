import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'
import type { Context } from 'hono'
import {
	DEFAULT_BODY_LIMIT,
	type HonoAdapterOptions,
	type RequestSizeLimit,
} from '../options'
import { getNestHonoRequest } from './request'

/**
 * Applies the effective body limit before parsing and keeps route-specific
 * limits as a post-parse guard for parsed multipart/form values.
 */
export async function parseRequestBodyWithLimits(
	ctx: Context,
	options: HonoAdapterOptions,
	rawBody: boolean,
	requestSizeLimit?: RequestSizeLimit
) {
	const req = getNestHonoRequest(ctx.req)
	const contentType = ctx.req.header('content-type')
	const effectiveBodyLimit = getEffectiveBodyLimit(options, requestSizeLimit)

	if (requestSizeLimit) enforceContentLengthLimit(ctx, requestSizeLimit)
	if (!isParsableContentType(contentType)) return
	if (effectiveBodyLimit)
		await enforceBodyLimit(
			ctx,
			effectiveBodyLimit,
			requestSizeLimit?.errorMessage
		)

	const preservedRawRequest = cloneRawRequest(ctx.req.raw)

	try {
		await parseRequestBody(ctx, contentType, rawBody)
	} finally {
		if (preservedRawRequest) ctx.req.raw = preservedRawRequest
	}

	if (requestSizeLimit) {
		const parsedBodySize = getParsedBodySize(req.body)
		if (parsedBodySize > requestSizeLimit.maxBytes)
			throw new PayloadTooLargeException(
				requestSizeLimit.errorMessage ?? 'Payload too large'
			)
	}
}

function cloneRawRequest(
	rawRequest: Context['req']['raw']
): Context['req']['raw'] | undefined {
	if (rawRequest.bodyUsed) return

	try {
		return rawRequest.clone() as Context['req']['raw']
	} catch {
		return
	}
}

function isParsableContentType(contentType: string | undefined) {
	return (
		contentType?.startsWith('multipart/form-data') ||
		contentType?.startsWith('application/x-www-form-urlencoded') ||
		contentType?.startsWith('application/json') ||
		contentType?.startsWith('text/plain')
	)
}

/**
 * Creates a Nest-compatible payload-too-large error from Hono's body limit
 * middleware instead of letting Hono throw its default HTTPException.
 */
export function createBodyLimit(maxSize: number) {
	return async (ctx: Context, next: () => Promise<void>) => {
		await enforceRawBodyLimit(
			ctx,
			maxSize,
			`Body size exceeded: ${maxSize} bytes. Size: ${ctx.req.header('Content-Length') ?? 'unknown'} bytes. Method: ${ctx.req.method}. Path: ${ctx.req.path}`
		)

		await next()
	}
}

async function parseRequestBody(
	ctx: Context,
	contentType: string | undefined,
	rawBody: boolean
) {
	const req = getNestHonoRequest(ctx.req)

	if (
		contentType?.startsWith('multipart/form-data') ||
		contentType?.startsWith('application/x-www-form-urlencoded')
	) {
		req.body = await ctx.req.parseBody({ all: true }).catch(() => {
			throw new BadRequestException('Malformed request body')
		})
	} else if (contentType?.startsWith('application/json')) {
		const bodyText = await ctx.req.text()
		if (rawBody) req.rawBody = Buffer.from(bodyText)
		try {
			req.body = bodyText ? JSON.parse(bodyText) : {}
		} catch {
			throw new BadRequestException('Malformed JSON body')
		}
	} else if (contentType?.startsWith('text/plain')) {
		const bodyText = await ctx.req.text()
		if (rawBody) req.rawBody = Buffer.from(bodyText)
		req.body = bodyText
	}
}

function enforceContentLengthLimit(
	ctx: Context,
	requestSizeLimit: RequestSizeLimit
) {
	const contentLengthHeader = ctx.req.header('content-length')
	if (!contentLengthHeader) return

	const contentLength = Number.parseInt(contentLengthHeader, 10)

	if (
		Number.isFinite(contentLength) &&
		contentLength > requestSizeLimit.maxBytes
	)
		throw new PayloadTooLargeException(
			requestSizeLimit.errorMessage ?? 'Payload too large'
		)
}

async function enforceBodyLimit(
	ctx: Context,
	maxBytes: number,
	errorMessage?: string
) {
	await enforceRawBodyLimit(ctx, maxBytes, errorMessage ?? 'Payload too large')
}

async function enforceRawBodyLimit(
	ctx: Context,
	maxBytes: number,
	errorMessage: string
) {
	const contentLengthHeader = ctx.req.header('content-length')
	if (contentLengthHeader) {
		const contentLength = Number.parseInt(contentLengthHeader, 10)
		if (Number.isFinite(contentLength) && contentLength > maxBytes)
			throw new PayloadTooLargeException(errorMessage)
	}

	if (!ctx.req.raw.body) return

	const reader = ctx.req.raw.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0

	for (;;) {
		const { done, value } = await reader.read()
		if (done) break

		size += value.byteLength
		if (size > maxBytes) throw new PayloadTooLargeException(errorMessage)

		chunks.push(value)
	}

	ctx.req.raw = new Request(ctx.req.raw.url, {
		body: new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk)
				controller.close()
			},
		}),
		duplex: 'half',
		headers: ctx.req.raw.headers,
		method: ctx.req.raw.method,
	} as RequestInit & { duplex: 'half' })
}

function getEffectiveBodyLimit(
	options: HonoAdapterOptions,
	requestSizeLimit?: RequestSizeLimit
) {
	if (requestSizeLimit) return requestSizeLimit.maxBytes
	if (options.bodyLimit === false) return
	return options.bodyLimit ?? DEFAULT_BODY_LIMIT
}

function getParsedBodySize(value: unknown): number {
	if (typeof value === 'string') return new TextEncoder().encode(value).length
	if (value instanceof Blob) return value.size
	if (Array.isArray(value))
		return value.reduce(
			(totalSize, itemValue) => totalSize + getParsedBodySize(itemValue),
			0
		)
	if (value && typeof value === 'object')
		return Object.values(value).reduce(
			(totalSize, itemValue) => totalSize + getParsedBodySize(itemValue),
			0
		)
	return 0
}
