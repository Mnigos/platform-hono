import type { IncomingMessage } from 'node:http'
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'
import type { Context } from 'hono'
import {
	DEFAULT_BODY_LIMIT,
	type HonoAdapterOptions,
	type RequestSizeLimit,
} from '../options.js'
import { getNestHonoRequest } from './request.js'

export async function parseRequestBody(
	ctx: Context,
	rawBody: boolean,
	parserType?: string
) {
	const contentType = ctx.req.header('content-type')
	const isRawParser = parserType?.toLowerCase() === 'raw'
	if (parserType && !matchesParserType(contentType, parserType)) return
	if (!(isParsableContentType(contentType) || isRawParser)) return
	if (getNestHonoRequest(ctx.req).body !== undefined) return

	const preservedRawRequest = cloneRawRequest(ctx.req.raw)

	try {
		await parseSupportedRequestBody(ctx, contentType, rawBody, isRawParser)
	} finally {
		if (preservedRawRequest) ctx.req.raw = preservedRawRequest
	}
}

/**
 * Enforces body limits independently from body parsing. The adapter should call
 * this for requests whose body parser is skipped.
 */
export async function enforceRequestBodyLimit(
	ctx: Context,
	options: HonoAdapterOptions,
	requestSizeLimit?: RequestSizeLimit
) {
	const effectiveBodyLimit = getEffectiveBodyLimit(options, requestSizeLimit)
	if (effectiveBodyLimit === undefined) return

	await enforceRawBodyLimit(
		ctx,
		effectiveBodyLimit,
		requestSizeLimit?.errorMessage ?? 'Payload too large'
	)
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
	const mediaType = getMediaType(contentType)

	return (
		mediaType === 'multipart/form-data' ||
		mediaType === 'application/x-www-form-urlencoded' ||
		isJsonMediaType(mediaType) ||
		mediaType?.startsWith('text/')
	)
}

function getMediaType(contentType: string | undefined) {
	return contentType?.split(';', 1)[0]?.trim().toLowerCase()
}

function isJsonMediaType(mediaType: string | undefined) {
	return (
		mediaType === 'application/json' ||
		(mediaType?.startsWith('application/') && mediaType.endsWith('+json'))
	)
}

/**
 * Creates a Nest-compatible payload-too-large error from Hono's body limit
 * middleware instead of letting Hono throw its default HTTPException.
 */
export function createBodyLimit(maxSize: number, parserType?: string) {
	return async (ctx: Context, next: () => Promise<void>) => {
		if (
			parserType &&
			!matchesParserType(ctx.req.header('content-type'), parserType)
		) {
			await next()
			return
		}

		await enforceRawBodyLimit(
			ctx,
			maxSize,
			`Body size exceeded: ${maxSize} bytes. Size: ${ctx.req.header('Content-Length') ?? 'unknown'} bytes. Method: ${ctx.req.method}. Path: ${ctx.req.path}`
		)

		await next()
	}
}

function matchesParserType(
	contentType: string | undefined,
	parserType: string
) {
	const mediaType = getMediaType(contentType)
	if (!mediaType) return false

	switch (parserType.toLowerCase()) {
		case 'json':
			return isJsonMediaType(mediaType)
		case 'raw':
			return mediaType === 'application/octet-stream'
		case 'text':
			return mediaType.startsWith('text/')
		case 'urlencoded':
			return mediaType === 'application/x-www-form-urlencoded'
		default:
			return mediaType === getMediaType(parserType)
	}
}

