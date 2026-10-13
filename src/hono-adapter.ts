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
import { createBodyLimit, parseBodyLimit } from './helpers/body-parser'
import { createCorsMiddleware, type NestCorsOptions } from './helpers/cors'
import {
	createShutdownMiddleware,
	installNest12Members,
	type Nest12ApplicationOptions,
	runSecurityHooks,
	type SecurityRequestHook,
} from './helpers/nest-12'
import { getRequestHostname, getRequestPathWithSearch } from './helpers/request'
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
import { createBodyLimitMiddleware } from './request/body-limit-middleware'
import { createParserMiddleware } from './request/body-parser-middleware'
import { getNestRequest } from './request/nest-request'
import { getRequestState } from './request/request-state'
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
	private isShuttingDown = false
	private readonly securityHooks: SecurityRequestHook[] = []
	private readonly routes: RouteRegistry

	constructor(options: HonoAdapterOptions = {}) {
		super(new Hono())
		this.adapterOptions = options
		this.routes = new RouteRegistry(this.hono, options)
		this.hono.use((ctx, next) => {
			getRequestState(ctx, this.adapterOptions)
			if (this.securityHooks.length > 0)
				runSecurityHooks(ctx, getNestRequest(ctx.req), this.securityHooks)
			return next()
		})
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
			await handler(err, getNestRequest(ctx.req) as unknown as Request, ctx)
			return getFinalizedResponse(ctx)
		})
	}

	setNotFoundHandler(
		handler: (req: Request, res: Context) => void | Promise<void>
	) {
		this.hono.notFound(async ctx => {
			await handler(getNestRequest(ctx.req) as unknown as Request, ctx)
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
		return getRequestHostname(
			'req' in requestOrContext ? requestOrContext.req : requestOrContext
		)
	}

	getRequestMethod(request: Context['req']) {
		return request.method
	}

	getRequestUrl(request: Context['req']) {
		return getRequestPathWithSearch(request)
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
		this.isShuttingDown = true
		return new Promise(resolve => {
			this.httpServer.close(() => resolve())
			if ('closeIdleConnections' in this.httpServer)
				this.httpServer.closeIdleConnections()
			if (this.forceCloseConnections) this.httpServer.closeAllConnections?.()
		})
	}

	initHttpServer(options: NestApplicationOptions) {
		this.forceCloseConnections = options.forceCloseConnections ?? false
		if ((options as Nest12ApplicationOptions).return503OnClosing)
			this.hono.use(createShutdownMiddleware(() => this.isShuttingDown))

		this.hono.use(
			createBodyLimitMiddleware({
				adapterOptions: this.adapterOptions,
				parse:
					options.bodyParser === false
						? undefined
						: this.createDefaultParserMiddleware(options.rawBody ?? false),
			})
		)

		this.httpServer = createServer(this.hono, options, this.adapterOptions)
	}

	getType() {
		return 'hono'
	}

	/**
	 * Hono matches routes in registration order, so Nest keeps its
	 * declaration-order registration (Nest 12).
	 */
	isRouteOrderSensitive() {
		return true
	}

	/** Nest 12 `@QueryMethod()` routes; installed as `query` below. */
	registerQueryRoute(...args: RouteArguments) {
		this.routes.register('query', ...args)
	}

	/**
	 * Installed as `registerSecurityHook` below. Hooks run in the adapter's
	 * first Hono layer, before body limits and parsing, so early rejections
	 * also carry the security headers (like Express, where the hook is
	 * registered before Nest's body parsers).
	 */
	addSecurityHook(hook: SecurityRequestHook) {
		this.securityHooks.push(hook)
	}

	/**
	 * Installed as `beforeClose` on the prototype below; makes
	 * `return503OnClosing` answer requests that arrive during shutdown.
	 */
	prepareClose() {
		this.isShuttingDown = true
	}

	registerParserMiddleware(_prefix?: string, rawBody?: boolean) {
		const parse = this.createDefaultParserMiddleware(rawBody ?? false)
		if (parse) this.hono.use(parse)
	}

	private createDefaultParserMiddleware(rawBody: boolean) {
		const missingTypes = DEFAULT_PARSER_TYPES.filter(
			type => !this.registeredParserTypes.has(type)
		)
		if (missingTypes.length === 0) return
		this.logger.log('Registering parser middleware')
		const parserTypes: string[] = []
		this.batchedParserTypes = parserTypes
		try {
			for (const type of missingTypes) this.useBodyParser(type, rawBody)
		} finally {
			this.batchedParserTypes = undefined
		}
		if (parserTypes.length === 0) return
		return createParserMiddleware({
			adapterOptions: this.adapterOptions,
			parserTypes,
			rawBody,
		})
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

installNest12Members(HonoAdapter.prototype, {
	beforeClose: HonoAdapter.prototype.prepareClose,
	query: HonoAdapter.prototype.registerQueryRoute,
	registerSecurityHook: HonoAdapter.prototype.addSecurityHook,
})
