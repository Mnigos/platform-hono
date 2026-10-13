import type { IncomingMessage } from 'node:http'
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'
import type { Context } from 'hono'
import {
	DEFAULT_BODY_LIMIT,
	type HonoAdapterOptions,
	type RequestSizeLimit,
} from '../options'
import { getRequestHeader, replaceRawRequest } from '../request/request-state'
import {
	createMultipartLimitScanner,
	type MultipartLimitScanner,
} from './multipart-limits'
import { getNestHonoRequest } from './request'

const BODY_LIMIT_REGEX = /^\s*(\d*\.?\d+)\s*(b|kb|mb|gb|tb|pb)?\s*$/i
const textDecoder = new TextDecoder()

/**
 * Reads the request body once, parses it into `req.body` (and `req.rawBody`),
 * and replaces `ctx.req.raw` with an unread copy for downstream consumers.
 */
export async function parseRequestBody(
	ctx: Context,
	rawBody: boolean,
	parserType?: string,
	contentType = getRequestHeader(ctx, 'content-type')
) {
	if (!shouldParseRequestBody(ctx, parserType, contentType)) return
	await parseSupportedRequestBody(
		ctx,
		contentType,
		rawBody,
		parserType?.toLowerCase() === 'raw'
	)
}

/**
 * Whether a parser for `parserType` applies to the request, so callers can skip
 * the asynchronous parse step synchronously.
 */
export function shouldParseRequestBody(
	ctx: Context,
	parserType: string | undefined,
	contentType: string | undefined
) {
	const isRawParser = parserType?.toLowerCase() === 'raw'
	if (parserType && !matchesParserType(contentType, parserType)) return false
	if (!(isParsableContentType(contentType) || isRawParser)) return false
	return getNestHonoRequest(ctx.req).body === undefined
}

/**
 * Enforces body limits independently from body parsing. The adapter should call
 * this for requests whose body parser is skipped. Returns `undefined` when the
 * declared `Content-Length` already proves the body is within the limit, so
 * callers can continue without awaiting.
 */
export function enforceRequestBodyLimit(
	ctx: Context,
	options: HonoAdapterOptions,
	requestSizeLimit?: RequestSizeLimit
) {
	const effectiveBodyLimit = getEffectiveBodyLimit(options, requestSizeLimit)
	const multipartScanner = options.multipartLimits
		? createMultipartLimitScanner(
				getRequestHeader(ctx, 'content-type'),
				options.multipartLimits
			)
		: undefined
	if (effectiveBodyLimit === undefined && !multipartScanner) return

	return enforceRawBodyLimit(
		ctx,
		effectiveBodyLimit ?? Number.POSITIVE_INFINITY,
		requestSizeLimit?.errorMessage ?? 'Payload too large',
		multipartScanner
	)
}

function createUnreadRequest(rawRequest: Request, body: ArrayBuffer | string) {
	const { method } = rawRequest
	return new Request(rawRequest.url, {
		body: method === 'GET' || method === 'HEAD' ? undefined : body,
		headers: rawRequest.headers,
		method,
		signal: rawRequest.signal,
	})
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

let lastContentType: string | undefined
let lastMediaType: string | undefined

function getMediaType(contentType: string | undefined) {
	if (contentType === lastContentType) return lastMediaType
	lastContentType = contentType
	lastMediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
	return lastMediaType
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
	const isFormBody =
		!isRawParser &&
		(mediaType === 'multipart/form-data' ||
			mediaType === 'application/x-www-form-urlencoded')
	const rawRequest = ctx.req.raw
	const isJsonBody = !isRawParser && isJsonMediaType(mediaType)
	const isTextBody =
		!(isRawParser || isFormBody) && mediaType?.startsWith('text/')
	if (!rawBody && (isJsonBody || isTextBody)) {
		const bodyText = await rawRequest.text()
		replaceRawRequest(ctx, () => createUnreadRequest(rawRequest, bodyText))
		req.body = isJsonBody ? parseJsonBody(bodyText) : bodyText
		return
	}

	const bodyBuffer = await rawRequest.arrayBuffer().catch(error => {
		if (isFormBody) throw new BadRequestException('Malformed request body')
		throw error
	})
	replaceRawRequest(ctx, () => createUnreadRequest(rawRequest, bodyBuffer))
	const bodyBytes = Buffer.from(bodyBuffer)
	if (rawBody) req.rawBody = bodyBytes

	if (isRawParser) req.body = bodyBytes
	else if (isFormBody) {
		req.body = await new Response(bodyBuffer, {
			headers: { 'content-type': contentType ?? '' },
		})
			.formData()
			.then(convertFormData)
			.catch(() => {
				throw new BadRequestException('Malformed request body')
			})
	} else if (isJsonBody) req.body = parseJsonBody(textDecoder.decode(bodyBytes))
	else if (isTextBody) req.body = textDecoder.decode(bodyBytes)
}

function parseJsonBody(bodyText: string) {
	try {
		return bodyText ? JSON.parse(bodyText) : {}
	} catch {
		throw new BadRequestException('Malformed JSON body')
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

function enforceRawBodyLimit(
	ctx: Context,
	maxBytes: number,
	errorMessage: string,
	multipartScanner?: MultipartLimitScanner
) {
	const contentLengthHeader = getRequestHeader(ctx, 'content-length')
	if (contentLengthHeader) {
		const contentLength = Number.parseInt(contentLengthHeader, 10)
		if (Number.isFinite(contentLength) && contentLength > maxBytes)
			return rejectDeclaredLength(ctx, errorMessage)
		if (
			Number.isFinite(contentLength) &&
			!multipartScanner &&
			getRequestHeader(ctx, 'transfer-encoding') === undefined
		)
			return
	}

	return readBodyWithinLimit(ctx, maxBytes, errorMessage, multipartScanner)
}

async function rejectDeclaredLength(ctx: Context, errorMessage: string) {
	const rawRequest = ctx.req.raw
	if (rawRequest.body) await rawRequest.body.cancel().catch(() => undefined)
	else (ctx.env as NodeRequestEnvironment | undefined)?.incoming?.destroy()
	throw new PayloadTooLargeException(errorMessage)
}

async function readBodyWithinLimit(
	ctx: Context,
	maxBytes: number,
	errorMessage: string,
	multipartScanner?: MultipartLimitScanner
) {
	const rawRequest = ctx.req.raw
	const incoming = (ctx.env as NodeRequestEnvironment | undefined)?.incoming
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
		try {
			multipartScanner?.write(value)
		} catch (error) {
			await reader.cancel().catch(() => undefined)
			throw error
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

/**
 * Parses Nest body parser limits such as `10kb` or `1.5mb` into bytes.
 */
export function parseBodyLimit(limit: number | string | undefined) {
	if (typeof limit === 'number') return limit
	if (limit === undefined) return
	const match = limit.match(BODY_LIMIT_REGEX)
	if (!match) throw new Error(`Invalid body parser limit: ${limit}`)
	const multipliers = {
		b: 1,
		gb: 1024 ** 3,
		kb: 1024,
		mb: 1024 ** 2,
		pb: 1024 ** 5,
		tb: 1024 ** 4,
	}
	const unit = (match[2]?.toLowerCase() ?? 'b') as keyof typeof multipliers
	return Math.floor(Number(match[1]) * multipliers[unit])
}
