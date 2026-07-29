import { EventEmitter } from 'node:events'
import {
	createServer as createHttpServer,
	type Server as HttpServer,
	type OutgoingHttpHeaders,
} from 'node:http'
import {
	createServer as createHttpsServer,
	type Server as HttpsServer,
} from 'node:https'
import { PassThrough, Readable } from 'node:stream'
import { createAdaptorServer } from '@hono/node-server'
import {
	type ServeStaticOptions,
	serveStatic,
} from '@hono/node-server/serve-static'
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response'
import {
	HttpStatus,
	Logger,
	type NestApplicationOptions,
	RequestMethod,
	type VersioningOptions,
} from '@nestjs/common'
import type {
	CorsOptions,
	CorsOptionsDelegate,
	CustomOrigin,
} from '@nestjs/common/interfaces/external/cors-options.interface.js'
import type {
	RequestHandler,
	VersionValue,
} from '@nestjs/common/interfaces/index.js'
import { AbstractHttpAdapter } from '@nestjs/core'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import {
	createBodyLimit,
	enforceRequestBodyLimit,
	parseRequestBody,
} from './helpers/body-parser.js'
import { extractClientIp } from './helpers/client-ip.js'
import { getRequestSizeLimit, isPathMatch } from './helpers/path-matching.js'
import { getNestHonoRequest } from './helpers/request.js'
import {
	createResponse,
	finalizeResponse,
	getFinalizedResponse,
	isJsonContentType,
	normalizeContext,
} from './helpers/response.js'
import type { HonoAdapterOptions } from './options.js'

type RouteHandler = (
	req: Context['req'],
	res: Context,
	next: () => Promise<void>
) => Response | undefined | Promise<Response | undefined>

type HonoRouteMethod =
	| 'all'
	| 'copy'
	| 'delete'
	| 'get'
	| 'head'
	| 'lock'
	| 'mkcol'
	| 'move'
	| 'options'
	| 'patch'
	| 'post'
	| 'propfind'
	| 'proppatch'
	| 'put'
	| 'search'
	| 'unlock'
	| 'use'

type NestCorsOptions = CorsOptions | CorsOptionsDelegate<Context['req']>

interface StaticAssetsOptions extends ServeStaticOptions {
	prefix?: string
}

interface NodeRequestBindings {
	incoming?: {
		on: (event: string, listener: (...args: unknown[]) => void) => unknown
		socket?: NodeSocketLike
	}
}

interface NodeSocketLike {
	on: (event: string, listener: (...args: unknown[]) => void) => unknown
	once: (event: string, listener: (...args: unknown[]) => void) => unknown
	removeListener: (
		event: string,
		listener: (...args: unknown[]) => void
	) => unknown
	[key: PropertyKey]: unknown
}

interface RequestSocketBridge {
	signalClose: () => void
	socket: NodeSocketLike
}

interface RequestEventBridge {
	on?: (event: string, listener: (...args: unknown[]) => void) => unknown
	socket?: unknown
}

interface HonoSseContext extends Context {
	getHeaders?: () => OutgoingHttpHeaders
	raw?: HonoSseWritable
	requestSocketBridge?: RequestSocketBridge
	sseResponseReady?: Promise<Response>
	sseStarted?: boolean
}

interface HonoSseWritable extends PassThrough {
	flushHeaders: () => void
	getHeaders: () => OutgoingHttpHeaders
	setHeader: (name: string, value: number | string | string[]) => void
	statusCode?: number
	writeHead: (
		statusCode: number,
		reasonPhraseOrHeaders?: OutgoingHttpHeaders | string,
		headers?: OutgoingHttpHeaders
	) => HonoSseWritable
}

const BODY_LIMIT_REGEX = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i
const HONO_CONSTRAINT_MARKER_REGEX = /[\\[\]()+*?|^$]/
const HONO_PARAMETER_SUFFIX_REGEX = /:[A-Za-z_$][\w$]*$/
const HONO_WILDCARD_SUFFIX_REGEX = /:[A-Za-z_$][\w$]*\{(?:\.\*|\.\+)\}$/
const OPTIONAL_GROUP_PARAMETER_REGEX = /(?:^|[/.-]):[A-Za-z_$][\w$]*/
const TRAILING_SLASHES_REGEX = /\/+$/

