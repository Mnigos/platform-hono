import { type ErrorHandler, Hono, type NotFoundHandler } from 'hono'
import type { HonoAdapterOptions } from '../options'
import { createBodyLimitMiddleware } from '../request/body-limit-middleware'
import { createRequestLayer } from '../request/request-layer'
import type { RouteHandlerOptions } from '../routing/route-invoker'
import { RouteRegistry } from '../routing/route-registry'
import { BunFastPath } from './bun-fast-path'
import { type FastPathOptions, FastRoutes } from './fast-routes'
import { getAdapterContextClass } from './hono-context'

interface FixtureOptions {
	adapterOptions?: HonoAdapterOptions
	beforeRoute?: (options: FastPathOptions) => void
	errorHandler?: ErrorHandler
	method?: 'all' | 'get'
	notFoundHandler?: NotFoundHandler
	routeHandler?: RouteHandlerOptions['routeHandler']
}

function fixture({
	adapterOptions = {},
	beforeRoute,
	errorHandler,
	method = 'get',
	notFoundHandler = ctx => ctx.text('missing', 404),
	routeHandler = (_req, ctx) => ctx.text('ok'),
}: FixtureOptions = {}) {
	const hono = new Hono()
	const securityHooks: FastPathOptions['securityHooks'][number][] = []
	const requestLayer = vi.fn(createRequestLayer(adapterOptions, securityHooks))
	const routes = new RouteRegistry(hono, adapterOptions)
	const options: FastPathOptions = {
		adapterOptions,
		hono,
		requestLayer,
		routes,
		securityHooks,
	}
	const ContextClass = getAdapterContextClass(false)
	if (!ContextClass)
		throw new Error('Supported Hono must pass the context probe')
	const fastPath = new BunFastPath(options, ContextClass)
	hono.use(requestLayer)
	hono.use(createBodyLimitMiddleware({ adapterOptions }))
	beforeRoute?.(options)
	routes.register(method, '/users/:id', routeHandler)
	hono.notFound(notFoundHandler)
	if (errorHandler) hono.onError(errorHandler)
	return {
		dispatch: fastPath.wrapFetch(hono.fetch),
		hono,
		options,
		requestLayerSpy: requestLayer,
	}
}

