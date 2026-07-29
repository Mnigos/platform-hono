import { EventEmitter } from 'node:events'
import type { Server } from 'node:http'
import type { Server as HttpsServer } from 'node:https'
import { PassThrough } from 'node:stream'
import { serveStatic } from '@hono/node-server/serve-static'
import { Logger, RequestMethod } from '@nestjs/common'
import type { Context } from 'hono'
import { getNestHonoRequest, type NestHonoRequest } from './helpers/request'
import { HonoAdapter } from './hono-adapter'

vi.mock('@hono/node-server/serve-static', () => ({
	serveStatic: vi.fn(() => async () => new Response('static')),
}))

const TRUSTED_ORIGIN_REGEX = /^https:\/\/trusted\.test$/

beforeEach(() => {
	vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
	vi.restoreAllMocks()
})

function createInitializedAdapter(
	options?: ConstructorParameters<typeof HonoAdapter>[0]
) {
	const adapter = new HonoAdapter(options)
	adapter.initHttpServer({})
	return adapter
}

async function requestWithCapturedBody(
	adapter: HonoAdapter,
	path: string,
	init?: RequestInit
) {
	let capturedRequest: NestHonoRequest | undefined

	adapter.post(path, req => {
		capturedRequest = getNestHonoRequest(req)
	})

	await adapter.hono.request(path, { method: 'POST', ...init })

	if (!capturedRequest) throw new Error('Request was not captured')
	return capturedRequest
}

