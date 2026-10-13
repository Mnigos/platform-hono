import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response'
import {
	HttpStatus,
	Logger,
	type NestApplicationOptions,
	type RequestMethod,
	type VersioningOptions,
} from '@nestjs/common'
import { AbstractHttpAdapter } from '@nestjs/core'
import { type Context, Hono } from 'hono'
import {
	createBodyLimit,
	enforceRequestBodyLimit,
	parseBodyLimit,
} from './helpers/body-parser'
import { createCorsMiddleware, type NestCorsOptions } from './helpers/cors'
import { getRequestSizeLimit } from './helpers/path-matching'
import {
	finalizeResponse,
	getFinalizedResponse,
	isJsonContentType,
	markResponseHeadersSet,
} from './helpers/response'
import {
	registerStaticAssets,
	type StaticAssetsOptions,
} from './helpers/static-assets'
import type { HonoAdapterOptions } from './options'
import { createParserMiddleware } from './request/body-parser-middleware'
import {
	getRequestState,
	mayHaveRequestBody,
	syncRawRequest,
} from './request/request-state'
import { type RouteArguments, RouteRegistry } from './routing/route-registry'
import { createServer, type HonoHttpServer } from './server/create-server'

type VersionValue = Parameters<AbstractHttpAdapter['applyVersionFilter']>[1]

const DEFAULT_PARSER_TYPES = [
	'urlencoded',
	'json',
	'text',
	'multipart/form-data',
] as const

export class HonoAdapter extends AbstractHttpAdapter<
	HonoHttpServer,
	Context['req'],
	Context
