import { request } from 'node:http'
import { Readable } from 'node:stream'
import type { NestApplicationOptions } from '@nestjs/common'
import type { Context } from 'hono'
import { HonoAdapter } from '../../src'
import type { Nest12ApplicationOptions } from '../../src/helpers/nest-12'
import { getNestHonoRequest } from '../../src/helpers/request'
import { getFinalizedResponse } from '../../src/helpers/response'
import { createRequestLayer } from '../../src/request/request-layer'
import type { HonoSseWritable } from '../../src/response/sse-bridge'
import { getNodeServerInternals } from '../../src/server/node-internals'
import type { ResponseCache } from '../../src/server/node-response-writer'
import { startApp } from './fixtures/minimal-nest-app'

// Only Hono fallback invokes this middleware. Fast dispatch prepares its
// adapter-owned context directly, so this observes selection without changing fetch.
vi.mock('../../src/request/request-layer', async importOriginal => {
	const actual =
		await importOriginal<typeof import('../../src/request/request-layer')>()
	return {
		...actual,
		createRequestLayer: vi.fn(
			(...args: Parameters<typeof actual.createRequestLayer>) =>
				vi.fn(actual.createRequestLayer(...args))
		),
	}
})

function getRequestLayerSpy() {
	const result = vi.mocked(createRequestLayer).mock.results.at(-1)
	if (!result || result.type !== 'return')
		throw new Error('Missing request layer')
	return vi.mocked(result.value)
}

const isBunRuntime = 'Bun' in globalThis
const LOOPBACK = /127\.0\.0\.1$/

