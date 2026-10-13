import type { Context } from 'hono'
import { HonoAdapter } from '../../src'
import { getRequestState } from '../../src/request/request-state'
import type { HonoSseWritable } from '../../src/response/sse-bridge'
import { startApp } from './fixtures/minimal-nest-app'

interface SseContext extends Context {
	raw: HonoSseWritable
}

interface CloseRequest {
	on: (event: 'close', listener: () => void) => unknown
}

describe('SSE lifecycle integration', () => {
	test.each([
		['/events/accepted', 'GET', 202],
		['/events/accepted', 'HEAD', 202],
		['/events', 'GET', 200],
		['/events', 'HEAD', 200],
	] as const)('preserves the SSE status for %s on %s', async (path, method, status) => {
		const app = await startApp()
		try {
			const response = await fetch(`${app.baseUrl}${path}`, { method })
			expect(response.status).toBe(status)
			if (method === 'HEAD') await expect(response.text()).resolves.toBe('')
			else {
				expect(response.headers.get('content-type')).toContain(
					'text/event-stream'
				)
				const body = await response.text()
				expect(body).toContain('data: {"hello":"one"}')
				expect(body).toContain('data: two')
			}
		} finally {
			await app.close()
		}
	})

	test('fires each close listener once on client abort, including listeners registered later', async () => {
		const adapter = new HonoAdapter()
		const firstClose = vi.fn()
		const secondClose = vi.fn()
		let addSecondListener: (() => void) | undefined
		let stream: HonoSseWritable | undefined
		const app = await startApp(adapter, {}, () => {
			adapter.get('/close-events', (req, ctx) => {
				const request = req as unknown as CloseRequest
				request.on('close', firstClose)
				stream = (ctx as SseContext).raw
				stream.writeHead(200, { 'content-type': 'text/event-stream' })
				stream.write('data: ready\n\n')
				addSecondListener = () => {
					request.on('close', secondClose)
				}
			})
		})
		const abortController = new AbortController()

		try {
			const response = await fetch(`${app.baseUrl}/close-events`, {
				signal: abortController.signal,
			})
			const reader = response.body?.getReader()
			expect((await reader?.read())?.done).toBe(false)
			expect(addSecondListener).toBeTypeOf('function')
			addSecondListener?.()
			expect(firstClose).not.toHaveBeenCalled()
			expect(secondClose).not.toHaveBeenCalled()

			abortController.abort()
			await expect.poll(() => firstClose.mock.calls.length).toBe(1)
			await expect.poll(() => secondClose.mock.calls.length).toBe(1)
			await expect.poll(() => stream?.destroyed).toBe(true)
			expect(firstClose).toHaveBeenCalledOnce()
			expect(secondClose).toHaveBeenCalledOnce()
		} finally {
			abortController.abort()
			stream?.destroy()
			await app.close()
		}
	})

	test('does not create SSE or socket bridges for an ordinary request', async () => {
		const adapter = new HonoAdapter()
		const app = await startApp(adapter, {}, () => {
			adapter.get('/no-bridges', (_req, ctx) => {
				// The exported helper exposes allocation state without reading raw/socket accessors.
				const state = getRequestState(ctx, {})
				return ctx.json({
					socketBridgeCreated: state.socketBridge !== undefined,
					sseBridgeCreated: state.sse !== undefined,
				})
			})
		})

		try {
			const response = await fetch(`${app.baseUrl}/no-bridges`)
			expect(response.status).toBe(200)
			await expect(response.json()).resolves.toEqual({
				socketBridgeCreated: false,
				sseBridgeCreated: false,
			})
		} finally {
			await app.close()
		}
	})

	test('keeps a quiet SSE stream open for eight seconds on either runtime', async () => {
		const adapter = new HonoAdapter({ bun: { idleTimeout: 1 } })
		let timer: ReturnType<typeof setTimeout> | undefined
		let stream: HonoSseWritable | undefined
		const app = await startApp(adapter, {}, () => {
			adapter.get('/quiet-events', (_req, ctx) => {
				stream = (ctx as SseContext).raw
				stream.writeHead(200, { 'content-type': 'text/event-stream' })
				stream.write('data: ready\n\n')
				timer = setTimeout(() => stream?.end('data: late\n\n'), 8000)
			})
		})
		const abortController = new AbortController()

		try {
			const response = await fetch(`${app.baseUrl}/quiet-events`, {
				signal: abortController.signal,
			})
			expect(response.headers.get('content-type')).toBe('text/event-stream')
			await expect(response.text()).resolves.toBe(
				'data: ready\n\ndata: late\n\n'
			)
		} finally {
			clearTimeout(timer)
			abortController.abort()
			stream?.destroy()
			await app.close()
		}
	}, 15_000)
})