interface OptionalRouteGroup {
	content: string
	end: number
	start: number
}

interface OptionalParameterSuffix {
	name: string
	suffix: string
}

function findClosingBrace(path: string, start: number) {
	let depth = 0
	let insideCharacterClass = false
	for (let index = start; index < path.length; index += 1) {
		const character = path[index]
		if (character === '\\') {
			index += 1
			continue
		}
		if (character === '[') insideCharacterClass = true
		else if (character === ']') insideCharacterClass = false
		else if (!insideCharacterClass && character === '{') depth += 1
		else if (!insideCharacterClass && character === '}') {
			depth -= 1
			if (depth === 0) return index
		}
	}
}

function findOptionalRouteGroup(path: string): OptionalRouteGroup | undefined {
	for (let start = 0; start < path.length; start += 1) {
		if (path[start] !== '{') continue
		const end = findClosingBrace(path, start)
		if (end === undefined) return
		const content = path.slice(start + 1, end)
		const followsHonoParameter = HONO_PARAMETER_SUFFIX_REGEX.test(
			path.slice(0, start)
		)
		if (
			!followsHonoParameter ||
			OPTIONAL_GROUP_PARAMETER_REGEX.test(content) ||
			!HONO_CONSTRAINT_MARKER_REGEX.test(content)
		) {
			return { content, end, start }
		}
		start = end
	}
}

function getOptionalParameterSuffix(
	path: string,
	optionalGroup: OptionalRouteGroup
): OptionalParameterSuffix | undefined {
	const name = path
		.slice(0, optionalGroup.start)
		.match(HONO_PARAMETER_SUFFIX_REGEX)?.[0]
		.slice(1)
	const { content } = optionalGroup
	if (
		!(name && content) ||
		content.includes('/') ||
		OPTIONAL_GROUP_PARAMETER_REGEX.test(content) ||
		HONO_CONSTRAINT_MARKER_REGEX.test(content)
	)
		return

	return { name, suffix: content }
}

function getOptionalParameterSuffixes(path: string) {
	const suffixes: OptionalParameterSuffix[] = []
	let remainingPath = path
	for (;;) {
		const optionalGroup = findOptionalRouteGroup(remainingPath)
		if (!optionalGroup) return suffixes
		const suffix = getOptionalParameterSuffix(remainingPath, optionalGroup)
		if (suffix) suffixes.push(suffix)
		remainingPath = `${remainingPath.slice(0, optionalGroup.start)}${remainingPath.slice(optionalGroup.end + 1)}`
	}
}

function normalizeHonoPaths(path: string): string[] {
	const optionalGroup = findOptionalRouteGroup(path)
	if (!optionalGroup) {
		return [path.replace(/\/\*([A-Za-z_$][\w$]*)/g, '/:$1{.+}')]
	}

	const before = path.slice(0, optionalGroup.start)
	const after = path.slice(optionalGroup.end + 1)
	if (getOptionalParameterSuffix(path, optionalGroup)) {
		return normalizeHonoPaths(`${before}${after}`)
	}
	return [
		...normalizeHonoPaths(`${before}${optionalGroup.content}${after}`),
		...normalizeHonoPaths(`${before}${after}`),
	]
}

function normalizeHonoMiddlewarePath(path: string) {
	if (path === '*') return path
	if (path === '/') return '/*'
	if (path.endsWith('/*') || HONO_WILDCARD_SUFFIX_REGEX.test(path)) return path

	return `${path.replace(TRAILING_SLASHES_REGEX, '')}/*`
}

function getResponseHeaders(ctx: Context) {
	const headers: OutgoingHttpHeaders = Object.fromEntries(ctx.res.headers)
	const setCookies = (
		ctx.res.headers as Headers & { getSetCookie?: () => string[] }
	).getSetCookie?.()
	if (setCookies?.length) headers['set-cookie'] = setCookies
	return headers
}

function setResponseHeader(
	ctx: Context,
	name: string,
	value: number | string | string[] | undefined
) {
	if (value === undefined) return
	if (!Array.isArray(value)) {
		ctx.res.headers.set(name, String(value))
		return
	}

	ctx.res.headers.delete(name)
	for (const item of value) ctx.res.headers.append(name, String(item))
}

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
	if (allowedOrigin === true || allowedOrigin === '*') return true
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

