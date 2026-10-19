import { get } from 'node:http'
import { HonoAdapter } from '../../src'
import { getAdapterContextClass } from '../../src/server/hono-context'
import { getNodeServerInternals } from '../../src/server/node-internals'
import { startApp } from './fixtures/minimal-nest-app'

vi.mock('../../src/server/hono-context', async importOriginal => {
	const actual =
		await importOriginal<typeof import('../../src/server/hono-context')>()
	return {
		...actual,
		getAdapterContextClass: vi.fn(actual.getAdapterContextClass),
	}
})

vi.mock('../../src/server/node-internals', async importOriginal => {
	const actual =
		await importOriginal<typeof import('../../src/server/node-internals')>()
	return {
		...actual,
		getNodeServerInternals: vi.fn(actual.getNodeServerInternals),
	}
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.clearAllMocks()
})

describe.each([
	'Hono context',
	'node-server internals',
])('startup compatibility fallback over HTTP, %s', probe => {
	test.skipIf(probe === 'node-server internals' && 'Bun' in globalThis)(
		'serves through Hono after the probe fails',
		async () => {
			if (probe === 'Hono context')
				vi.mocked(getAdapterContextClass).mockReturnValueOnce(undefined)
			else vi.mocked(getNodeServerInternals).mockReturnValueOnce(undefined)
			const adapter = new HonoAdapter()
			let ownHeaders: boolean | undefined
			const app = await startApp(adapter, {}, () => {
				adapter.get('/probe-fallback', (req, ctx) => {
					ownHeaders = Object.hasOwn(req, 'headers')
					return ctx.json({ id: req.header('x-test') })
				})
			})
			try {
				const response = await new Promise<{
					status: number | undefined
					body: string
				}>((resolve, reject) => {
					get(
						`${app.baseUrl}/probe-fallback`,
						{ headers: { host: 'localhost', 'x-test': 'fallback' } },
						incoming => {
							let body = ''
							incoming.setEncoding('utf8')
							incoming.on('data', chunk => {
								body += chunk
							})
							incoming.on('end', () =>
								resolve({ status: incoming.statusCode, body })
							)
						}
					).on('error', reject)
				})
				expect(response.status).toBe(200)
				expect(JSON.parse(response.body)).toEqual({ id: 'fallback' })
				expect(ownHeaders).toBe(true)
			} finally {
				await app.close()
			}
		}
	)
})