async function parseSupportedRequestBody(
	ctx: Context,
	contentType: string | undefined,
	rawBody: boolean,
	isRawParser: boolean
) {
	const req = getNestHonoRequest(ctx.req)
	const mediaType = getMediaType(contentType)

	if (isRawParser) {
		const bodyBytes = Buffer.from(await ctx.req.raw.arrayBuffer())
		req.body = bodyBytes
		if (rawBody) req.rawBody = bodyBytes
	} else if (
		mediaType === 'multipart/form-data' ||
		mediaType === 'application/x-www-form-urlencoded'
	) {
		req.body = await ctx.req.raw
			.formData()
			.then(convertFormData)
			.catch(() => {
				throw new BadRequestException('Malformed request body')
			})
	} else if (isJsonMediaType(mediaType)) {
		const bodyBytes = Buffer.from(await ctx.req.raw.arrayBuffer())
		const bodyText = new TextDecoder().decode(bodyBytes)
		if (rawBody) req.rawBody = bodyBytes
		try {
			req.body = bodyText ? JSON.parse(bodyText) : {}
		} catch {
			throw new BadRequestException('Malformed JSON body')
		}
	} else if (mediaType?.startsWith('text/')) {
		const bodyBytes = Buffer.from(await ctx.req.raw.arrayBuffer())
		const bodyText = new TextDecoder().decode(bodyBytes)
		if (rawBody) req.rawBody = bodyBytes
		req.body = bodyText
	}
}

interface FormDataLike {
	forEach(callback: (value: unknown, key: string) => void): void
}

interface NodeRequestEnvironment {
	incoming?: IncomingMessage
}

function convertFormData(formData: FormDataLike) {
	const body: Record<string, unknown | unknown[]> = Object.create(null)

	formData.forEach((value, key) => {
		const currentValue = body[key]
		if (currentValue === undefined) {
			body[key] = key.endsWith('[]') ? [value] : value
		} else if (Array.isArray(currentValue)) currentValue.push(value)
		else body[key] = [currentValue, value]
	})

	return body
}

async function enforceRawBodyLimit(
	ctx: Context,
	maxBytes: number,
	errorMessage: string
) {
	const rawRequest = ctx.req.raw
	const incoming = (ctx.env as NodeRequestEnvironment | undefined)?.incoming
	const contentLengthHeader = ctx.req.header('content-length')
	if (contentLengthHeader) {
		const contentLength = Number.parseInt(contentLengthHeader, 10)
		if (Number.isFinite(contentLength) && contentLength > maxBytes) {
			if (rawRequest.body) await rawRequest.body.cancel().catch(() => undefined)
			else incoming?.destroy()
			throw new PayloadTooLargeException(errorMessage)
		}
	}

	if (!rawRequest.body) {
		if (incoming)
			await enforceIncomingBodyLimit(incoming, maxBytes, errorMessage)
		return
	}

	const reader = rawRequest.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0

	for (;;) {
		const { done, value } = await reader.read()
		if (done) break

		size += value.byteLength
		if (size > maxBytes) {
			await reader.cancel().catch(() => undefined)
			throw new PayloadTooLargeException(errorMessage)
		}

		chunks.push(value)
	}

	ctx.req.raw = new Request(rawRequest.url, {
		body: new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk)
				controller.close()
			},
		}),
		duplex: 'half',
		headers: rawRequest.headers,
		method: rawRequest.method,
		signal: rawRequest.signal,
	} as RequestInit & { duplex: 'half' })
}

async function enforceIncomingBodyLimit(
	incoming: IncomingMessage,
	maxBytes: number,
	errorMessage: string
) {
	const contentLength = Number.parseInt(
		incoming.headers['content-length'] ?? '',
		10
	)
	if (
		!incoming.headers['transfer-encoding'] &&
		(!Number.isFinite(contentLength) || contentLength === 0)
	) {
		return
	}

	let size = 0
	for await (const chunk of incoming) {
		size +=
			typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
		if (size <= maxBytes) continue

		incoming.destroy()
		throw new PayloadTooLargeException(errorMessage)
	}
}

function getEffectiveBodyLimit(
	options: HonoAdapterOptions,
	requestSizeLimit?: RequestSizeLimit
) {
	if (requestSizeLimit) return requestSizeLimit.maxBytes
	if (options.bodyLimit === false) return
	return options.bodyLimit ?? DEFAULT_BODY_LIMIT
}
