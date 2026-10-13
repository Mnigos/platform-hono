import { type Context, Hono } from 'hono'
import { HonoAdapter } from '../../src'
import { startApp } from './fixtures/minimal-nest-app'

interface GlobalMiddlewareRequest {
	headers?: Record<string, string>
	query?: unknown
}

interface MountedAppResult {
	app: Awaited<ReturnType<typeof startApp>>
	nestMiddlewareQueries: unknown[]
}

async function startMountedApp(): Promise<MountedAppResult> {
	const adapter = new HonoAdapter()
	const nestMiddlewareQueries: unknown[] = []
	const app = await startApp(adapter, {}, async nestApp => {
		nestApp.use(
			(req: GlobalMiddlewareRequest, _res: Context, next: () => void) => {
				nestMiddlewareQueries.push(req.query)
				next()
			}
		)
		await nestApp.init()
		const subApp = new Hono()
		subApp.get('/items/:id', ctx =>
			ctx.json({
				header: ctx.req.header('x-test') ?? null,
				id: ctx.req.param('id'),
				params: ctx.req.param(),
				queries: ctx.req.queries('tag') ?? null,
				query: ctx.req.query('name') ?? null,
			})
		)
		subApp.post('/items', async ctx =>
			ctx.json({ body: await ctx.req.json(), query: ctx.req.query() })
		)
		adapter.getInstance().route('/mounted', subApp)
	})
	return { app, nestMiddlewareQueries }
}

describe('Hono routes mounted on the adapter instance', () => {
	test('keep Hono request methods after Nest global middleware ran', async () => {
		const { app, nestMiddlewareQueries } = await startMountedApp()

		try {
			const response = await fetch(
				`${app.baseUrl}/mounted/items/42?name=hono&tag=a&tag=b`,
				{ headers: { 'x-test': 'mounted' } }
			)

			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({
				header: 'mounted',
				id: '42',
				params: { id: '42' },
				queries: ['a', 'b'],
				query: 'hono',
			})
			expect(nestMiddlewareQueries).toEqual([{ name: 'hono', tag: ['a', 'b'] }])
		} finally {
			await app.close()
		}
	})

	test('read the parsed JSON body and query after the adapter body parser', async () => {
		const { app } = await startMountedApp()

		try {
			const response = await fetch(`${app.baseUrl}/mounted/items?page=2`, {
				body: JSON.stringify({ ok: true }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			})

			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({
				body: { ok: true },
				query: { page: '2' },
			})
		} finally {
			await app.close()
		}
	})

	test('keep Nest controllers on the Express-style request view', async () => {
		const { app } = await startMountedApp()

		try {
			const response = await fetch(`${app.baseUrl}/hello/7?q=nest`, {
				headers: { 'x-test': 'nest' },
			})

			expect(await response.json()).toEqual({
				baseUrl: '/hello/7',
				header: 'nest',
				id: '7',
				query: 'nest',
			})
		} finally {
			await app.close()
		}
	})
})
