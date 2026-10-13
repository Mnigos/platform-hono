import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CustomOrigin } from '@nestjs/common/interfaces/external/cors-options.interface'
import { HonoAdapter } from '../../src'
import { startApp } from './fixtures/minimal-nest-app'

function requestPath(baseUrl: string, path: string) {
	return new Promise<{ body: string; status: number | undefined }>(
		(resolve, reject) => {
			const req = request(baseUrl, { path }, response => {
				const chunks: Buffer[] = []
				response.on('data', chunk => chunks.push(Buffer.from(chunk)))
				response.on('error', reject)
				response.on('end', () =>
					resolve({
						body: Buffer.concat(chunks).toString(),
						status: response.statusCode,
					})
				)
			})
			req.on('error', reject)
			req.end()
		}
	)
}

describe('reply helpers over HTTP', () => {
	test('preserves native globals across awaited handlers, concurrent replies and serialization errors on Node', async () => {
		const nativeResponse = globalThis.Response
		const nativeRequest = globalThis.Request
		let enter: () => void = () => undefined
		let release: () => void = () => undefined
		const entered = new Promise<void>(resolve => {
			enter = resolve
		})
		const released = new Promise<void>(resolve => {
			release = resolve
		})
		const observations: boolean[] = []
		const observe = () => {
			observations.push(
				globalThis.Response === nativeResponse,
				globalThis.Request === nativeRequest,
				new Response('native').constructor === nativeResponse
			)
		}
		const adapter = new HonoAdapter({ runtime: 'node' })
		const app = await startApp(adapter, {}, () => {
			adapter.get('/native/await', async (_req, ctx) => {
				observe()
				enter()
				await released
				observe()
				adapter.reply(ctx, new Response('native body', { status: 202 }))
				observe()
			})
			adapter.get('/native/serialization-error', (_req, ctx) => {
				observe()
				try {
					adapter.reply(ctx, { unserializable: 1n })
				} finally {
					observe()
				}
			})
		})
		observe()
		const waitingResponse = fetch(`${app.baseUrl}/native/await`)

		try {
			await entered
			const [normal, handlerError, serializationError] = await Promise.all([
				fetch(`${app.baseUrl}/returns/string`),
				fetch(`${app.baseUrl}/fail`),
				fetch(`${app.baseUrl}/native/serialization-error`),
			])
			expect(normal.status).toBe(200)
			await expect(normal.text()).resolves.toBe('plain string')
			expect(handlerError.status).toBe(400)
			await expect(handlerError.json()).resolves.toMatchObject({
				message: 'Nope',
			})
			expect(serializationError.status).toBe(500)
			await expect(serializationError.json()).resolves.toMatchObject({
				statusCode: 500,
			})
			observe()
			release()
			const response = await waitingResponse
			expect(response.status).toBe(202)
			await expect(response.text()).resolves.toBe('native body')
			expect(response.constructor).toBe(nativeResponse)
			expect(observations).toHaveLength(21)
			expect(observations.every(Boolean)).toBe(true)
		} finally {
			release()
			await waitingResponse
				.then(response => response.body?.cancel())
				.catch(() => undefined)
			await app.close()
		}
		expect(globalThis.Response).toBe(nativeResponse)
		expect(globalThis.Request).toBe(nativeRequest)
	})

	test.each([
		['/returns/string', 'text/plain', 'plain string'],
		['/returns/number', 'text/plain', '42'],
		['/returns/array', 'application/json', '["one","two"]'],
		['/returns/buffer', 'application/octet-stream', 'direct buffer'],
		['/returns/problem', 'application/problem+json', '{"detail":"problem"}'],
	])('infers or preserves the content type for %s', async (path, contentType, body) => {
		const app = await startApp()
		try {
			const response = await fetch(`${app.baseUrl}${path}`)
			expect(response.status).toBe(200)
			expect(response.headers.get('content-type')?.split(';')[0]).toBe(
				contentType
			)
			await expect(response.text()).resolves.toBe(body)
		} finally {
			await app.close()
		}
	})

	test.each([
		['/returns/problem', 200, 'application/problem+json'],
		['/filtered-fail', 422, 'application/json'],
	])('returns HEAD metadata without a body for %s', async (path, status, contentType) => {
		const app = await startApp()
		try {
			const response = await fetch(`${app.baseUrl}${path}`, { method: 'HEAD' })
			expect(response.status).toBe(status)
			expect(response.headers.get('content-type')?.split(';')[0]).toBe(
				contentType
			)
			await expect(response.text()).resolves.toBe('')
		} finally {
			await app.close()
		}
	})

	test('returns StreamableFile HEAD metadata without crashing the process', async () => {
		const app = await startApp()
		try {
			const response = await fetch(`${app.baseUrl}/download/buffer`, {
				method: 'HEAD',
			})
			expect(response.status).toBe(200)
			expect(response.headers.get('content-type')).toBe('text/plain')
			await expect(response.text()).resolves.toBe('')
		} finally {
			await app.close()
		}
	})

	test('returns an empty body for the HttpCode 204 controller', async () => {
		const app = await startApp()
		try {
			const response = await fetch(`${app.baseUrl}/resource`, {
				method: 'OPTIONS',
			})
			expect(response.status).toBe(204)
			await expect(response.text()).resolves.toBe('')
		} finally {
			await app.close()
		}
	})
})

