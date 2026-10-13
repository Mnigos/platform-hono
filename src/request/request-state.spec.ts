import { EventEmitter } from 'node:events'
import { RequestMethod } from '@nestjs/common'
import { getNestHonoRequest } from '../helpers/request'
import { HonoAdapter } from '../hono-adapter'
import { getRequestState } from './request-state'

describe('request state caching', () => {
	test('reuses query, headers and state across middleware while preserving edits', async () => {
		const adapter = new HonoAdapter({ trustProxy: true })
		let firstState: ReturnType<typeof getRequestState> | undefined
		let firstHeaders: unknown
		let firstQuery: unknown
		adapter.use(async (req, ctx, next) => {
			const request = getNestHonoRequest(req)
			firstState = getRequestState(ctx, { trustProxy: true })
			firstHeaders = request.headers
			firstQuery = request.query
			if (!request.headers) throw new Error('Expected request headers')
			request.headers.changed = 'middleware'
			;(request.query as Record<string, string>).changed = 'middleware'
			await next()
			return ctx.res
		})
		adapter.get('/state/:id', (req, ctx) => {
			const request = getNestHonoRequest(req)
			expect(getRequestState(ctx, { trustProxy: true })).toBe(firstState)
			expect(request.headers).toBe(firstHeaders)
			expect(request.query).toBe(firstQuery)
			expect(request.headers?.changed).toBe('middleware')
			expect(request.query).toMatchObject({ changed: 'middleware' })
			expect(request.ip).toBe('10.0.0.1')
			return ctx.text('ok')
		})
		const response = await adapter.hono.request('/state/1?q=value', {
			headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1' },
		})
		expect(response.status).toBe(200)
	})

	test('preserves a Nest middleware parameter mutation in the handler', async () => {
		const adapter = new HonoAdapter()
		const register = await adapter.createMiddlewareFactory(RequestMethod.GET)
		register(
			'/state/:file{.json}',
			(req: unknown, _res: unknown, next: () => void) => {
				const request = req as { params: Record<string, string> }
				request.params.file = 'changed'
				next()
			}
		)
		adapter.get('/state/:file{.json}', (req, ctx) =>
			ctx.json(getNestHonoRequest(req).params)
		)
		const response = await adapter.hono.request('/state/report.json')
		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({ file: 'changed' })
	})

	test('keeps native globals inside overlapping Node handlers and after serialization throws', async () => {
		const adapter = new HonoAdapter({ runtime: 'node' })
		const nativeResponse = globalThis.Response
		const nativeRequest = globalThis.Request
		const socket = Object.assign(new EventEmitter(), {
			remoteAddress: '127.0.0.1',
		})
		const env = { incoming: { headers: {}, socket } }
		let release: () => void = () => undefined
		let enter: () => void = () => undefined
		const entered = new Promise<void>(resolve => {
			enter = resolve
		})
		const released = new Promise<void>(resolve => {
			release = resolve
		})
		const observed: boolean[] = []
		const observe = () =>
			observed.push(
				globalThis.Response === nativeResponse,
				globalThis.Request === nativeRequest
			)
		adapter.get('/await', async (_req, ctx) => {
			observe()
			enter()
			await released
			observe()
			adapter.reply(ctx, { ok: true })
			observe()
		})
		adapter.get('/throw', (_req, ctx) => {
			observe()
			expect(() => adapter.reply(ctx, { invalid: 1n })).toThrow()
			observe()
			return ctx.text('caught')
		})
		observe()
		const pending = adapter.hono.request('/await', {}, env)
		try {
			await entered
			expect((await adapter.hono.request('/throw', {}, env)).status).toBe(200)
			observe()
		} finally {
			release()
		}
		expect((await pending).status).toBe(200)
		expect(observed).toEqual(new Array(14).fill(true))
		expect(globalThis.Response).toBe(nativeResponse)
	})
})
