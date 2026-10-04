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
import { serveStatic } from '@hono/node-server/serve-static'
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response'
import {
	HttpStatus,
	Logger,
	type NestApplicationOptions,
	RequestMethod,
	type VersioningOptions,
} from '@nestjs/common'
import type { RequestHandler } from '@nestjs/common/interfaces'
import { AbstractHttpAdapter } from '@nestjs/core'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import {
	createBodyLimit,
	enforceRequestBodyLimit,
	parseRequestBody,
} from './helpers/body-parser'
import { extractClientIp } from './helpers/client-ip'
import { getRequestSizeLimit, isPathMatch } from './helpers/path-matching'
import { getNestHonoRequest } from './helpers/request'
import {
	finalizeResponse,
	getFinalizedResponse,
	isJsonContentType,
} from './helpers/response'
import type { HonoAdapterOptions } from './options'

type RouteHandler = (
	req: Context['req'],
	res: Context
) => Response | undefined | Promise<Response | undefined>

type VersionValue = Parameters<AbstractHttpAdapter['applyVersionFilter']>[1]

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

function parseBodyLimit(limit: number | string | undefined) {
	if (typeof limit === 'number') return limit
	const match = limit?.match(BODY_LIMIT_REGEX)
	if (!match) return
	const multipliers = { b: 1, gb: 1024 ** 3, kb: 1024, mb: 1024 ** 2 }
	const unit = (match[2]?.toLowerCase() ?? 'b') as keyof typeof multipliers
	return Math.floor(Number(match[1]) * multipliers[unit])
}

function normalizeHonoPath(path: string) {
	return path.replace(/\/\*([A-Za-z_$][\w$]*)/g, '/:$1{.*}')
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

export class HonoAdapter extends AbstractHttpAdapter<
	HttpServer | HttpsServer,
	Context['req'],
	Context
> {
	private _isParserRegistered = false
	private readonly adapterOptions: HonoAdapterOptions
	private readonly logger = new Logger('HonoAdapter')

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

	private createRouteHandler(routeHandler: RequestHandler): MiddlewareHandler {
		return async (ctx, next) => {
			const sseResponse = this.attachSseBridge(ctx)
			this.attachRequestBridge(ctx)
			const req = getNestHonoRequest(ctx.req)
			req.params = ctx.req.param()
			if (typeof req.query === 'function') req.query = req.query()
			if (!req.query) req.query = ctx.req.query()
			if (!req.headers) req.headers = Object.fromEntries(ctx.req.raw.headers)
			const clientIp = extractClientIp(ctx, this.adapterOptions)
			if (!req.ip && clientIp) req.ip = clientIp
			const handlerPromise = Promise.resolve(routeHandler(ctx.req, ctx, next))
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
		method:
			| 'all'
			| 'get'
			| 'post'
			| 'put'
			| 'delete'
			| 'use'
			| 'patch'
			| 'options',
		pathOrHandler: string | RouteHandler,
		handler?: RouteHandler
	) {
		const [routePath, routeHandler] = this.getRouteAndHandler(
			pathOrHandler,
			handler
		)
		const honoPath = normalizeHonoPath(routePath)
		const wrappedHandler = this.createRouteHandler(
			routeHandler as RequestHandler
		)

		switch (method) {
			case 'all':
				this.hono.all(honoPath, wrappedHandler)
				break
			case 'get':
				this.hono.get(honoPath, wrappedHandler)
				break
			case 'post':
				this.hono.post(honoPath, wrappedHandler)
				break
			case 'put':
				this.hono.put(honoPath, wrappedHandler)
				break
			case 'delete':
				this.hono.delete(honoPath, wrappedHandler)
				break
			case 'use':
				this.hono.use(honoPath, wrappedHandler)
				break
			case 'patch':
				this.hono.patch(honoPath, wrappedHandler)
				break
			case 'options':
				this.hono.options(honoPath, wrappedHandler)
				break
			/* v8 ignore next -- method is constrained by the private union type. */
			default:
				break
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

	redirect(ctx: Context, statusCode: number, url: string) {
		finalizeResponse(
			ctx,
			ctx.redirect(url, statusCode as Parameters<Context['redirect']>[1])
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
			await this.status(ctx, HttpStatus.NOT_FOUND)
			return getFinalizedResponse(ctx, 'Not Found')
		})
	}

	useStaticAssets(path: string, options: Parameters<typeof serveStatic>[0]) {
		this.logger.log('Registering static assets middleware')
		this.hono.use(path, serveStatic(options))
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

	getRequestHostname(ctx: Context) {
		return ctx.req.header().host
	}

	getRequestMethod(request: Context['req']) {
		return request.method
	}

	getRequestUrl(request: Context['req']) {
		return request.url
	}

	enableCors(options: Parameters<typeof cors>[0]) {
		this.hono.use(cors(options))
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
			this.httpServer.closeAllConnections?.()
		})
	}

	private normalizeRequestMetadata(ctx: Context) {
		const req = getNestHonoRequest(ctx.req)
		const clientIp = extractClientIp(ctx, this.adapterOptions)
		if (!req.ip && clientIp) req.ip = clientIp
		req.headers = Object.fromEntries(ctx.req.raw.headers)

		const pathname = new URL(ctx.req.url).pathname
		req.baseUrl = pathname

		return pathname
	}

	initHttpServer(options: NestApplicationOptions) {
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

		const isHttpsEnabled = !!options?.httpsOptions
		const createServer = isHttpsEnabled ? createHttpsServer : createHttpServer

		this.httpServer = createAdaptorServer({
			fetch: this.hono.fetch,
			createServer,
			overrideGlobalObjects: false,
		}) as HttpServer | HttpsServer
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
			const routeMethodsMap: Partial<
				Record<RequestMethod, typeof this.hono.get>
			> = {
				[RequestMethod.ALL]: this.hono.all,
				[RequestMethod.DELETE]: this.hono.delete,
				[RequestMethod.GET]: this.hono.get,
				[RequestMethod.OPTIONS]: this.hono.options,
				[RequestMethod.PATCH]: this.hono.patch,
				[RequestMethod.POST]: this.hono.post,
				[RequestMethod.PUT]: this.hono.put,
				[RequestMethod.HEAD]: this.hono.get,
				[RequestMethod.SEARCH]: this.hono.get,
			}

			const routeMethod = (
				routeMethodsMap[requestMethod] || this.hono.get
			).bind(this.hono)
			routeMethod(
				normalizeHonoPath(path),
				async (ctx: Context, next: () => Promise<void>) => {
					const req = getNestHonoRequest(ctx.req)
					req.params = ctx.req.param()
					await callback(ctx.req, ctx, next)
				}
			)
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