// A fixed Host also makes ephemeral ports above node-server's verbatim range
// eligible, so these tests cannot silently exercise only the fallback.
function fetchLocal(url: string, init: RequestInit = {}) {
	return new Promise<Response>((resolve, reject) => {
		const client = request(
			url,
			{
				method: init.method,
				headers: {
					host: 'localhost',
					...Object.fromEntries(new Headers(init.headers)),
				},
				signal: init.signal ?? undefined,
			},
			incoming => {
				resolve(
					new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
						status: incoming.statusCode,
						headers: new Headers(
							Object.entries(incoming.headers).flatMap(([key, value]) =>
								value === undefined
									? []
									: [[key, Array.isArray(value) ? value.join(', ') : value]]
							)
						),
					})
				)
			}
		)
		client.on('error', reject)
		client.end()
	})
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('fast path HTTP integration', () => {
	test.each([
		'get',
		'all',
		'post',
	] as const)('honors a fetch auth wrapper installed before server creation for %s', async method => {
		const adapter = new HonoAdapter()
		const originalFetch = adapter.hono.fetch
		const fetchSpy = vi
			.spyOn(adapter.hono, 'fetch')
			.mockImplementation((req, ...args) =>
				req.headers.has('authorization')
					? originalFetch(req, ...args)
					: new Response('unauthorized', { status: 401 })
			)
		const app = await startApp(adapter, {}, () => {
			adapter[method]('/protected', (req, ctx) =>
				ctx.json({
					served: true,
					ownHeaders: Object.hasOwn(req, 'headers'),
				})
			)
		})
		try {
			const init = { method: method === 'post' ? 'POST' : 'GET' }
			const blocked = await fetchLocal(`${app.baseUrl}/protected`, init)
			expect(blocked.status).toBe(401)
			await expect(blocked.text()).resolves.toBe('unauthorized')
			const allowed = await fetchLocal(`${app.baseUrl}/protected`, {
				...init,
				headers: { authorization: 'Bearer test' },
			})
			expect(allowed.status).toBe(200)
			await expect(allowed.json()).resolves.toEqual({
				served: true,
				ownHeaders: true,
			})
			expect(fetchSpy).toHaveBeenCalledTimes(2)
		} finally {
			await app.close()
		}
	})

	test.each([
		'get',
		'all',
		'post',
	] as const)('ignores a fetch replacement installed after startup for %s', async method => {
		const adapter = new HonoAdapter()
		const requestLayerSpy = getRequestLayerSpy()
		const app = await startApp(adapter, {}, () => {
			adapter[method]('/captured', (req, ctx) =>
				ctx.json({
					served: true,
					ownHeaders: Object.hasOwn(req, 'headers'),
				})
			)
		})
		const fetchSpy = vi
			.spyOn(adapter.hono, 'fetch')
			.mockReturnValue(new Response('replacement', { status: 418 }))
		try {
			const response = await fetchLocal(`${app.baseUrl}/captured`, {
				method: method === 'post' ? 'POST' : 'GET',
			})
			expect(response.status).toBe(200)
			await expect(response.json()).resolves.toEqual({
				served: true,
				ownHeaders: method === 'post',
			})
			expect(fetchSpy).not.toHaveBeenCalled()
			expect(requestLayerSpy).toHaveBeenCalledTimes(method === 'post' ? 1 : 0)
		} finally {
			await app.close()
		}
	})

	test.each([
		'get',
		'all',
	] as const)('serves a plain %s route without hono.fetch and agrees with direct dispatch', async method => {
		const adapter = new HonoAdapter()
		const requestLayerSpy = getRequestLayerSpy()
		const app = await startApp(adapter, {}, () => {
			adapter[method]('/plain/:id', (req, ctx) => {
				const { header, param } = req
				return ctx.json({
					id: param('id'),
					header: header('x-test'),
					query: getNestHonoRequest(req).query,
				})
			})
		})
		try {
			const response = await fetchLocal(`${app.baseUrl}/plain/42?tag=a&tag=b`, {
				headers: { 'x-test': 'fast' },
			})
			expect(response.status).toBe(200)
			const expected = {
				id: '42',
				header: 'fast',
				query: { tag: ['a', 'b'] },
			}
			await expect(response.json()).resolves.toEqual(expected)
			expect(requestLayerSpy).not.toHaveBeenCalled()
			const direct = await adapter.hono.request('/plain/42?tag=a&tag=b', {
				headers: { 'x-test': 'fast' },
			})
			await expect(direct.json()).resolves.toEqual(expected)
		} finally {
			await app.close()
		}
	})

	test.each([
		['HEAD', '/returns/string', 200, ''],
		['HEAD', '/resource/head', 200, ''],
		['POST', '/echo', 201, '{}'],
		['GET', '/middleware/included', 200, '{"middlewareRan":true}'],
		['GET', '/absent', 404, undefined],
	] as const)('falls back for %s %s', async (method, path, status, body) => {
		const adapter = new HonoAdapter()
		const requestLayerSpy = getRequestLayerSpy()
		const app = await startApp(adapter)
		try {
			const response = await fetchLocal(`${app.baseUrl}${path}`, { method })
			expect(response.status).toBe(status)
			if (body === undefined) await response.arrayBuffer()
			else await expect(response.text()).resolves.toBe(body)
			expect(requestLayerSpy).toHaveBeenCalledOnce()
		} finally {
			await app.close()
		}
	})

	test.each([
		'cors',
		'app.use',
		'hono.use',
		'getPath',
		'closing',
	] as const)('disables fast dispatch with %s', async reason => {
		const adapter = new HonoAdapter()
		const requestLayerSpy = getRequestLayerSpy()
		const app = await startApp(
			adapter,
			reason === 'closing'
				? ({ return503OnClosing: true } as Nest12ApplicationOptions &
						NestApplicationOptions)
				: {},
			nest => {
				if (reason === 'cors') nest.enableCors()
				if (reason === 'app.use')
					nest.use((_req: unknown, _res: unknown, next: () => void) => next())
				if (reason === 'hono.use') adapter.hono.use((_ctx, next) => next())
				if (reason === 'getPath') {
					const getPath = adapter.hono.getPath
					Object.defineProperty(adapter.hono, 'getPath', {
						value: (req: Request) => getPath(req),
					})
				}
			}
		)
		try {
			const response = await fetchLocal(`${app.baseUrl}/returns/string`)
			await expect(response.text()).resolves.toBe('plain string')
			expect(requestLayerSpy).toHaveBeenCalledOnce()
		} finally {
			await app.close()
		}
	})

	test.each([
		false,
		true,
	])('preserves params, headers, IP and socket on fast and middleware paths, trustProxy=%s', async trustProxy => {
		const adapter = new HonoAdapter({ trustProxy })
		const requestLayerSpy = getRequestLayerSpy()
		const ownFields: boolean[] = []
		const app = await startApp(adapter, {}, () => {
			adapter.hono.use('/slow/*', (_ctx, next) => next())
			adapter.get('/:mode/:file{.json}', (req, ctx) => {
				const nestReq = getNestHonoRequest(req)
				ownFields.push(Object.hasOwn(req, 'headers'))
				return ctx.json({
					params: nestReq.params,
					header: nestReq.headers?.['x-test'],
					ip: nestReq.ip,
					socketIp: (nestReq.socket as { remoteAddress?: string } | undefined)
						?.remoteAddress,
				})
			})
		})
		try {
			for (const mode of ['fast', 'slow']) {
				const response = await fetchLocal(
					`${app.baseUrl}/${mode}/report.json`,
					{
						headers: {
							'x-test': 'value',
							'x-forwarded-for': '203.0.113.1, 10.0.0.2',
						},
					}
				)
				expect(response.status).toBe(200)
				await expect(response.json()).resolves.toEqual({
					params: { mode, file: 'report' },
					header: 'value',
					ip: trustProxy ? '10.0.0.2' : expect.stringMatching(LOOPBACK),
					...(isBunRuntime
						? {}
						: { socketIp: expect.stringMatching(LOOPBACK) }),
				})
			}
			expect(ownFields).toEqual([false, true])
			expect(requestLayerSpy).toHaveBeenCalledOnce()
		} finally {
			await app.close()
		}
	})

	test('preserves response mutations after reading ctx.res and isolates later JSON replies', async () => {
		const adapter = new HonoAdapter()
		const requestLayerSpy = getRequestLayerSpy()
		const app = await startApp(adapter, {}, () => {
			adapter.get('/mutated', (_req, ctx) => {
				ctx.res.headers.set('x-read-tracking', 'kept')
				ctx.status(202)
				adapter.reply(ctx, { value: 'long response' })
				return
			})
			adapter.get('/clean', (_req, ctx) => {
				adapter.reply(ctx, { ok: true })
				return
			})
		})
		try {
			const mutated = await fetchLocal(`${app.baseUrl}/mutated`)
			expect(mutated.status).toBe(202)
			expect(mutated.headers.get('x-read-tracking')).toBe('kept')
			await expect(mutated.json()).resolves.toEqual({ value: 'long response' })
			for (let count = 0; count < 2; count += 1) {
				const clean = await fetchLocal(`${app.baseUrl}/clean`)
				expect(clean.status).toBe(200)
				expect(clean.headers.get('x-read-tracking')).toBeNull()
				expect(clean.headers.get('content-type')).toBe('application/json')
				await expect(clean.json()).resolves.toEqual({ ok: true })
			}
			expect(requestLayerSpy).not.toHaveBeenCalled()
		} finally {
			await app.close()
		}
	})

	test.each([
		'throw',
		'reject',
		'next',
		'next-twice',
	])('preserves %s semantics over fast HTTP and Hono fallback', async action => {
		const adapter = new HonoAdapter()
		const requestLayerSpy = getRequestLayerSpy()
		const app = await startApp(adapter, {}, () => {
			adapter.get('/semantics', async (_req, _ctx, next) => {
				if (action === 'throw') throw new Error('route failed')
				if (action === 'reject') await Promise.reject(new Error('route failed'))
				await next()
				if (action === 'next-twice') await next()
			})
		})
		adapter.hono.onError((error, ctx) =>
			ctx.json({ error: error.message }, 500)
		)
		try {
			const fast = await fetchLocal(`${app.baseUrl}/semantics`)
			const body = await fast.json()
			expect(requestLayerSpy).not.toHaveBeenCalled()
			const fallback = await adapter.hono.request('/semantics')
			expect(fast.status).toBe(action.startsWith('next') ? 404 : 500)
			expect(fast.status).toBe(fallback.status)
			expect(body).toEqual(await fallback.json())
		} finally {
			await app.close()
		}
	})

	test.skipIf(isBunRuntime)(
		'keeps Node env and per-response JSON headers plain and independent',
		async () => {
			const adapter = new HonoAdapter()
			const requestLayerSpy = getRequestLayerSpy()
			const headerObjects: object[] = []
			const app = await startApp(adapter, {}, () => {
				adapter.get('/records/:id', (req, ctx) => {
					expect(Object.getPrototypeOf(ctx.env)).toBe(Object.prototype)
					expect(Object.keys(ctx.env)).toEqual(['incoming', 'outgoing'])
					expect(ctx.env.incoming.url).toBe(`/records/${req.param('id')}`)
					expect(ctx.env.outgoing.req).toBe(ctx.env.incoming)
					expect(ctx.env.leaked).toBeUndefined()
					ctx.env.leaked = true
					adapter.reply(ctx, { id: req.param('id') })
					const key = getNodeServerInternals()?.responseCacheKey
					expect(key).toBeDefined()
					const response = getFinalizedResponse(ctx)
					const cache = (response as unknown as Record<symbol, ResponseCache>)[
						key as symbol
					]
					expect(Object.getPrototypeOf(cache?.[2])).toBe(Object.prototype)
					expect(cache?.[2]).toEqual({ 'content-type': 'application/json' })
					headerObjects.push(cache?.[2] as object)
					return
				})
			})
			try {
				for (const id of ['long-value', 'x']) {
					const response = await fetchLocal(`${app.baseUrl}/records/${id}`)
					expect(response.status).toBe(200)
					const body = await response.text()
					expect(body).toBe(JSON.stringify({ id }))
					expect(response.headers.get('content-length')).toBe(
						String(Buffer.byteLength(body))
					)
				}
				expect(headerObjects).toHaveLength(2)
				expect(headerObjects[0]).not.toBe(headerObjects[1])
				expect(requestLayerSpy).not.toHaveBeenCalled()
			} finally {
				await app.close()
			}
		}
	)

	test('aborts a pending fast request on disconnect and leaves completed requests live', async () => {
		const adapter = new HonoAdapter()
		const requestLayerSpy = getRequestLayerSpy()
		let pendingSignal: AbortSignal | undefined
		let completedSignal: AbortSignal | undefined
		let release: () => void = () => undefined
		const gate = new Promise<void>(resolve => {
			release = resolve
		})
		const app = await startApp(adapter, {}, () => {
			adapter.get('/pending', async (req, ctx) => {
				pendingSignal = req.raw.signal
				await gate
				return ctx.text('released')
			})
			adapter.get('/complete', (req, ctx) => {
				completedSignal = req.raw.signal
				return ctx.text('complete')
			})
		})
		const client = request(`${app.baseUrl}/pending`, {
			headers: { host: 'localhost' },
		})
		client.on('error', () => undefined)
		client.end()
		try {
			await expect.poll(() => pendingSignal).toBeDefined()
			expect(pendingSignal?.aborted).toBe(false)
			client.destroy()
			await expect.poll(() => pendingSignal?.aborted).toBe(true)
			release()
			const response = await fetchLocal(`${app.baseUrl}/complete`)
			await expect(response.text()).resolves.toBe('complete')
			expect(completedSignal?.aborted).toBe(false)
			expect(requestLayerSpy).not.toHaveBeenCalled()
		} finally {
			client.destroy()
			release()
			await app.close()
		}
	})

	test('streams SSE and closes its listeners on fast-path disconnect', async () => {
		const adapter = new HonoAdapter()
		const requestLayerSpy = getRequestLayerSpy()
		const closeSpy = vi.fn()
		let stream: HonoSseWritable | undefined
		const app = await startApp(adapter, {}, () => {
			adapter.get('/fast-events', (req, ctx) => {
				;(
					req as unknown as {
						on: (event: string, listener: () => void) => void
					}
				).on('close', closeSpy)
				stream = (ctx as Context & { raw: HonoSseWritable }).raw
				stream.writeHead(200, { 'content-type': 'text/event-stream' })
				stream.write('data: ready\n\n')
			})
		})
		const controller = new AbortController()
		try {
			const response = await fetchLocal(`${app.baseUrl}/fast-events`, {
				signal: controller.signal,
			})
			expect(response.headers.get('content-type')).toBe('text/event-stream')
			const first = await response.body?.getReader().read()
			expect(new TextDecoder().decode(first?.value)).toBe('data: ready\n\n')
			expect(requestLayerSpy).not.toHaveBeenCalled()
			controller.abort()
			await expect.poll(() => closeSpy.mock.calls.length).toBe(1)
			await expect.poll(() => stream?.destroyed).toBe(true)
		} finally {
			controller.abort()
			stream?.destroy()
			await app.close()
		}
	})
})
