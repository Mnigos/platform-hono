import type { Server } from 'node:http'
import { serveStatic } from '@hono/node-server/serve-static'
import { Logger, RequestMethod } from '@nestjs/common'
import { getNestHonoRequest, type NestHonoRequest } from './helpers/request'
import { HonoAdapter } from './hono-adapter'

vi.mock('@hono/node-server/serve-static', () => ({
	serveStatic: vi.fn(() => async () => new Response('static')),
}))

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
		expect(useBodyParserSpy).toHaveBeenCalledTimes(3)
	})

	test('registers all HTTP route helpers', async () => {
		const adapter = new HonoAdapter()
		const methods = [
			'get',
			'post',
			'put',
			'delete',
			'patch',
			'options',
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

	test('runs use middleware before routes', async () => {
		const adapter = new HonoAdapter()

		adapter.use('/scoped/*', (_req, ctx) => {
			ctx.header('x-middleware', 'ran')
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
			headers: expect.objectContaining({ host: 'example.test' }),
			ip: '203.0.113.10',
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

	test('normalizes request metadata in initialized middleware', async () => {
		const adapter = createInitializedAdapter({ trustProxy: true })
		let capturedRequest: NestHonoRequest | undefined

		adapter.get('/meta', req => {
			capturedRequest = getNestHonoRequest(req)
		})

		await adapter.hono.request('/meta?ok=true', {
			headers: {
				host: 'example.test',
				'x-real-ip': '198.51.100.5',
			},
		})

		expect(capturedRequest).toMatchObject({
			baseUrl: '/meta',
			headers: expect.objectContaining({ host: 'example.test' }),
			ip: '198.51.100.5',
		})
	})

	test('does not trust forwarded IP headers by default', async () => {
		const adapter = createInitializedAdapter()
		let capturedRequest: NestHonoRequest | undefined

		adapter.get('/meta', req => {
			capturedRequest = getNestHonoRequest(req)
		})

		await adapter.hono.request('/meta', {
			headers: { 'x-forwarded-for': '203.0.113.10' },
		})

		expect(capturedRequest?.ip).toBeUndefined()
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

	test('parses request bodies through initialized middleware', async () => {
		const adapter = createInitializedAdapter()

		const req = await requestWithCapturedBody(adapter, '/json', {
			body: JSON.stringify({ ok: true }),
			headers: { 'content-type': 'application/json' },
		})

		expect(req.body).toEqual({ ok: true })
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

	test('uses explicit body parser limits registered through Nest parser hooks', async () => {
		const adapter = new HonoAdapter()

		adapter.useBodyParser('text/plain', false, 3)
		adapter.hono.onError(err => {
			throw err
		})
		adapter.post('/limited', async (_req, ctx) => {
			await adapter.reply(ctx, 'ok')
		})

		await expect(
			adapter.hono.request('/limited', {
				body: 'hello',
				headers: {
					'content-length': '5',
					'content-type': 'text/plain',
				},
				method: 'POST',
			})
		).rejects.toBeInstanceOf(Error)
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

		expect(serveStatic).toHaveBeenCalledWith(staticOptions)

		const response = await adapter.hono.request('/assets/app.js', {
			headers: { origin: 'https://example.test' },
		})

		expect(response.headers.get('access-control-allow-origin')).toBe(
			'https://example.test'
		)
		await expect(response.text()).resolves.toBe('static')
		expect(staticOptions).toEqual({ root: './public' })
		expect(corsOptions).toEqual({ origin: 'https://example.test' })
	})

	test('creates middleware factories for Nest request methods', async () => {
		const adapter = new HonoAdapter()
		const getFactory = await adapter.createMiddlewareFactory(RequestMethod.GET)
		const headFactory = await adapter.createMiddlewareFactory(
			RequestMethod.HEAD
		)
		const fallbackFactory = await adapter.createMiddlewareFactory(
			999 as RequestMethod
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
		fallbackFactory(
			'/fallback',
			async (_req: unknown, ctx: Parameters<HonoAdapter['reply']>[0]) => {
				await adapter.reply(ctx, 'fallback')
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
			(await adapter.hono.request('/fallback')).text()
		).resolves.toBe('fallback')
		await expect(
			(await adapter.hono.request('/wildcard/one/two')).text()
		).resolves.toBe('one/two')
	})

	test('returns request method, URL, adapter type, and unsupported method behavior', () => {
		const adapter = new HonoAdapter()
		const request = new Request('https://example.test/path?x=1', {
			method: 'POST',
		})

		expect(adapter.getRequestMethod(request as never)).toBe('POST')
		expect(adapter.getRequestUrl(request as never)).toBe(
			'https://example.test/path?x=1'
		)
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
		expect(closeAllConnectionsSpy).toHaveBeenCalledOnce()

		const httpsAdapter = new HonoAdapter()
		httpsAdapter.initHttpServer({
			httpsOptions: {
				cert: 'cert',
				key: 'key',
			},
		})

		expect(httpsAdapter.getHttpServer()).toBeDefined()
	})
})
