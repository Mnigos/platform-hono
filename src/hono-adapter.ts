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
	RequestMethod,
	type VersioningOptions,
} from '@nestjs/common'
import type {
	NestApplicationOptions,
	RequestHandler,
	VersionValue,
} from '@nestjs/common/interfaces'
import { AbstractHttpAdapter } from '@nestjs/core'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import {
	createBodyLimit,
	parseRequestBodyWithLimits,
} from './helpers/body-parser'
import { extractClientIp } from './helpers/client-ip'
import { getRequestSizeLimit, isPathMatch } from './helpers/path-matching'
import { getNestHonoRequest } from './helpers/request'
import {
	finalizeResponse,
	getFinalizedResponse,
	normalizeContext,
} from './helpers/response'
import type { HonoAdapterOptions } from './options'

type RouteHandler = (
	req: Context['req'],
	res: Context
) => Response | undefined | Promise<Response | undefined>

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
			const req = getNestHonoRequest(ctx.req)
			req.params = ctx.req.param()
			if (typeof req.query === 'function') req.query = req.query()
			if (!req.query) req.query = ctx.req.query()
			if (!req.headers) req.headers = Object.fromEntries(ctx.req.raw.headers)
			const clientIp = extractClientIp(ctx, this.adapterOptions)
			if (!req.ip && clientIp) req.ip = clientIp
			const response = await routeHandler(ctx.req, ctx, next)
			return getFinalizedResponse(
				ctx,
				response instanceof Response ? response : undefined
			)
		}
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
			!responseContentType?.startsWith('application/json') &&
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

	useBodyParser(type: string, _rawBody: boolean, limit?: number) {
		this.logger.log(
			`Registering body parser middleware for type: ${type}${limit ? ` | bodyLimit: ${limit}` : ''}`
		)
		if (limit) this.hono.use(createBodyLimit(limit))
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
		if (clientIp) req.ip = clientIp
		req.headers = Object.fromEntries(ctx.req.raw.headers)

		const pathname = new URL(ctx.req.url).pathname
		req.baseUrl = pathname

		return pathname
	}

	initHttpServer(options: NestApplicationOptions) {
		const skipPaths = this.adapterOptions.skipBodyParserFor ?? []

		this.hono.use(async (ctx, next) => {
			const pathname = this.normalizeRequestMetadata(ctx)
			const shouldSkip = skipPaths.some(path => isPathMatch(pathname, path))
			const requestSizeLimit = getRequestSizeLimit(
				pathname,
				this.adapterOptions.requestSizeLimits
			)

			if (options.bodyParser !== false && !shouldSkip) {
				await parseRequestBodyWithLimits(
					ctx,
					this.adapterOptions,
					options.rawBody ?? false,
					requestSizeLimit
				)
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
}