describe('HonoAdapter', () => {
	test('exposes the Hono instance and parser registration state', () => {
		const adapter = new HonoAdapter()
		const useBodyParserSpy = vi.spyOn(adapter, 'useBodyParser')

		expect(adapter.hono).toBe(adapter.getInstance())
		expect(adapter.isParserRegistered).toBe(false)

		adapter.registerParserMiddleware()
		adapter.registerParserMiddleware()

		expect(adapter.isParserRegistered).toBe(true)
		expect(useBodyParserSpy).toHaveBeenCalledTimes(4)
	})

	test('registers all non-HEAD HTTP route helpers', async () => {
		const adapter = new HonoAdapter()
		const methods = [
			'copy',
			'delete',
			'get',
			'lock',
			'mkcol',
			'move',
			'options',
			'patch',
			'post',
			'propfind',
			'proppatch',
			'put',
			'search',
			'unlock',
		] as const

		for (const method of methods) {
			adapter[method](`/${method}`, async (_req, ctx) => {
				await adapter.reply(ctx, method)
			})
		}
		adapter.all('/all', async (_req, ctx) => {
			await adapter.reply(ctx, 'all')
		})

		for (const method of methods) {
			const response = await adapter.hono.request(`/${method}`, {
				method: method.toUpperCase(),
			})
			await expect(response.text()).resolves.toBe(method)
		}

		await expect(
			(await adapter.hono.request('/all', { method: 'POST' })).text()
		).resolves.toBe('all')
	})

	test('registers explicit HEAD route helpers', async () => {
		const adapter = new HonoAdapter()

		adapter.get('/head', async (_req, ctx) => {
			ctx.header('x-handler', 'get')
			await adapter.reply(ctx, 'get')
		})
		adapter.head('/head', async (_req, ctx) => {
			ctx.header('x-handler', 'head')
			await adapter.reply(ctx, undefined, 204)
		})

		const headResponse = await adapter.hono.request('/head', { method: 'HEAD' })
		expect(headResponse.status).toBe(204)
		expect(headResponse.headers.get('x-handler')).toBe('head')
	})

	test('cancels GET response streams used for HEAD fallback', async () => {
		const adapter = new HonoAdapter()
		const stream = new PassThrough()

		adapter.get('/stream', async (_req, ctx) => {
			await adapter.reply(ctx, stream)
		})

		const response = await adapter.hono.request('/stream', { method: 'HEAD' })

		expect(response.status).toBe(200)
		expect(response.body).toBeNull()
		expect(stream.destroyed).toBe(true)
	})

	test('emits request close when the client socket disconnects', async () => {
		const adapter = new HonoAdapter()
		const socket = new EventEmitter()
		const closeListener = vi.fn()

		adapter.get('/disconnect', (req, ctx) => {
			const on = getNestHonoRequest(req).on as (
				event: string,
				listener: () => void
			) => void
			on('close', closeListener)
			adapter.reply(ctx, new ReadableStream())
		})

		const response = await adapter.hono.request('/disconnect', undefined, {
			incoming: { socket },
		})
		const reader = response.body?.getReader()

		if (!reader) throw new Error('Expected a response body reader')
		const pendingRead = reader.read()
		socket.emit('close')

		await expect(pendingRead).resolves.toMatchObject({ done: true })
		expect(closeListener).toHaveBeenCalledOnce()
	})

	test('throws when a route handler is missing', () => {
		const adapter = new HonoAdapter()

		expect(() => adapter.get('/missing')).toThrow('Route handler is required')
	})

	test('supports handler-only route overloads', async () => {
		const adapter = new HonoAdapter()

		adapter.get(async (_req, ctx) => {
			await adapter.reply(ctx, 'handler-only')
		})

		await expect((await adapter.hono.request('/')).text()).resolves.toBe(
			'handler-only'
		)
	})

	test('runs handler-only use middleware globally', async () => {
		const adapter = new HonoAdapter()

		adapter.use((_req, ctx, next) => {
			ctx.header('x-global', 'yes')
			next()
		})
		adapter.get('/nested', async (_req, ctx) => {
			await adapter.reply(ctx, 'ok')
		})

		expect(
			(await adapter.hono.request('/nested')).headers.get('x-global')
		).toBe('yes')
	})

	test('preserves explicit global use wildcard paths', async () => {
		const adapter = new HonoAdapter()

		adapter.use('*', (_req, ctx, next) => {
			ctx.header('x-global-wildcard', 'ran')
			next()
		})
		adapter.get('/wildcard-target', async (_req, ctx) => {
			await adapter.reply(ctx, 'ok')
		})

		const response = await adapter.hono.request('/wildcard-target')

		expect(response.headers.get('x-global-wildcard')).toBe('ran')
	})

	test('preserves responses returned directly from route handlers', async () => {
		const adapter = new HonoAdapter()

		adapter.get(
			'/direct-response',
			() =>
				new Response('direct', {
					headers: { 'x-direct': 'yes' },
					status: 202,
				})
		)

		const response = await adapter.hono.request('/direct-response')

		expect(response.status).toBe(202)
		expect(response.headers.get('x-direct')).toBe('yes')
		await expect(response.text()).resolves.toBe('direct')
	})

	test('preserves repeated response headers in the SSE facade', async () => {
		const adapter = new HonoAdapter()
		let setCookies: unknown

		adapter.get('/sse-headers', (_req, ctx) => {
			ctx.res.headers.append('set-cookie', 'a=1')
			ctx.res.headers.append('set-cookie', 'b=2')
			const getHeaders = (
				ctx as Context & {
					getHeaders?: () => Record<string, unknown>
				}
			).getHeaders
			setCookies = getHeaders?.()['set-cookie']
			adapter.reply(ctx, 'ok')
		})

		await adapter.hono.request('/sse-headers')

		expect(setCookies).toEqual(['a=1', 'b=2'])
	})

	test('runs use middleware before routes', async () => {
		const adapter = new HonoAdapter()

		adapter.use('/scoped', (_req, ctx, next) => {
			ctx.header('x-middleware', 'ran')
			setTimeout(next, 10)
		})
		adapter.get('/scoped/route', async (_req, ctx) => {
			await adapter.reply(ctx, 'ok')
		})

		expect(
			(await adapter.hono.request('/scoped/route')).headers.get('x-middleware')
		).toBe('ran')
	})

	test('normalizes request metadata for route handlers', async () => {
		const adapter = new HonoAdapter({ trustProxy: true })
		let capturedRequest: NestHonoRequest | undefined

		adapter.get('/users/:id', req => {
			capturedRequest = getNestHonoRequest(req)
		})

		await adapter.hono.request('/users/123?tab=profile', {
			headers: {
				host: 'example.test',
				'x-forwarded-for': '203.0.113.10, 10.0.0.1',
			},
		})

		expect(capturedRequest).toMatchObject({
			baseUrl: '/users/123',
			headers: expect.objectContaining({ host: 'example.test' }),
			ip: '10.0.0.1',
			params: { id: '123' },
			query: { tab: 'profile' },
		})
	})

	test('supports named wildcard params from Nest route patterns', async () => {
		const adapter = new HonoAdapter()
		let capturedRequest: NestHonoRequest | undefined

		adapter.delete('/*path', req => {
			capturedRequest = getNestHonoRequest(req)
		})

		const response = await adapter.hono.request('/world/who%3F', {
			method: 'DELETE',
		})

		expect(response.status).toBe(200)
		expect(capturedRequest).toMatchObject({
			params: { path: 'world/who?' },
		})
	})

	test('expands Nest optional route groups without corrupting the router', async () => {
		const adapter = new HonoAdapter()

		adapter.get('/users{/:id}', async (req, ctx) => {
			await adapter.reply(ctx, getNestHonoRequest(req).params?.id ?? 'all')
		})
		adapter.get('/plain', async (_req, ctx) => {
			await adapter.reply(ctx, 'plain')
		})

		await expect((await adapter.hono.request('/users')).text()).resolves.toBe(
			'all'
		)
		await expect(
			(await adapter.hono.request('/users/42')).text()
		).resolves.toBe('42')
		await expect((await adapter.hono.request('/plain')).text()).resolves.toBe(
			'plain'
		)
	})

	test('expands Nest optional literal suffixes after parameters', async () => {
		const adapter = new HonoAdapter()

		adapter.get('/file/:name{.json}', async (req, ctx) => {
			await adapter.reply(ctx, getNestHonoRequest(req).params?.name)
		})

		await expect(
			(await adapter.hono.request('/file/report')).text()
		).resolves.toBe('report')
		await expect(
			(await adapter.hono.request('/file/report.json')).text()
		).resolves.toBe('report')
		await expect(
			(await adapter.hono.request('/file/.json')).text()
		).resolves.toBe('.json')
	})

	test('preserves Hono parameter constraints while expanding Nest groups', async () => {
		const adapter = new HonoAdapter()

		adapter.get('/numeric/:id{[0-9]+}', async (_req, ctx) => {
			await adapter.reply(ctx, 'numeric')
		})

		expect((await adapter.hono.request('/numeric/123')).status).toBe(200)
		expect((await adapter.hono.request('/numeric/abc')).status).toBe(404)
	})

	test('preserves request IP values that were already set upstream', async () => {
		const adapter = new HonoAdapter({ trustProxy: true })
		let capturedRequest: NestHonoRequest | undefined

		adapter.hono.use('/meta', async (ctx, next) => {
			getNestHonoRequest(ctx.req).ip = '192.0.2.10'
			await next()
		})
		adapter.get('/meta', req => {
			capturedRequest = getNestHonoRequest(req)
		})

		await adapter.hono.request('/meta', {
			headers: { 'x-forwarded-for': '203.0.113.10' },
		})

		expect(capturedRequest?.ip).toBe('192.0.2.10')
	})

	test('preserves raw request bodies for downstream consumers after parsing', async () => {
		const adapter = createInitializedAdapter()
		const bodyText = JSON.stringify({ ok: true })

		const req = (await requestWithCapturedBody(adapter, '/json', {
			body: bodyText,
			headers: { 'content-type': 'application/json' },
		})) as NestHonoRequest & { raw: Request }

		expect(req.body).toEqual({ ok: true })
		await expect(req.raw.text()).resolves.toBe(bodyText)
	})

	test('leaves request bodies untouched when bodyParser is disabled', async () => {
		const adapter = new HonoAdapter()
		adapter.initHttpServer({ bodyParser: false })

		const req = await requestWithCapturedBody(adapter, '/json', {
			body: JSON.stringify({ ok: true }),
			headers: { 'content-type': 'application/json' },
		})

		expect(req.body).toBeUndefined()
	})

	test('skips body parsing for configured path segments only', async () => {
		const skipAdapter = createInitializedAdapter({
			skipBodyParserFor: ['/api/auth'],
		})
		const skippedRequest = await requestWithCapturedBody(
			skipAdapter,
			'/api/auth',
			{
				body: JSON.stringify({ skipped: true }),
				headers: { 'content-type': 'application/json' },
			}
		)
		const siblingAdapter = createInitializedAdapter({
			skipBodyParserFor: ['/api/auth'],
		})
		const parsedSiblingRequest = await requestWithCapturedBody(
			siblingAdapter,
			'/api/authentication',
			{
				body: JSON.stringify({ parsed: true }),
				headers: { 'content-type': 'application/json' },
			}
		)

		expect(skippedRequest.body).toBeUndefined()
		expect(parsedSiblingRequest.body).toEqual({ parsed: true })
	})

	test('applies request size limits through initialized middleware', async () => {
		const adapter = createInitializedAdapter({
			requestSizeLimits: [
				{ path: '/upload', maxBytes: 3, errorMessage: 'Upload too large' },
			],
		})
		adapter.hono.onError(err => {
			throw err
		})

		adapter.post('/upload', async (_req, ctx) => {
			await adapter.reply(ctx, 'ok')
		})

		await expect(
			adapter.hono.request('/upload', {
				body: 'hello',
				headers: {
					'content-length': '5',
					'content-type': 'text/plain',
				},
				method: 'POST',
			})
		).rejects.toMatchObject({ message: 'Upload too large' })
	})

	test.each<[string, number | { limit: string }, string, boolean]>([
		['numeric', 3, 'hello', true],
		['string unit', { limit: '3b' }, 'hello', false],
		['zero-byte', { limit: '0b' }, 'x', false],
	])('enforces %s Nest body parser limits', async (_case, limit, body, scoped) => {
		const adapter = new HonoAdapter()

		adapter.useBodyParser('text/plain', false, limit)
		adapter.hono.onError(err => {
			throw err
		})
		adapter.post('/limited', async (_req, ctx) => {
			await adapter.reply(ctx, 'ok')
		})

		await expect(
			adapter.hono.request('/limited', {
				body,
				headers: { 'content-type': 'text/plain' },
				method: 'POST',
			})
		).rejects.toBeInstanceOf(Error)

		if (scoped) {
			expect(
				(
					await adapter.hono.request('/limited', {
						body: '{"long":true}',
						headers: { 'content-type': 'application/json' },
						method: 'POST',
					})
				).status
			).toBe(200)
		}
	})

	test('replies with JSON, text, buffers, empty bodies, and prebuilt responses', async () => {
		const adapter = new HonoAdapter()

		adapter.get('/json', async (_req, ctx) => {
			await adapter.reply(ctx, { ok: true }, 201)
		})
		adapter.get('/text', async (_req, ctx) => {
			await adapter.reply(ctx, 'hello')
		})
		adapter.get('/buffer', async (_req, ctx) => {
			await adapter.reply(ctx, Buffer.from('abc'))
		})
		adapter.get('/empty', async (_req, ctx) => {
			await adapter.reply(ctx, undefined, 204)
		})
		adapter.get('/response', async (_req, ctx) => {
			await adapter.reply(
				ctx,
				new Response('prebuilt', {
					headers: { 'x-prebuilt': 'yes' },
					status: 202,
				})
			)
		})

		const jsonResponse = await adapter.hono.request('/json')
		expect(jsonResponse.status).toBe(201)
		await expect(jsonResponse.json()).resolves.toEqual({ ok: true })

		await expect((await adapter.hono.request('/text')).text()).resolves.toBe(
			'hello'
		)

		const bufferResponse = await adapter.hono.request('/buffer')
		expect(bufferResponse.headers.get('content-type')).toBe(
			'application/octet-stream'
		)
		await expect(bufferResponse.text()).resolves.toBe('abc')

		expect((await adapter.hono.request('/empty')).status).toBe(204)

		const prebuiltResponse = await adapter.hono.request('/response')
		expect(prebuiltResponse.status).toBe(202)
		expect(prebuiltResponse.headers.get('x-prebuilt')).toBe('yes')
		await expect(prebuiltResponse.text()).resolves.toBe('prebuilt')
	})

	test('warns and forces JSON content type for error-like objects', async () => {
		const warnSpy = vi
			.spyOn(Logger.prototype, 'warn')
			.mockImplementation(() => undefined)
		const adapter = new HonoAdapter()

		adapter.get('/error-body', async (_req, ctx) => {
			ctx.header('content-type', 'text/plain')
			await adapter.reply(ctx, { statusCode: 500, message: 'nope' })
		})

		const response = await adapter.hono.request('/error-body')

		expect(warnSpy).toHaveBeenCalledOnce()
		expect(response.headers.get('content-type')).toContain('application/json')
		await expect(response.json()).resolves.toEqual({
			message: 'nope',
			statusCode: 500,
		})
	})

	test('preserves structured JSON content types for error responses', async () => {
		const warnSpy = vi
			.spyOn(Logger.prototype, 'warn')
			.mockImplementation(() => undefined)
		const adapter = new HonoAdapter()

		adapter.get('/problem', async (_req, ctx) => {
			ctx.header('content-type', 'application/problem+json')
			await adapter.reply(ctx, { detail: 'nope', statusCode: 400 }, 400)
		})

		const response = await adapter.hono.request('/problem')

		expect(warnSpy).not.toHaveBeenCalled()
		expect(response.headers.get('content-type')).toBe(
			'application/problem+json'
		)
		await expect(response.json()).resolves.toEqual({
			detail: 'nope',
			statusCode: 400,
		})
	})

	test('gets, sets, and appends headers', async () => {
		const adapter = new HonoAdapter()

		adapter.get('/headers', async (_req, ctx) => {
			await adapter.setHeader(ctx, 'x-one', '1')
			await adapter.appendHeader(ctx, 'x-many', 'a')
			await adapter.appendHeader(ctx, 'x-many', 'b')
			await adapter.reply(ctx, await adapter.getHeader(ctx, 'x-one'))
		})

		const response = await adapter.hono.request('/headers')

		expect(response.headers.get('x-many')).toBe('a, b')
		await expect(response.text()).resolves.toBe('1')
	})

	test('redirects with requested status and URL', async () => {
		const adapter = new HonoAdapter()

		adapter.get('/redirect', async (_req, ctx) => {
			await adapter.redirect(ctx, 302, '/target')
		})

		const response = await adapter.hono.request('/redirect')

		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe('/target')
	})

	test('reports finalized headers and request host', async () => {
		const adapter = new HonoAdapter()
		let finalizedBeforeReply: boolean | undefined
		let finalizedAfterReply: boolean | undefined
		let hostname: string | undefined

		adapter.get('/state', async (_req, ctx) => {
			finalizedBeforeReply = await adapter.isHeadersSent(ctx)
			hostname = await adapter.getRequestHostname(ctx)
			await adapter.reply(ctx, 'ok')
			finalizedAfterReply = await adapter.isHeadersSent(ctx)
		})

		await adapter.hono.request('/state', { headers: { host: 'example.test' } })

		expect(finalizedBeforeReply).toBe(false)
		expect(finalizedAfterReply).toBe(true)
		expect(hostname).toBe('example.test')
	})

	test('runs custom error and not found handlers', async () => {
		const adapter = new HonoAdapter()

		adapter.setErrorHandler(async (err, _req, ctx) => {
			await adapter.reply(ctx, { message: err.message }, 418)
		})
		adapter.setNotFoundHandler(async (_req, ctx) => {
			await adapter.setHeader(ctx, 'x-not-found', 'yes')
		})
		adapter.get('/boom', () => {
			throw new Error('boom')
		})

		const errorResponse = await adapter.hono.request('/boom')
		expect(errorResponse.status).toBe(418)
		await expect(errorResponse.json()).resolves.toEqual({ message: 'boom' })

		const notFoundResponse = await adapter.hono.request('/missing')
		expect(notFoundResponse.status).toBe(404)
		expect(notFoundResponse.headers.get('x-not-found')).toBe('yes')
		await expect(notFoundResponse.text()).resolves.toBe('Not Found')
	})

	test('registers static assets and CORS middleware', async () => {
		const adapter = new HonoAdapter()
		const staticOptions = { root: './public' }
		const corsOptions = { origin: 'https://example.test' }

		adapter.enableCors(corsOptions)
		adapter.useStaticAssets('/assets/*', staticOptions)
		adapter.post('/assets/app.js', async (_req, ctx) => {
			await adapter.reply(ctx, 'controller')
		})

		expect(serveStatic).toHaveBeenCalledWith(staticOptions)

		const response = await adapter.hono.request('/assets/app.js', {
			headers: { origin: 'https://example.test' },
		})

		expect(response.headers.get('access-control-allow-origin')).toBe(
			'https://example.test'
		)
		await expect(response.text()).resolves.toBe('static')
		await expect(
			(await adapter.hono.request('/assets/app.js', { method: 'POST' })).text()
		).resolves.toBe('controller')
		expect(staticOptions).toEqual({ root: './public' })
		expect(corsOptions).toEqual({ origin: 'https://example.test' })
	})

	test('cancels static response streams when the client disconnects', async () => {
		const socket = new EventEmitter()
		const cancel = vi.fn()
		vi.mocked(serveStatic).mockReturnValueOnce(
			async () => new Response(new ReadableStream({ cancel }))
		)
		const adapter = new HonoAdapter()
		adapter.useStaticAssets('/assets/*', { root: './public' })

		const response = await adapter.hono.request('/assets/app.js', undefined, {
			incoming: { socket },
		})
		const reader = response.body?.getReader()

		if (!reader) throw new Error('Expected a response body reader')
		const pendingRead = reader.read()
		socket.emit('close')

		await expect(pendingRead).resolves.toMatchObject({ done: true })
		expect(cancel).toHaveBeenCalledOnce()
	})

	test('translates restrictive Nest CORS options and delegates', async () => {
		const defaultAdapter = new HonoAdapter()
		defaultAdapter.enableCors()
		const defaultResponse = await defaultAdapter.hono.request('/target', {
			headers: {
				'access-control-request-method': 'POST',
				origin: 'https://example.test',
			},
			method: 'OPTIONS',
		})
		expect(
			defaultResponse.headers.get('access-control-allow-methods')
		).toContain('POST')

		const optionsAdapter = new HonoAdapter()
		optionsAdapter.enableCors({
			allowedHeaders: ['content-type'],
			exposedHeaders: ['x-result'],
			methods: ['POST'],
			origin: TRUSTED_ORIGIN_REGEX,
		})

		const allowedResponse = await optionsAdapter.hono.request('/target', {
			headers: {
				'access-control-request-headers': 'authorization',
				'access-control-request-method': 'DELETE',
				origin: 'https://trusted.test',
			},
			method: 'OPTIONS',
		})
		expect(allowedResponse.headers.get('access-control-allow-origin')).toBe(
			'https://trusted.test'
		)
		expect(allowedResponse.headers.get('access-control-allow-methods')).toBe(
			'POST'
		)
		expect(allowedResponse.headers.get('access-control-allow-headers')).toBe(
			'content-type'
		)

		const delegateAdapter = new HonoAdapter()
		delegateAdapter.enableCors((_request, callback) => {
			callback(null, { origin: 'https://trusted.test' })
		})
		const rejectedResponse = await delegateAdapter.hono.request('/target', {
			headers: { origin: 'https://attacker.test' },
		})
		expect(rejectedResponse.headers.has('access-control-allow-origin')).toBe(
			false
		)
	})

	test('translates the standard Nest static root and prefix', () => {
		const adapter = new HonoAdapter()

		adapter.useStaticAssets('/tmp/public', { prefix: '/assets/' })

		expect(serveStatic).toHaveBeenCalledWith(
			expect.objectContaining({
				rewriteRequestPath: expect.any(Function),
				root: '/tmp/public',
			})
		)
	})

	test('creates middleware factories for Nest request methods', async () => {
		const adapter = new HonoAdapter()
		const getFactory = await adapter.createMiddlewareFactory(RequestMethod.GET)
		const headFactory = await adapter.createMiddlewareFactory(
			RequestMethod.HEAD
		)

		getFactory(
			'/factory',
			async (_req: unknown, ctx: Parameters<HonoAdapter['reply']>[0]) => {
				await adapter.reply(ctx, 'factory')
			}
		)
		headFactory(
			'/head',
			async (_req: unknown, ctx: Parameters<HonoAdapter['reply']>[0]) => {
				await adapter.reply(ctx, 'head')
			}
		)
		getFactory(
			'/wildcard/*path',
			async (
				req: NestHonoRequest,
				ctx: Parameters<HonoAdapter['reply']>[0]
			) => {
				await adapter.reply(ctx, req.params?.path)
			}
		)

		await expect((await adapter.hono.request('/factory')).text()).resolves.toBe(
			'factory'
		)
		expect(
			(await adapter.hono.request('/head', { method: 'HEAD' })).status
		).toBe(200)
		await expect(
			(await adapter.hono.request('/wildcard/one/two')).text()
		).resolves.toBe('one/two')
		await expect(
			adapter.createMiddlewareFactory(999 as RequestMethod)
		).resolves.toBeTypeOf('function')
		const unsupportedFactory = await adapter.createMiddlewareFactory(
			999 as RequestMethod
		)
		expect(() => unsupportedFactory('/unsupported', () => undefined)).toThrow(
			'Unsupported request method: 999'
		)
	})

	test('awaits conventional Nest middleware and normalizes its request', async () => {
		const adapter = new HonoAdapter()
		const getFactory = await adapter.createMiddlewareFactory(RequestMethod.GET)
		let query: NestHonoRequest['query']

		getFactory(
			'/middleware',
			(req: NestHonoRequest, _ctx: unknown, next: () => void) => {
				query = req.query
				return setTimeout(next, 10)
			}
		)
		adapter.get('/middleware', async (_req, ctx) => {
			await Promise.resolve()
			await adapter.reply(ctx, 'done')
		})

		const response = await adapter.hono.request('/middleware?tag=one&tag=two')

		expect(response.status).toBe(200)
		await expect(response.text()).resolves.toBe('done')
		expect(query).toEqual({ tag: ['one', 'two'] })
	})

	test('propagates errors passed to Nest middleware next callbacks', async () => {
		const adapter = new HonoAdapter()
		const getFactory = await adapter.createMiddlewareFactory(RequestMethod.GET)
		let routeCalled = false

		getFactory(
			'/blocked',
			(_req: unknown, _ctx: unknown, next: (error?: unknown) => void) => {
				next(new Error('blocked'))
			}
		)
		adapter.get('/blocked', async (_req, ctx) => {
			routeCalled = true
			await adapter.reply(ctx, 'unsafe')
		})
		adapter.setErrorHandler(async (error, _req, ctx) => {
			await adapter.reply(ctx, { message: error.message }, 418)
		})

		const response = await adapter.hono.request('/blocked')

		expect(response.status).toBe(418)
		await expect(response.json()).resolves.toEqual({ message: 'blocked' })
		expect(routeCalled).toBe(false)
	})

	test('runs optional all-path Nest middleware once per request', async () => {
		const adapter = new HonoAdapter()
		const allFactory = await adapter.createMiddlewareFactory(RequestMethod.ALL)
		let calls = 0

		allFactory('/{*path}', (_req: unknown, _ctx: unknown, next: () => void) => {
			calls += 1
			next()
		})
		adapter.get('/', async (_req, ctx) => {
			await adapter.reply(ctx, 'root')
		})
		adapter.get('/nested', async (_req, ctx) => {
			await adapter.reply(ctx, 'nested')
		})

		expect((await adapter.hono.request('/')).status).toBe(200)
		expect(calls).toBe(1)
		expect((await adapter.hono.request('/nested')).status).toBe(200)
		expect(calls).toBe(2)
	})

	test('returns request method, URL, adapter type, and unsupported method behavior', () => {
		const adapter = new HonoAdapter()
		const request = new Request('https://example.test/path?x=1', {
			method: 'POST',
		})

		expect(adapter.getRequestMethod(request as never)).toBe('POST')
		expect(adapter.getRequestUrl(request as never)).toBe('/path?x=1')
		expect(adapter.getType()).toBe('hono')
		expect(adapter.end()).toBeDefined()
		expect(() => adapter.render()).toThrow('Method not implemented.')
		expect(() => adapter.setViewEngine()).toThrow('Method not implemented.')
		expect(() =>
			adapter.applyVersionFilter(() => undefined, '1', {} as never)
		).toThrow('Versioning not yet supported in Hono')
	})

	test('initializes HTTP and HTTPS server factories and delegates listen and close', async () => {
		const httpAdapter = new HonoAdapter()
		httpAdapter.initHttpServer({})

		const httpServer = httpAdapter.getHttpServer() as Server
		const listenSpy = vi
			.spyOn(httpServer, 'listen')
			.mockReturnValue(httpServer as ReturnType<Server['listen']>)
		const closeSpy = vi
			.spyOn(httpServer, 'close')
			.mockImplementation(callback => {
				callback?.()
				return httpServer
			})
		const closeIdleConnectionsSpy = vi.spyOn(httpServer, 'closeIdleConnections')
		const closeAllConnectionsSpy = vi.spyOn(httpServer, 'closeAllConnections')

		expect(httpAdapter.listen(0)).toBe(httpServer)
		await expect(httpAdapter.close()).resolves.toBeUndefined()
		expect(listenSpy).toHaveBeenCalledWith(0)
		expect(closeSpy).toHaveBeenCalledOnce()
		expect(closeIdleConnectionsSpy).toHaveBeenCalledOnce()
		expect(closeAllConnectionsSpy).not.toHaveBeenCalled()

		const forceCloseAdapter = new HonoAdapter()
		forceCloseAdapter.initHttpServer({ forceCloseConnections: true })
		const forceCloseServer = forceCloseAdapter.getHttpServer() as Server
		vi.spyOn(forceCloseServer, 'close').mockImplementation(callback => {
			callback?.()
			return forceCloseServer
		})
		const forceCloseConnectionsSpy = vi.spyOn(
			forceCloseServer,
			'closeAllConnections'
		)
		await forceCloseAdapter.close()
		expect(forceCloseConnectionsSpy).toHaveBeenCalledOnce()

		const httpsAdapter = new HonoAdapter()
		httpsAdapter.initHttpServer({
			httpsOptions: {
				requestCert: true,
			},
		})

		expect(
			(httpsAdapter.getHttpServer() as HttpsServer & { requestCert: boolean })
				.requestCert
		).toBe(true)
	})
})
