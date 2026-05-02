import {
	createServer as createHttpServer,
	type Server as HttpServer,
} from 'node:http'
import {
	createServer as createHttpsServer,
	type Server as HttpsServer,
} from 'node:https'
import { createAdaptorServer } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response'
import {
	HttpStatus,
	Logger,
	PayloadTooLargeException,
	RequestMethod,
	type VersioningOptions,
} from '@nestjs/common'
import type {
	NestApplicationOptions,
	RequestHandler,
	VersionValue,
} from '@nestjs/common/interfaces'
import { AbstractHttpAdapter } from '@nestjs/core/adapters/http-adapter'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'

type RouteHandler = (req: Request, res: Context) => void | Promise<void>

export interface HonoAdapterOptions {
	requestSizeLimits?: {
		path: string
		maxBytes: number
		errorMessage?: string
	}[]
	skipBodyParserFor?: string[]
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
			const req = ctx.req as unknown as Record<string, unknown>
			req.params = ctx.req.param()
			if (typeof req.query === 'function') req.query = req.query()
			if (!req.query) req.query = ctx.req.query()
			if (!req.headers) req.headers = Object.fromEntries(ctx.req.raw.headers)
			if (!req.ip) req.ip = this.extractClientIp(ctx)
			await routeHandler(ctx.req, ctx, next)
			return this.getBody(ctx)
		}
	}

	private async normalizeContext(ctx: Context | (() => Promise<Context>)) {
		if (typeof ctx === 'function') return await ctx()
		return ctx
	}

	private async getBody(ctx: Context, body?: unknown) {
		const normalizedCtx = await this.normalizeContext(ctx)

		if (
			body === undefined &&
			normalizedCtx.res &&
			normalizedCtx.res.body !== null
		) {
			return normalizedCtx.res
		}

		let responseContentType = await this.getHeader(
			normalizedCtx,
			'Content-Type'
		)

		if (!responseContentType || responseContentType.startsWith('text/plain')) {
			if (body instanceof Buffer) {
				responseContentType = 'application/octet-stream'
			} else if (typeof body === 'object') {
				responseContentType = 'application/json'
			}
			if (responseContentType)
				this.setHeader(normalizedCtx, 'Content-Type', responseContentType)
		}

		if (
			responseContentType === 'application/json' &&
			typeof body === 'object'
		) {
			return normalizedCtx.json(body as object)
		}
		if (body === undefined) return normalizedCtx.newResponse(null)
		return normalizedCtx.body(body as string)
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
		const wrappedHandler = this.createRouteHandler(
			routeHandler as RequestHandler
		)

		switch (method) {
			case 'all':
				this.hono.all(routePath, wrappedHandler)
				break
			case 'get':
				this.hono.get(routePath, wrappedHandler)
				break
			case 'post':
				this.hono.post(routePath, wrappedHandler)
				break
			case 'put':
				this.hono.put(routePath, wrappedHandler)
				break
			case 'delete':
				this.hono.delete(routePath, wrappedHandler)
				break
			case 'use':
				this.hono.use(routePath, wrappedHandler)
				break
			case 'patch':
				this.hono.patch(routePath, wrappedHandler)
				break
			case 'options':
				this.hono.options(routePath, wrappedHandler)
				break
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

	async reply(ctx: Context, body: unknown, statusCode?: number) {
		const normalizedCtx = await this.normalizeContext(ctx)

		if (statusCode)
			normalizedCtx.status(statusCode as Parameters<Context['status']>[0])

		const responseContentType = await this.getHeader(
			normalizedCtx,
			'Content-Type'
		)
		const bodyRecord = body as Record<string, unknown> | undefined

		if (
			!responseContentType?.startsWith('application/json') &&
			bodyRecord?.statusCode &&
			(bodyRecord.statusCode as number) >= HttpStatus.BAD_REQUEST
		) {
			this.logger.warn(
				"Content-Type doesn't match Reply body, you might need a custom ExceptionFilter for non-JSON responses"
			)
			this.setHeader(normalizedCtx, 'Content-Type', 'application/json')
		}

		normalizedCtx.res = await this.getBody(normalizedCtx, body)
	}

	async status(ctx: Context, statusCode: number) {
		const normalizedCtx = await this.normalizeContext(ctx)
		normalizedCtx.status(statusCode as Parameters<Context['status']>[0])
	}

	end() {
		return RESPONSE_ALREADY_SENT
	}

	render() {
		throw new Error('Method not implemented.')
	}

	async redirect(ctx: Context, statusCode: number, url: string) {
		const normalizedCtx = await this.normalizeContext(ctx)
		normalizedCtx.res = normalizedCtx.redirect(
			url,
			statusCode as Parameters<Context['redirect']>[1]
		)
	}

	setErrorHandler(
		handler: (err: Error, req: Request, res: Context) => void | Promise<void>
	) {
		this.hono.onError(async (err, ctx) => {
			await handler(err, ctx.req as unknown as Request, ctx)
			return this.getBody(ctx)
		})
	}

	setNotFoundHandler(
		handler: (req: Request, res: Context) => void | Promise<void>
	) {
		this.hono.notFound(async ctx => {
			await handler(ctx.req as unknown as Request, ctx)
			await this.status(ctx, HttpStatus.NOT_FOUND)
			return this.getBody(ctx, 'Not Found')
		})
	}

	useStaticAssets(path: string, options: Parameters<typeof serveStatic>[0]) {
		this.logger.log('Registering static assets middleware')
		this.hono.use(path, serveStatic(options))
	}

	setViewEngine() {
		throw new Error('Method not implemented.')
	}

	async isHeadersSent(ctx: Context) {
		const normalizedCtx = await this.normalizeContext(ctx)
		return normalizedCtx.finalized
	}

	async getHeader(ctx: Context, name: string) {
		const normalizedCtx = await this.normalizeContext(ctx)
		return normalizedCtx.res.headers.get(name)
	}

	async setHeader(ctx: Context, name: string, value: string) {
		const normalizedCtx = await this.normalizeContext(ctx)
		normalizedCtx.res.headers.set(name, value)
	}

	async appendHeader(ctx: Context, name: string, value: string) {
		const normalizedCtx = await this.normalizeContext(ctx)
		normalizedCtx.res.headers.append(name, value)
	}

	async getRequestHostname(ctx: Context) {
		const normalizedCtx = await this.normalizeContext(ctx)
		return normalizedCtx.req.header().host
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

	useBodyParser(type: string, _rawBody: boolean, limit?: number) {
		this.logger.log(
			`Registering body parser middleware for type: ${type}${limit ? ` | bodyLimit: ${limit}` : ''}`
		)
		if (limit) this.hono.use(this.createBodyLimit(limit))
		this._isParserRegistered = true
	}

	close(): Promise<void> {
		return new Promise(resolve => this.httpServer.close(() => resolve()))
	}

	private extractClientIp(ctx: Context) {
		return (
			ctx.req.header('cf-connecting-ip') ??
			ctx.req.header('x-forwarded-for') ??
			ctx.req.header('x-real-ip') ??
			ctx.req.header('forwarded') ??
			ctx.req.header('true-client-ip') ??
			ctx.req.header('x-client-ip') ??
			ctx.req.header('x-cluster-client-ip') ??
			ctx.req.header('x-forwarded') ??
			ctx.req.header('forwarded-for') ??
			ctx.req.header('via')
		)
	}

	private async parseRequestBody(
		ctx: Context,
		contentType: string | undefined,
		rawBody: boolean,
		requestSizeLimit?: { maxBytes: number; errorMessage?: string }
	) {
		const req = ctx.req as unknown as Record<string, unknown>

		if (
			contentType?.startsWith('multipart/form-data') ||
			contentType?.startsWith('application/x-www-form-urlencoded')
		) {
			req.body = await ctx.req.parseBody({ all: true }).catch(() => {
				if (requestSizeLimit)
					throw new PayloadTooLargeException(
						requestSizeLimit.errorMessage ?? 'Payload too large'
					)
				return {}
			})
		} else if (
			contentType?.startsWith('application/json') ||
			contentType?.startsWith('text/plain')
		) {
			if (rawBody) req.rawBody = Buffer.from(await ctx.req.text())
			req.body = await ctx.req.json().catch(() => {
				if (requestSizeLimit)
					throw new PayloadTooLargeException(
						requestSizeLimit.errorMessage ?? 'Payload too large'
					)
				return {}
			})
		}
	}

	private getRequestSizeLimit(pathname: string) {
		const requestSizeLimits = this.adapterOptions.requestSizeLimits ?? []

		return requestSizeLimits.find(requestSizeLimit =>
			pathname.startsWith(requestSizeLimit.path)
		)
	}

	private getParsedBodySize(value: unknown): number {
		if (typeof value === 'string') return new TextEncoder().encode(value).length
		if (value instanceof Blob) return value.size
		if (Array.isArray(value))
			return value.reduce(
				(totalSize, itemValue) => totalSize + this.getParsedBodySize(itemValue),
				0
			)
		if (value && typeof value === 'object')
			return Object.values(value).reduce(
				(totalSize, itemValue) => totalSize + this.getParsedBodySize(itemValue),
				0
			)
		return 0
	}

	initHttpServer(options: NestApplicationOptions) {
		const skipPaths = this.adapterOptions.skipBodyParserFor ?? []

		this.hono.use(async (ctx, next) => {
			const req = ctx.req as unknown as Record<string, unknown>
			req.ip = this.extractClientIp(ctx)
			req.headers = Object.fromEntries(ctx.req.raw.headers)

			const url = new URL(ctx.req.url)
			const pathname = url.pathname
			req.baseUrl = pathname
			const shouldSkip = skipPaths.some(p => pathname.startsWith(p))
			const requestSizeLimit = this.getRequestSizeLimit(pathname)
			const contentLengthHeader = ctx.req.header('content-length')

			if (requestSizeLimit && contentLengthHeader) {
				const contentLength = Number.parseInt(contentLengthHeader, 10)

				if (
					Number.isFinite(contentLength) &&
					contentLength > requestSizeLimit.maxBytes
				)
					throw new PayloadTooLargeException(
						requestSizeLimit.errorMessage ?? 'Payload too large'
					)
			}

			if (options.bodyParser !== false && !shouldSkip) {
				const contentType = ctx.req.header('content-type')
				await this.parseRequestBody(
					ctx,
					contentType,
					options.rawBody ?? false,
					requestSizeLimit
				)

				if (requestSizeLimit) {
					const parsedBodySize = this.getParsedBodySize(req.body)
					if (parsedBodySize > requestSizeLimit.maxBytes)
						throw new PayloadTooLargeException(
							requestSizeLimit.errorMessage ?? 'Payload too large'
						)
				}
			}

			await next()
		})

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
		this.useBodyParser('application/x-www-form-urlencoded', rawBody ?? false)
		this.useBodyParser('application/json', rawBody ?? false)
		this.useBodyParser('text/plain', rawBody ?? false)
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
			routeMethod(path, async (ctx: Context, next: () => Promise<void>) => {
				await callback(ctx.req, ctx, next)
			})
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

	private createBodyLimit(maxSize: number) {
		return bodyLimit({
			maxSize,
			onError: ctx => {
				const errorMessage = `Body size exceeded: ${maxSize} bytes. Size: ${ctx.req.header('Content-Length')} bytes. Method: ${ctx.req.method}. Path: ${ctx.req.path}`
				throw new Error(errorMessage)
			},
		})
	}
}