async function snapshot(response: Response | Promise<Response>) {
	const resolved = await response
	return {
		body: await resolved.text(),
		headers: [...resolved.headers],
		status: resolved.status,
	}
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('BunFastPath dispatch parity', () => {
	test.each([
		'get',
		'all',
	] as const)('serves a Nest %s route without calling hono.fetch', async method => {
		const { dispatch, requestLayerSpy } = fixture({ method })

		expect(
			await snapshot(dispatch(new Request('http://localhost/users/42'), {}))
		).toMatchObject({ body: 'ok', status: 200 })
		expect(requestLayerSpy).not.toHaveBeenCalled()
	})

	test.each([
		{
			name: 'sync response and route params',
			routeHandler: (req, ctx) => ctx.json({ id: req.params.id }),
		},
		{
			name: 'async response',
			routeHandler: async (_req, ctx) => {
				await Promise.resolve()
				ctx.header('x-route', 'async')
				return ctx.text('async', 201)
			},
		},
		{
			name: 'context finalized without returning a response',
			routeHandler: (_req, ctx) => {
				ctx.res = ctx.text('finalized', 202)
			},
		},
		{
			name: 'empty handler',
			routeHandler: () => undefined,
		},
		{
			name: 'sync error',
			routeHandler: () => {
				throw new Error('sync failure')
			},
		},
		{
			name: 'async error',
			routeHandler: () => Promise.reject(new Error('async failure')),
		},
		{
			name: 'next error',
			routeHandler: (_req, _ctx, next) => next?.(new Error('next failure')),
		},
		{
			name: 'next reaches not-found',
			routeHandler: async (_req, _ctx, next) => {
				await next?.()
			},
		},
		{
			name: 'next twice',
			routeHandler: async (_req, _ctx, next) => {
				await next?.()
				await next?.()
			},
		},
	] satisfies {
		name: string
		routeHandler: RouteHandlerOptions['routeHandler']
	}[])('matches hono.fetch for $name', async ({ routeHandler }) => {
		const { dispatch, hono, requestLayerSpy } = fixture({
			errorHandler: (error, ctx) => ctx.text(error.message, 500),
			routeHandler,
		})
		const request = () => new Request('http://localhost/users/42?q=value')
		const fast = await snapshot(dispatch(request(), {}))

		expect(requestLayerSpy).not.toHaveBeenCalled()
		expect(fast).toEqual(await snapshot(hono.fetch(request(), {})))
	})

	test('rejects non-Error route failures with the same value as Hono', async () => {
		const failure = { code: 'failure' }
		const { dispatch, hono, requestLayerSpy } = fixture({
			routeHandler: () => Promise.reject(failure),
		})
		await expect(
			dispatch(new Request('http://localhost/users/42'), {})
		).rejects.toBe(failure)
		expect(requestLayerSpy).not.toHaveBeenCalled()
		await expect(hono.request('/users/42')).rejects.toBe(failure)
	})

	test('rejects when the error handler keeps throwing, like Hono', async () => {
		const failure = new Error('error handler failed')
		const { dispatch, hono, requestLayerSpy } = fixture({
			errorHandler: () => {
				throw failure
			},
			routeHandler: () => {
				throw new Error('route failed')
			},
		})
		await expect(
			dispatch(new Request('http://localhost/users/42'), {})
		).rejects.toBe(failure)
		expect(requestLayerSpy).not.toHaveBeenCalled()
		await expect(hono.request('/users/42')).rejects.toBe(failure)
	})

	test('awaits an asynchronous error handler and preserves its context headers', async () => {
		const { dispatch, hono, requestLayerSpy } = fixture({
			errorHandler: async (error, ctx) => {
				await Promise.resolve()
				ctx.header('x-error', error.message)
				return ctx.text('recovered', 503)
			},
			routeHandler: () => {
				throw new Error('route failed')
			},
		})

		const result = await snapshot(
			dispatch(new Request('http://localhost/users/42'), {})
		)
		expect(requestLayerSpy).not.toHaveBeenCalled()
		expect(result).toEqual(await snapshot(hono.request('/users/42')))
		expect(result).toMatchObject({ body: 'recovered', status: 503 })
		expect(result.headers).toContainEqual(['x-error', 'route failed'])
	})

	test('re-enters the error handler when it throws on the route layer', async () => {
		function makeFixture() {
			let calls = 0
			return fixture({
				errorHandler: (error, ctx) => {
					calls += 1
					if (calls === 1) throw new Error('handler failed')
					return ctx.json({ calls, error: error.message }, 500)
				},
				routeHandler: () => {
					throw new Error('route failed')
				},
			})
		}
		const { dispatch, requestLayerSpy } = makeFixture()
		const { hono } = makeFixture()
		const result = await snapshot(
			dispatch(new Request('http://localhost/users/42'), {})
		)

		expect(requestLayerSpy).not.toHaveBeenCalled()
		expect(result).toEqual(await snapshot(hono.request('/users/42')))
		expect(JSON.parse(result.body)).toEqual({
			calls: 2,
			error: 'handler failed',
		})
	})

	test('routes a not-found handler rejection through the same error handler', async () => {
		const { dispatch, hono, requestLayerSpy } = fixture({
			errorHandler: (error, ctx) => ctx.text(error.message, 500),
			notFoundHandler: () => Promise.reject(new Error('not-found failed')),
			routeHandler: async (_req, _ctx, next) => {
				await next?.()
			},
		})
		const result = await snapshot(
			dispatch(new Request('http://localhost/users/42'), {})
		)

		expect(requestLayerSpy).not.toHaveBeenCalled()
		expect(result).toEqual(await snapshot(hono.request('/users/42')))
		expect(result).toMatchObject({ body: 'not-found failed', status: 500 })
	})

	test('handles request security-hook failures at the request layer', async () => {
		const routeHandler = vi.fn((_req, ctx) => ctx.text('route'))
		const { dispatch, hono, options, requestLayerSpy } = fixture({
			errorHandler: (error, ctx) =>
				ctx.json(
					{ message: error.message, routeIndex: ctx.req.routeIndex },
					403
				),
			routeHandler,
		})
		const securityHook = () => {
			throw new Error('blocked')
		}
		// The request layer and the fast path intentionally share this mutable hook list.
		;(options.securityHooks as unknown[]).push(securityHook)

		const fast = await snapshot(
			dispatch(new Request('http://localhost/users/42'), {})
		)
		expect(requestLayerSpy).not.toHaveBeenCalled()
		expect(fast).toEqual(await snapshot(hono.request('/users/42')))
		expect(fast).toMatchObject({
			body: '{"message":"blocked","routeIndex":0}',
			status: 403,
		})
		expect(routeHandler).not.toHaveBeenCalled()
	})
})

describe('BunFastPath fallback selection', () => {
	test.each([
		'HEAD',
		'POST',
		'PUT',
		'OPTIONS',
	])('passes %s to Hono unchanged', async method => {
		const { dispatch, requestLayerSpy } = fixture({ method: 'all' })
		const request = new Request('http://localhost/users/42', { method })
		const server = {}

		const result = await dispatch(request, server)
		expect(result.status).toBe(200)
		expect(requestLayerSpy).toHaveBeenCalledOnce()
		expect(requestLayerSpy.mock.calls[0]?.[0].req.raw).toBe(request)
		expect(requestLayerSpy.mock.calls[0]?.[0].env).toBe(server)
	})

	test.each([
		{
			name: 'path middleware',
			beforeRoute: ({ hono }: FastPathOptions) => {
				hono.use('/users/*', async (ctx, next) => {
					ctx.header('x-middleware', 'ran')
					await next()
				})
			},
		},
		{
			name: 'catch-all middleware',
			beforeRoute: ({ hono }: FastPathOptions) => {
				hono.use(async (ctx, next) => {
					ctx.header('x-middleware', 'ran')
					await next()
				})
			},
		},
		{
			name: 'an earlier Nest route',
			beforeRoute: ({ routes }: FastPathOptions) => {
				routes.register('get', '/users/:id', (_req, ctx) => ctx.text('earlier'))
			},
		},
		{
			name: 'an explicit HEAD route',
			beforeRoute: ({ routes }: FastPathOptions) => {
				routes.register('head', '/users/:id', (_req, ctx) => ctx.text('head'))
			},
		},
	])('falls back with $name and preserves Hono behavior', async ({
		beforeRoute,
	}) => {
		const { dispatch, hono, requestLayerSpy } = fixture({ beforeRoute })
		const request = new Request('http://localhost/users/42')
		const result = await snapshot(dispatch(request, {}))

		expect(requestLayerSpy).toHaveBeenCalledOnce()
		expect(result).toEqual(await snapshot(hono.request('/users/42')))
	})

	test('falls back for a route registered directly on Hono', async () => {
		const { dispatch, hono, requestLayerSpy } = fixture()
		hono.get('/direct', ctx => ctx.text('direct'))

		expect(
			await snapshot(dispatch(new Request('http://localhost/direct'), {}))
		).toMatchObject({ body: 'direct', status: 200 })
		expect(requestLayerSpy).toHaveBeenCalledOnce()
	})

	test('falls back for an unmatched request', async () => {
		const { dispatch, requestLayerSpy } = fixture()

		expect(
			await snapshot(dispatch(new Request('http://localhost/missing'), {}))
		).toMatchObject({ body: 'missing', status: 404 })
		expect(requestLayerSpy).toHaveBeenCalledOnce()
	})

	test('detects catch-all middleware registered after an earlier eligibility check', () => {
		const { hono, options } = fixture()
		const fastRoutes = new FastRoutes(options)
		hono.notFound(ctx => ctx.text('missing', 404))
		expect(fastRoutes.isEnabled()).toBe(true)
		hono.use(async (_ctx, next) => next())
		expect(fastRoutes.isEnabled()).toBe(false)
	})

	test('falls back after the app replaces getPath', async () => {
		const { dispatch, hono, requestLayerSpy } = fixture()
		vi.spyOn(hono, 'getPath').mockReturnValue('/users/rewritten')

		const response = await dispatch(new Request('http://localhost/other'), {})
		expect(await response.text()).toBe('ok')
		expect(requestLayerSpy).toHaveBeenCalledOnce()
	})

	test('leaves router errors for Hono to handle', async () => {
		const { dispatch, hono, requestLayerSpy } = fixture()
		vi.spyOn(hono.router, 'match').mockImplementationOnce(() => {
			throw new Error('router changed')
		})

		const response = await dispatch(
			new Request('http://localhost/users/42'),
			{}
		)
		expect(await response.text()).toBe('ok')
		expect(requestLayerSpy).toHaveBeenCalledOnce()
	})

	test('falls back when no not-found handler was captured', async () => {
		const { hono, options, requestLayerSpy } = fixture()
		const ContextClass = getAdapterContextClass(false)
		if (!ContextClass) throw new Error('Hono context unavailable')
		const dispatch = new BunFastPath(options, ContextClass).wrapFetch(
			hono.fetch
		)

		await dispatch(new Request('http://localhost/users/42'), {})
		expect(requestLayerSpy).toHaveBeenCalledOnce()
	})

	test('passes a synthetic GET with an exposed body to Hono unchanged', async () => {
		const { dispatch, requestLayerSpy } = fixture({
			adapterOptions: { bodyLimit: false },
		})
		const request = new Request('http://localhost/users/42')
		Object.defineProperty(request, 'body', { value: new ReadableStream() })
		const server = {}

		expect(await (await dispatch(request, server)).text()).toBe('ok')
		expect(requestLayerSpy).toHaveBeenCalledOnce()
		expect(requestLayerSpy.mock.calls[0]?.[0].req.raw).toBe(request)
		expect(requestLayerSpy.mock.calls[0]?.[0].env).toBe(server)
	})
})