function normalizeCorsOrigin(origin: CorsOptions['origin']) {
	if (origin === undefined) return '*'
	if (origin === false) return () => undefined
	if (typeof origin !== 'function') {
		if (origin === '*') return '*'
		return (requestOrigin: string) =>
			isAllowedOrigin(requestOrigin, origin) ? requestOrigin : undefined
	}

	const originCallback = origin as (
		requestOrigin: string | undefined,
		callback: Parameters<CustomOrigin>[1]
	) => void
	return (requestOrigin: string) =>
		new Promise<string | undefined>((resolve, reject) => {
			originCallback(requestOrigin || undefined, (error, allowedOrigin) => {
				if (error) {
					reject(error)
					return
				}
				if (!(allowedOrigin && isAllowedOrigin(requestOrigin, allowedOrigin))) {
					resolve(undefined)
					return
				}
				resolve(allowedOrigin === '*' ? '*' : requestOrigin)
			})
		})
}

function normalizeCorsOptions(options: CorsOptions) {
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
		origin: normalizeCorsOrigin(options.origin),
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

function normalizeStaticPrefix(prefix: string) {
	const normalized = `/${prefix.replace(/^\/+|\/+$/g, '')}`
	return normalized === '/' ? '' : normalized
}

function createStaticMiddleware(options: ServeStaticOptions) {
	const middleware = serveStatic(options)
	return async (ctx: Context, next: () => Promise<void>) => {
		if (ctx.req.method === 'GET' || ctx.req.method === 'HEAD') {
			let continued = false
			const response = await middleware(ctx, async () => {
				continued = true
				await next()
			})
			if (continued || !(response instanceof Response)) return response

			return finalizeResponse(ctx, createResponse(ctx, response))
		}
		return next()
	}
}

function createRequestSocketBridge(socket: NodeSocketLike) {
	const closeEvents = new EventEmitter()
	let listening = false
	let bridgedSocket: NodeSocketLike
	const forwardClose = (...args: unknown[]) => {
		listening = false
		closeEvents.emit('close', ...args)
	}
	const listen = () => {
		if (listening) return
		listening = true
		socket.once('close', forwardClose)
	}
	const stopListening = () => {
		if (!listening) return
		listening = false
		socket.removeListener('close', forwardClose)
	}
	const addCloseListener = (
		method: 'on' | 'once',
		listener: (...args: unknown[]) => void
	) => {
		listen()
		closeEvents[method]('close', listener)
		return bridgedSocket
	}
	const removeCloseListener = (listener: (...args: unknown[]) => void) => {
		closeEvents.removeListener('close', listener)
		if (closeEvents.listenerCount('close') === 0) stopListening()
		return bridgedSocket
	}

	bridgedSocket = new Proxy(socket, {
		get(target, property) {
			if (property === 'on' || property === 'addListener') {
				return (event: string, listener: (...args: unknown[]) => void) => {
					if (event === 'close') return addCloseListener('on', listener)
					socket.on(event, listener)
					return bridgedSocket
				}
			}
			if (property === 'once') {
				return (event: string, listener: (...args: unknown[]) => void) => {
					if (event === 'close') return addCloseListener('once', listener)
					socket.once(event, listener)
					return bridgedSocket
				}
			}
			if (property === 'off' || property === 'removeListener') {
				return (event: string, listener: (...args: unknown[]) => void) => {
					if (event === 'close') return removeCloseListener(listener)
					socket.removeListener(event, listener)
					return bridgedSocket
				}
			}

			const socketValue = Reflect.get(target, property, target)
			return typeof socketValue === 'function'
				? socketValue.bind(target)
				: socketValue
		},
		set(target, property, value) {
			return Reflect.set(target, property, value, target)
		},
	})

	return {
		signalClose() {
			stopListening()
			closeEvents.emit('close')
		},
		socket: bridgedSocket,
	}
}

function parseBodyLimit(limit: number | string | undefined) {
	if (typeof limit === 'number') return limit
	const match = limit?.match(BODY_LIMIT_REGEX)
	if (!match) return
	const multipliers = { b: 1, gb: 1024 ** 3, kb: 1024, mb: 1024 ** 2 }
	const unit = (match[2]?.toLowerCase() ?? 'b') as keyof typeof multipliers
	return Math.floor(Number(match[1]) * multipliers[unit])
}

export class HonoAdapter extends AbstractHttpAdapter<
	HttpServer | HttpsServer,
	Context['req'],
	Context
> {
	private _isParserRegistered = false
	private readonly adapterOptions: HonoAdapterOptions
	private readonly logger = new Logger('HonoAdapter')
	private forceCloseConnections = false
	private readonly headRoutePaths = new Set<string>()

	constructor(options: HonoAdapterOptions = {}) {
		super(new Hono())
		this.adapterOptions = options
	}

	get hono() {
		return this.instance as Hono
	}

	get isParserRegistered() {
		return this._isParserRegistered
	}

	private getRouteAndHandler(
		pathOrHandler: string | RouteHandler,
		handler?: RouteHandler
	): [string, RouteHandler] {
		const path = typeof pathOrHandler === 'function' ? '' : pathOrHandler
		const routeHandler =
			typeof pathOrHandler === 'function' ? pathOrHandler : handler
		if (!routeHandler) throw new Error('Route handler is required')
		return [path, routeHandler]
	}

	private createRouteHandler(
		routeHandler: RequestHandler,
		waitForNext = false,
		optionalParameterSuffixes: OptionalParameterSuffix[] = []
	): MiddlewareHandler {
		return async (ctx, next) => {
			const sseResponse = this.attachSseBridge(ctx)
			this.normalizeRequestMetadata(ctx, optionalParameterSuffixes)
			const handlerPromise = this.invokeHandler(
				routeHandler,
				ctx,
				next,
				waitForNext
			)
			const result = await Promise.race([
				handlerPromise.then(response => ({
					response,
					type: 'handler' as const,
				})),
				sseResponse.then(response => ({ response, type: 'sse' as const })),
			])
			if (result.type === 'sse') {
				handlerPromise.catch(error => {
					const stream = (ctx as HonoSseContext).raw
					stream?.destroy(error)
				})
				return this.finalizeRouteResponse(ctx, result.response)
			}
			return this.finalizeRouteResponse(
				ctx,
				result.response instanceof Response ? result.response : undefined
			)
		}
	}

	private async finalizeRouteResponse(ctx: Context, response?: Response) {
		const finalized = getFinalizedResponse(ctx, response)
		if (ctx.req.method !== 'HEAD' || !finalized.body) return finalized

		const sseContext = ctx as HonoSseContext
		if (sseContext.sseStarted) {
			sseContext.requestSocketBridge?.signalClose()
			if (sseContext.raw) {
				await new Promise<void>(resolve => {
					if (sseContext.raw?.closed) {
						resolve()
						return
					}
					sseContext.raw?.once('close', resolve)
					sseContext.raw?.destroy()
				})
			}
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

	private async invokeHandler(
		handler: RequestHandler | Function,
		ctx: Context,
		next: () => Promise<void>,
		waitForNext = false
	) {
		let nextPromise: Promise<void> | undefined
		let notifyNextCall: () => void = () => undefined
		const nextCalled = new Promise<void>(resolve => {
			notifyNextCall = resolve
		})
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
			await nextCalled
		}
		if (nextPromise) await nextPromise
		return response
	}

	private attachRequestBridge(ctx: Context) {
		const req = getNestHonoRequest(ctx.req)
		const rawRequest = ctx.req.raw as Request & RequestEventBridge
		const incoming = (ctx.env as NodeRequestBindings | undefined)?.incoming
		if (incoming?.socket) {
			const sseContext = ctx as HonoSseContext
			const requestSocketBridge =
				sseContext.requestSocketBridge ??
				createRequestSocketBridge(incoming.socket)
			sseContext.requestSocketBridge = requestSocketBridge
			if (!req.socket) req.socket = requestSocketBridge.socket
			if (!rawRequest.socket) rawRequest.socket = requestSocketBridge.socket
		}
		const on = (event: string, listener: (...args: unknown[]) => void) => {
			if (event !== 'close' && incoming) return incoming.on(event, listener)
			if (event !== 'close') return req

			const sseContext = ctx as HonoSseContext
			const socket = sseContext.requestSocketBridge?.socket
			const signal = ctx.req.raw.signal
			const sseResponse = sseContext.raw
			let called = false
			const cleanup = () => {
				signal.removeEventListener('abort', invokeListener)
				socket?.removeListener('close', invokeListener)
				sseResponse?.removeListener('close', invokeListener)
			}
			const invokeListener = (...args: unknown[]) => {
				if (called) return
				called = true
				cleanup()
				listener(...args)
			}
			if (signal.aborted) queueMicrotask(invokeListener)
			else {
				signal.addEventListener('abort', invokeListener, { once: true })
				socket?.once('close', invokeListener)
				sseResponse?.once('close', invokeListener)
			}
			return req
		}
		req.on = on
		rawRequest.on = on
	}

	private attachSseBridge(ctx: Context) {
		const sseCtx = ctx as HonoSseContext
		if (sseCtx.sseResponseReady) return sseCtx.sseResponseReady
		let resolveResponse: (response: Response) => void = () => undefined
		const responseReady = new Promise<Response>(resolve => {
			resolveResponse = resolve
		})
		sseCtx.sseResponseReady = responseReady

		const stream = new PassThrough() as HonoSseWritable
		sseCtx.getHeaders = () => getResponseHeaders(ctx)
		stream.getHeaders = () => getResponseHeaders(ctx)
		stream.setHeader = (name, value) => {
			setResponseHeader(ctx, name, value)
		}
		stream.flushHeaders = () => undefined
		stream.writeHead = (statusCode, reasonPhraseOrHeaders, headers) => {
			sseCtx.sseStarted = true
			const outgoingHeaders =
				typeof reasonPhraseOrHeaders === 'string'
					? headers
					: reasonPhraseOrHeaders

			stream.statusCode = statusCode
			ctx.status(statusCode as Parameters<Context['status']>[0])

			if (outgoingHeaders) {
				for (const [name, value] of Object.entries(outgoingHeaders)) {
					setResponseHeader(ctx, name, value)
				}
			}
			if (!ctx.finalized) {
				const response = ctx.body(
					Readable.toWeb(stream) as ReadableStream<Uint8Array>
				)
				resolveResponse(finalizeResponse(ctx, response))
			}

			return stream
		}
		sseCtx.raw = stream
		return responseReady
	}

	private registerRoute(
		method: HonoRouteMethod,
		pathOrHandler: string | RouteHandler,
		handler?: RouteHandler
	) {
		const [routePath, routeHandler] = this.getRouteAndHandler(
			pathOrHandler,
			handler
		)
		const wrappedHandler = this.createRouteHandler(
			routeHandler as RequestHandler,
			method === 'use',
			getOptionalParameterSuffixes(routePath)
		)

		if (method === 'use' && typeof pathOrHandler === 'function') {
			this.hono.use(wrappedHandler)
			return
		}

		const middlewareContexts = new WeakSet<Context>()
		const middlewareHandler: MiddlewareHandler = (ctx, next) => {
			if (middlewareContexts.has(ctx)) return next()
			middlewareContexts.add(ctx)
			return wrappedHandler(ctx, next)
		}

		for (const honoPath of new Set(normalizeHonoPaths(routePath))) {
			if (method === 'all') {
				this.hono.all(honoPath, wrappedHandler)
				continue
			}
			if (method === 'use') {
				this.hono.use(normalizeHonoMiddlewarePath(honoPath), middlewareHandler)
				continue
			}
			if (method === 'head') {
				this.headRoutePaths.add(honoPath)
				this.hono.on('GET', honoPath, (ctx, next) =>
					ctx.req.method === 'HEAD' ? wrappedHandler(ctx, next) : next()
				)
				continue
			}

			const handlerForMethod: MiddlewareHandler =
				method === 'get'
					? (ctx, next) =>
							ctx.req.method === 'HEAD' && this.headRoutePaths.has(honoPath)
								? next()
								: wrappedHandler(ctx, next)
					: wrappedHandler
			this.hono.on(method.toUpperCase(), honoPath, handlerForMethod)
		}
	}

	override all(pathOrHandler: string | RouteHandler, handler?: RouteHandler) {
		this.registerRoute('all', pathOrHandler, handler)
	}

	override get(pathOrHandler: string | RouteHandler, handler?: RouteHandler) {
		this.registerRoute('get', pathOrHandler, handler)
	}

	override post(pathOrHandler: string | RouteHandler, handler?: RouteHandler) {
		this.registerRoute('post', pathOrHandler, handler)
	}

	override put(pathOrHandler: string | RouteHandler, handler?: RouteHandler) {
		this.registerRoute('put', pathOrHandler, handler)
	}

	override delete(
		pathOrHandler: string | RouteHandler,
		handler?: RouteHandler
	) {
		this.registerRoute('delete', pathOrHandler, handler)
	}

	override use(pathOrHandler: string | RouteHandler, handler?: RouteHandler) {
		this.registerRoute('use', pathOrHandler, handler)
	}

	override patch(pathOrHandler: string | RouteHandler, handler?: RouteHandler) {
		this.registerRoute('patch', pathOrHandler, handler)
	}

	override options(
		pathOrHandler: string | RouteHandler,
		handler?: RouteHandler
	) {
		this.registerRoute('options', pathOrHandler, handler)
	}

	override head(pathOrHandler: string | RouteHandler, handler?: RouteHandler) {
		this.registerRoute('head', pathOrHandler, handler)
	}

	override search(
		pathOrHandler: string | RouteHandler,
		handler?: RouteHandler
	) {
		this.registerRoute('search', pathOrHandler, handler)
	}

	override propfind(
		pathOrHandler: string | RouteHandler,
		handler?: RouteHandler
	) {
		this.registerRoute('propfind', pathOrHandler, handler)
	}

	override proppatch(
		pathOrHandler: string | RouteHandler,
		handler?: RouteHandler
	) {
		this.registerRoute('proppatch', pathOrHandler, handler)
	}

	override mkcol(pathOrHandler: string | RouteHandler, handler?: RouteHandler) {
		this.registerRoute('mkcol', pathOrHandler, handler)
	}

	override copy(pathOrHandler: string | RouteHandler, handler?: RouteHandler) {
		this.registerRoute('copy', pathOrHandler, handler)
	}

	override move(pathOrHandler: string | RouteHandler, handler?: RouteHandler) {
		this.registerRoute('move', pathOrHandler, handler)
	}

	override lock(pathOrHandler: string | RouteHandler, handler?: RouteHandler) {
		this.registerRoute('lock', pathOrHandler, handler)
	}

	override unlock(
		pathOrHandler: string | RouteHandler,
		handler?: RouteHandler
	) {
		this.registerRoute('unlock', pathOrHandler, handler)
	}

	reply(ctx: Context, body: unknown, statusCode?: number) {
		if (statusCode) ctx.status(statusCode as Parameters<Context['status']>[0])

		if (body instanceof Response) {
			getFinalizedResponse(ctx, body)
			return
		}

		const responseContentType = this.getHeader(ctx, 'Content-Type')
		const bodyRecord = body as Record<string, unknown> | undefined

		if (
			!isJsonContentType(responseContentType) &&
			bodyRecord?.statusCode &&
			(bodyRecord.statusCode as number) >= HttpStatus.BAD_REQUEST
		) {
			this.logger.warn(
				"Content-Type doesn't match Reply body, you might need a custom ExceptionFilter for non-JSON responses"
			)
			this.setHeader(ctx, 'Content-Type', 'application/json')
		}

		getFinalizedResponse(ctx, body)
	}

	status(ctx: Context, statusCode: number) {
		ctx.status(statusCode as Parameters<Context['status']>[0])
		const sseResponse = (ctx as HonoSseContext).raw
		if (sseResponse) sseResponse.statusCode = statusCode
	}

	end() {
		return RESPONSE_ALREADY_SENT
	}

	render() {
		throw new Error('Method not implemented.')
	}

	async redirect(ctx: Context, statusCode: number, url: string) {
		const normalizedCtx = await normalizeContext(ctx)
		finalizeResponse(
			normalizedCtx,
			normalizedCtx.redirect(
				url,
				statusCode as Parameters<Context['redirect']>[1]
			)
		)
	}

	setErrorHandler(
		handler: (err: Error, req: Request, res: Context) => void | Promise<void>
	) {
		this.hono.onError(async (err, ctx) => {
			await handler(err, ctx.req as unknown as Request, ctx)
			return getFinalizedResponse(ctx)
		})
	}

	setNotFoundHandler(
		handler: (req: Request, res: Context) => void | Promise<void>
	) {
		this.hono.notFound(async ctx => {
			await handler(ctx.req as unknown as Request, ctx)
			if (!ctx.finalized) {
				this.status(ctx, HttpStatus.NOT_FOUND)
				return getFinalizedResponse(ctx, 'Not Found')
			}
			return getFinalizedResponse(ctx)
		})
	}

	useStaticAssets(rootPath: string, options: StaticAssetsOptions = {}) {
		this.logger.log('Registering static assets middleware')
		const { prefix, ...staticOptions } = options
		if (staticOptions.root !== undefined) {
			this.hono.use(rootPath, createStaticMiddleware(staticOptions))
			return
		}

		const staticPrefix = normalizeStaticPrefix(prefix ?? '')
		const rewriteRequestPath = staticOptions.rewriteRequestPath
		const middleware = createStaticMiddleware({
			...staticOptions,
			rewriteRequestPath: (requestPath, ctx) => {
				const pathWithoutPrefix = staticPrefix
					? requestPath.slice(staticPrefix.length) || '/'
					: requestPath
				return rewriteRequestPath
					? rewriteRequestPath(pathWithoutPrefix, ctx)
					: pathWithoutPrefix
			},
			root: rootPath,
		})

		if (staticPrefix) this.hono.use(`${staticPrefix}/*`, middleware)
		else this.hono.use(middleware)
	}

	setViewEngine() {
		throw new Error('Method not implemented.')
	}

	isHeadersSent(ctx: Context) {
		return ctx.finalized
	}

	getHeader(ctx: Context, name: string) {
		return ctx.res.headers.get(name)
	}

	setHeader(ctx: Context, name: string, value: string) {
		ctx.res.headers.set(name, value)
	}

	appendHeader(ctx: Context, name: string, value: string) {
		ctx.res.headers.append(name, value)
	}

	getRequestHostname(requestOrContext: Context['req'] | Context) {
		const request =
			'req' in requestOrContext ? requestOrContext.req : requestOrContext
		const host = request.header('host')
		return host
			? new URL(`http://${host}`).hostname
			: new URL(request.url).hostname
	}

	getRequestMethod(request: Context['req']) {
		return request.method
	}

	getRequestUrl(request: Context['req']) {
		const url = new URL(request.url)
		return `${url.pathname}${url.search}`
	}

	enableCors(options: NestCorsOptions = {}) {
		this.hono.use(async (ctx, next) => {
			const resolvedOptions =
				typeof options === 'function'
					? await resolveCorsOptions(options, ctx.req)
					: options
			const corsMiddleware = cors(normalizeCorsOptions(resolvedOptions))

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
		})
	}

	useBodyParser(
		type: string,
		rawBody: boolean,
		options?: number | { limit?: number | string }
	) {
		const configuredLimit = parseBodyLimit(
			typeof options === 'number' ? options : options?.limit
		)
		this.logger.log(
			`Registering body parser middleware for type: ${type}${configuredLimit === undefined ? '' : ` | bodyLimit: ${configuredLimit}`}`
		)
		const parse = async (ctx: Context, next: () => Promise<void>) => {
			const pathname = new URL(ctx.req.url).pathname
			const shouldSkip = (this.adapterOptions.skipBodyParserFor ?? []).some(
				path => isPathMatch(pathname, path)
			)
			if (!shouldSkip) await parseRequestBody(ctx, rawBody, type)
			this.normalizeRequestMetadata(ctx)
			await next()
		}
		const bodyLimit =
			configuredLimit === undefined
				? undefined
				: createBodyLimit(configuredLimit, type)
		this.hono.use(
			bodyLimit ? (ctx, next) => bodyLimit(ctx, () => parse(ctx, next)) : parse
		)
		this._isParserRegistered = true
	}

	close(): Promise<void> {
		return new Promise(resolve => {
			this.httpServer.close(() => resolve())
			this.httpServer.closeIdleConnections?.()
			if (this.forceCloseConnections) this.httpServer.closeAllConnections?.()
		})
	}

	private normalizeRequestMetadata(
		ctx: Context,
		optionalParameterSuffixes: OptionalParameterSuffix[] = []
	) {
		const req = getNestHonoRequest(ctx.req)
		this.attachRequestBridge(ctx)
		const clientIp = extractClientIp(ctx, this.adapterOptions)
		if (!req.ip && clientIp) req.ip = clientIp
		if (!req.headers) req.headers = Object.fromEntries(ctx.req.raw.headers)
		const params = ctx.req.param()
		for (const { name, suffix } of optionalParameterSuffixes
			.slice()
			.reverse()) {
			const value = params[name]
			if (value && value.length > suffix.length && value.endsWith(suffix))
				params[name] = value.slice(0, -suffix.length)
		}
		req.params = params
		if (typeof req.query === 'function' || !req.query) {
			const queries = ctx.req.queries()
			req.query = Object.fromEntries(
				Object.entries(ctx.req.query()).map(([key, value]) => {
					const queryValues = queries[key]
					return [
						key,
						queryValues && queryValues.length > 1 ? queryValues : value,
					]
				})
			)
		}

		const pathname = new URL(ctx.req.url).pathname
		req.baseUrl = pathname

		return pathname
	}

	initHttpServer(options: NestApplicationOptions) {
		this.forceCloseConnections = options.forceCloseConnections ?? false

		this.hono.use(async (ctx, next) => {
			const pathname = this.normalizeRequestMetadata(ctx)
			const requestSizeLimit = getRequestSizeLimit(
				pathname,
				this.adapterOptions.requestSizeLimits
			)

			await enforceRequestBodyLimit(ctx, this.adapterOptions, requestSizeLimit)

			this.normalizeRequestMetadata(ctx)
			await next()
		})
		if (options.bodyParser !== false)
			this.registerParserMiddleware(undefined, options.rawBody)

		this.httpServer = (
			options.httpsOptions
				? createAdaptorServer({
						fetch: this.hono.fetch,
						createServer: createHttpsServer,
						overrideGlobalObjects: false,
						serverOptions: options.httpsOptions,
					})
				: createAdaptorServer({
						fetch: this.hono.fetch,
						createServer: createHttpServer,
						overrideGlobalObjects: false,
					})
		) as HttpServer | HttpsServer
	}

	getType() {
		return 'hono'
	}

	registerParserMiddleware(_prefix?: string, rawBody?: boolean) {
		if (this._isParserRegistered) return
		this.logger.log('Registering parser middleware')
		this.useBodyParser('urlencoded', rawBody ?? false)
		this.useBodyParser('json', rawBody ?? false)
		this.useBodyParser('text', rawBody ?? false)
		this.useBodyParser('multipart/form-data', rawBody ?? false)
		this._isParserRegistered = true
	}

	createMiddlewareFactory(requestMethod: RequestMethod) {
		return Promise.resolve((path: string, callback: Function) => {
			const isAllMethods =
				requestMethod === RequestMethod.ALL || (requestMethod as number) === -1
			const method = RequestMethod[requestMethod]
			const optionalParameterSuffixes = getOptionalParameterSuffixes(path)
			if (!(method || isAllMethods))
				throw new Error(`Unsupported request method: ${requestMethod}`)

			const middleware: MiddlewareHandler = async (ctx, next) => {
				this.normalizeRequestMetadata(ctx, optionalParameterSuffixes)
				const response = await this.invokeHandler(callback, ctx, next, true)
				if (response instanceof Response) return response
			}

			for (const honoPath of new Set(normalizeHonoPaths(path))) {
				if (isAllMethods) {
					this.hono.all(honoPath, middleware)
					continue
				}
				if (requestMethod === RequestMethod.HEAD) {
					this.hono.on('GET', honoPath, (ctx, next) =>
						ctx.req.method === 'HEAD' ? middleware(ctx, next) : next()
					)
					continue
				}
				this.hono.on(method, honoPath, middleware)
			}
		})
	}

	applyVersionFilter(
		_handler: (...args: never) => unknown,
		_version: VersionValue,
		_versioningOptions: VersioningOptions
	): (
		req: Context['req'],
		res: Context,
		next: () => void
	) => (...args: never) => unknown {
		throw new Error('Versioning not yet supported in Hono')
	}

	override listen(port: number, ...args: unknown[]): HttpServer | HttpsServer {
		return this.httpServer.listen(port, ...(args as []))
	}
}