describe('static assets and CORS over HTTP', () => {
	test('normalizes the static prefix and rejects duplicate separators and traversal', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'hono-static-'))
		const root = join(directory, 'public')
		await mkdir(root)
		await writeFile(join(root, 'asset.txt'), 'public asset')
		await writeFile(join(directory, 'secret.txt'), 'private asset')
		let app: Awaited<ReturnType<typeof startApp>> | undefined
		try {
			app = await startApp(new HonoAdapter(), {}, nestApp => {
				nestApp.useStaticAssets(root, { prefix: '//assets//' })
			})
			const response = await fetch(`${app.baseUrl}/assets/asset.txt`)
			expect(response.status).toBe(200)
			await expect(response.text()).resolves.toBe('public asset')
			const head = await fetch(`${app.baseUrl}/assets/asset.txt`, {
				method: 'HEAD',
			})
			expect(head.status).toBe(200)
			expect(head.headers.get('content-length')).toBe('12')
			await expect(head.text()).resolves.toBe('')

			// node:http preserves the raw path; fetch would normalize ../ before sending.
			for (const path of [
				'/assets//asset.txt',
				'/assets/../secret.txt',
				'/assets/%2e%2e/secret.txt',
				'/assets/..%2fsecret.txt',
				'/assets-sibling/asset.txt',
			]) {
				const rejected = await requestPath(app.baseUrl, path)
				expect(rejected.status, path).toBe(404)
				expect(rejected.body, path).not.toContain('private asset')
			}
		} finally {
			await app?.close()
			await rm(directory, { recursive: true, force: true })
		}
	})

	test('awaits an origin callback and preserves credentialed preflight options', async () => {
		const origins: (string | undefined)[] = []
		const app = await startApp(new HonoAdapter(), {}, nestApp => {
			nestApp.enableCors({
				credentials: true,
				exposedHeaders: ['x-download'],
				maxAge: 600,
				methods: ['GET', 'POST'],
				optionsSuccessStatus: 200,
				origin: (
					origin: string | undefined,
					callback: Parameters<CustomOrigin>[1]
				) => {
					origins.push(origin)
					queueMicrotask(() =>
						callback(null, origin === 'https://allowed.test')
					)
				},
			})
		})

		try {
			const allowed = await fetch(`${app.baseUrl}/echo`, {
				headers: {
					'access-control-request-headers': 'content-type,x-token',
					'access-control-request-method': 'POST',
					origin: 'https://allowed.test',
				},
				method: 'OPTIONS',
			})
			expect(allowed.status).toBe(200)
			expect(allowed.headers.get('access-control-allow-origin')).toBe(
				'https://allowed.test'
			)
			expect(allowed.headers.get('access-control-allow-credentials')).toBe(
				'true'
			)
			expect(allowed.headers.get('access-control-allow-methods')).toBe(
				'GET,POST'
			)
			expect(allowed.headers.get('access-control-allow-headers')).toBe(
				'content-type,x-token'
			)
			expect(allowed.headers.get('access-control-max-age')).toBe('600')
			expect(allowed.headers.get('vary')).toContain('Origin')
			await expect(allowed.text()).resolves.toBe('')

			const actual = await fetch(`${app.baseUrl}/returns/string`, {
				headers: { origin: 'https://allowed.test' },
			})
			expect(actual.headers.get('access-control-expose-headers')).toBe(
				'x-download'
			)
			expect(actual.headers.get('access-control-allow-credentials')).toBe(
				'true'
			)
			await expect(actual.text()).resolves.toBe('plain string')

			const denied = await fetch(`${app.baseUrl}/resource`, {
				headers: {
					origin: 'https://denied.test',
					'access-control-request-method': 'GET',
				},
				method: 'OPTIONS',
			})
			expect(denied.status).toBe(204)
			expect(denied.headers.has('access-control-allow-origin')).toBe(false)
			expect(denied.headers.has('access-control-allow-credentials')).toBe(false)
			await expect(denied.text()).resolves.toBe('')
			await (await fetch(`${app.baseUrl}/returns/string`)).text()
			expect(origins).toEqual([
				'https://allowed.test',
				'https://allowed.test',
				'https://denied.test',
				undefined,
			])
		} finally {
			await app.close()
		}
	})

	test('continues credentialed preflight through the OPTIONS route', async () => {
		const adapter = new HonoAdapter()
		const app = await startApp(adapter, {}, nestApp => {
			nestApp.enableCors({
				credentials: true,
				origin: true,
				preflightContinue: true,
			})
			adapter.options('/preflight', (_req, ctx) => {
				adapter.setHeader(ctx, 'x-options-handler', 'yes')
				adapter.reply(ctx, 'options response', 202)
			})
		})
		try {
			const response = await fetch(`${app.baseUrl}/preflight`, {
				headers: {
					origin: 'https://allowed.test',
					'access-control-request-method': 'POST',
				},
				method: 'OPTIONS',
			})
			expect(response.status).toBe(202)
			expect(response.headers.get('x-options-handler')).toBe('yes')
			expect(response.headers.get('access-control-allow-origin')).toBe(
				'https://allowed.test'
			)
			expect(response.headers.get('access-control-allow-credentials')).toBe(
				'true'
			)
			await expect(response.text()).resolves.toBe('options response')
		} finally {
			await app.close()
		}
	})
})