> {
	private readonly registeredParserTypes = new Set<string>()
	private batchedParserTypes?: string[]
	private readonly adapterOptions: HonoAdapterOptions
	private readonly logger = new Logger('HonoAdapter')
	private forceCloseConnections = false
	private readonly routes: RouteRegistry

	constructor(options: HonoAdapterOptions = {}) {
		super(new Hono())
		this.adapterOptions = options
		this.routes = new RouteRegistry(this.hono, options)
	}

	get hono() {
		return this.instance as Hono
	}

	get isParserRegistered() {
		return this.registeredParserTypes.size > 0
	}

	override all(...args: RouteArguments) {
		this.routes.register('all', ...args)
	}

	override get(...args: RouteArguments) {
		this.routes.register('get', ...args)
	}

	override post(...args: RouteArguments) {
		this.routes.register('post', ...args)
	}

	override put(...args: RouteArguments) {
		this.routes.register('put', ...args)
	}

	override delete(...args: RouteArguments) {
		this.routes.register('delete', ...args)
	}

	override use(...args: RouteArguments) {
		this.routes.register('use', ...args)
	}

	override patch(...args: RouteArguments) {
		this.routes.register('patch', ...args)
	}

	override options(...args: RouteArguments) {
		this.routes.register('options', ...args)
	}

	override head(...args: RouteArguments) {
		this.routes.register('head', ...args)
	}

	override search(...args: RouteArguments) {
		this.routes.register('search', ...args)
	}

	override propfind(...args: RouteArguments) {
		this.routes.register('propfind', ...args)
	}

	override proppatch(...args: RouteArguments) {
		this.routes.register('proppatch', ...args)
	}

	override mkcol(...args: RouteArguments) {
		this.routes.register('mkcol', ...args)
	}

	override copy(...args: RouteArguments) {
		this.routes.register('copy', ...args)
	}

	override move(...args: RouteArguments) {
		this.routes.register('move', ...args)
	}

	override lock(...args: RouteArguments) {
		this.routes.register('lock', ...args)
	}

	override unlock(...args: RouteArguments) {
		this.routes.register('unlock', ...args)
	}

	reply(ctx: Context, body: unknown, statusCode?: number) {
		if (statusCode) ctx.status(statusCode as Parameters<Context['status']>[0])

		if (body instanceof Response) {
			getFinalizedResponse(ctx, body)
			return
		}

		const bodyRecord = body as Record<string, unknown> | undefined

		if (
			bodyRecord?.statusCode &&
			(bodyRecord.statusCode as number) >= HttpStatus.BAD_REQUEST &&
			!isJsonContentType(this.getHeader(ctx, 'Content-Type'))
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
		const state = getRequestState(ctx, this.adapterOptions)
		state.statusCode = statusCode
		if (state.sse) state.sse.stream.statusCode = statusCode
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
			if (!ctx.finalized) {
				this.status(ctx, HttpStatus.NOT_FOUND)
				return getFinalizedResponse(ctx, 'Not Found')
			}
			return getFinalizedResponse(ctx)
		})
	}

	useStaticAssets(rootPath: string, options: StaticAssetsOptions = {}) {
		this.logger.log('Registering static assets middleware')
		registerStaticAssets(this.hono, rootPath, options)
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
		markResponseHeadersSet(ctx)
		ctx.res.headers.set(name, value)
	}

	appendHeader(ctx: Context, name: string, value: string) {
		markResponseHeadersSet(ctx)
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
		this.hono.use(createCorsMiddleware(options))
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
		this.registeredParserTypes.add(type)
		if (configuredLimit === undefined && this.batchedParserTypes) {
			this.batchedParserTypes.push(type)
			return
		}
		const parse = createParserMiddleware({
			adapterOptions: this.adapterOptions,
			parserTypes: [type],
			rawBody,
		})
		const bodyLimit =
			configuredLimit === undefined
				? undefined
				: createBodyLimit(configuredLimit, type)
		this.hono.use(
			bodyLimit ? (ctx, next) => bodyLimit(ctx, () => parse(ctx, next)) : parse
		)
	}

	close(): Promise<void> {
		return new Promise(resolve => {
			this.httpServer.close(() => resolve())
			if ('closeIdleConnections' in this.httpServer)
				this.httpServer.closeIdleConnections()
			if (this.forceCloseConnections) this.httpServer.closeAllConnections?.()
		})
	}

	initHttpServer(options: NestApplicationOptions) {
		this.forceCloseConnections = options.forceCloseConnections ?? false

		this.hono.use((ctx, next) => {
			const state = getRequestState(ctx, this.adapterOptions)
			if (!mayHaveRequestBody(state)) return next()
			const requestSizeLimit = getRequestSizeLimit(
				state.pathname,
				this.adapterOptions.requestSizeLimits
			)
			const pendingLimit = enforceRequestBodyLimit(
				ctx,
				this.adapterOptions,
				requestSizeLimit
			)
			if (!pendingLimit) return next()
			return pendingLimit.then(() => {
				syncRawRequest(state)
				return next()
			})
		})
		if (options.bodyParser !== false)
			this.registerParserMiddleware(undefined, options.rawBody)

		this.httpServer = createServer(this.hono, options, this.adapterOptions)
	}

	getType() {
		return 'hono'
	}

	registerParserMiddleware(_prefix?: string, rawBody?: boolean) {
		const missingTypes = DEFAULT_PARSER_TYPES.filter(
			type => !this.registeredParserTypes.has(type)
		)
		if (missingTypes.length === 0) return
		this.logger.log('Registering parser middleware')
		const parserTypes: string[] = []
		this.batchedParserTypes = parserTypes
		try {
			for (const type of missingTypes)
				this.useBodyParser(type, rawBody ?? false)
		} finally {
			this.batchedParserTypes = undefined
		}
		if (parserTypes.length > 0)
			this.hono.use(
				createParserMiddleware({
					adapterOptions: this.adapterOptions,
					parserTypes,
					rawBody: rawBody ?? false,
				})
			)
	}

	createMiddlewareFactory(requestMethod: RequestMethod) {
		return Promise.resolve((path: string, callback: Function) => {
			this.routes.registerMiddleware(requestMethod, path, callback)
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

	override listen(port: number, ...args: unknown[]): HonoHttpServer {
		return this.httpServer.listen(port, ...(args as []))
	}
}
