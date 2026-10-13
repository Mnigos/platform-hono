import 'reflect-metadata'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PassThrough } from 'node:stream'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { Context } from 'hono'
import { HonoAdapter } from '../../src'
import { startApp } from './fixtures/minimal-nest-app'

interface SseContext extends Context {
	raw: PassThrough & {
		writeHead: (
			statusCode: number,
			headers: Record<string, string>
		) => PassThrough
	}
}

interface BunFetchInit extends RequestInit {
	tls?: { rejectUnauthorized: boolean }
}

interface ListeningServer {
	listening: boolean
}

@Module({})
class EmptyModule {}

const isBunRuntime = 'Bun' in globalThis
const BUN_IDLE_SWEEP_MS = 8000

function createSelfSignedCertificate() {
	const directory = mkdtempSync(join(tmpdir(), 'platform-hono-tls-'))
	const keyPath = join(directory, 'key.pem')
	const certPath = join(directory, 'cert.pem')
	execFileSync(
		'openssl',
		[
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			keyPath,
			'-out',
			certPath,
			'-subj',
			'/CN=localhost',
			'-days',
			'1',
		],
		{ stdio: 'ignore' }
	)
	const certificate = {
		cert: readFileSync(certPath, 'utf8'),
		key: readFileSync(keyPath, 'utf8'),
	}
	rmSync(directory, { force: true, recursive: true })
	return certificate
}

describe.runIf(isBunRuntime)('Bun runtime integration', () => {
	test('serves Nest routes through Bun.serve and reports the app URL', async () => {
		const app = await startApp()

		try {
			const server = app.adapter.getHttpServer()
			const url = await app.getUrl()

			expect(server).not.toBeInstanceOf(Server)
			expect((server as ListeningServer).listening).toBe(true)
			expect(url).toBe(app.baseUrl.replace('127.0.0.1', 'localhost'))

			const response = await fetch(`${url}/hello/7?q=bun`, {
				headers: { 'x-test': 'bun' },
			})

			expect(response.status).toBe(200)
			await expect(response.json()).resolves.toEqual({
				baseUrl: '/hello/7',
				header: 'bun',
				id: '7',
				query: 'bun',
			})
		} finally {
			await app.close()
		}
	})

	test('stops accepting requests after app.close()', async () => {
		const app = await startApp()
		const server = app.adapter.getHttpServer() as ListeningServer

		await app.close()

		expect(server.listening).toBe(false)
		await expect(fetch(`${app.baseUrl}/hello/1`)).rejects.toThrow()
	})

	test('force closes open streams when forceCloseConnections is enabled', async () => {
		const app = await startApp(new HonoAdapter(), {
			forceCloseConnections: true,
		})
		const response = await fetch(`${app.baseUrl}/events/infinite`)
		const reader = response.body?.getReader()

		await reader?.read()
		await app.close()

		await expect(
			(async () => {
				for (;;) {
					const chunk = await reader?.read()
					if (!chunk || chunk.done) return 'closed'
				}
			})()
		).rejects.toThrow()
	})

	test('keeps SSE streams open past the Bun idle timeout', async () => {
		const adapter = new HonoAdapter({ bun: { idleTimeout: 1 } })
		const app = await startApp(adapter, {}, () => {
			adapter.get('/slow-events', (_req, ctx) => {
				const stream = (ctx as SseContext).raw
				stream.writeHead(200, { 'content-type': 'text/event-stream' })
				setTimeout(() => stream.end('data: late\n\n'), BUN_IDLE_SWEEP_MS)
			})
		})

		try {
			const response = await fetch(`${app.baseUrl}/slow-events`)

			expect(response.headers.get('content-type')).toBe('text/event-stream')
			await expect(response.text()).resolves.toBe('data: late\n\n')
		} finally {
			await app.close()
		}
	}, 15_000)

	test('serves HTTPS with Nest httpsOptions', async () => {
		const app = await startApp(new HonoAdapter(), {
			httpsOptions: createSelfSignedCertificate(),
		})

		try {
			const url = await app.getUrl()
			const response = await fetch(`${url}/hello/tls?q=secure`, {
				tls: { rejectUnauthorized: false },
			} as BunFetchInit)

			expect(url.startsWith('https://localhost:')).toBe(true)
			await expect(response.json()).resolves.toMatchObject({
				id: 'tls',
				query: 'secure',
			})
		} finally {
			await app.close()
		}
	})

	test('rejects app.listen() when the port is already in use', async () => {
		const runningApp = await startApp()
		const port = Number(new URL(runningApp.baseUrl).port)
		const app = await NestFactory.create(EmptyModule, new HonoAdapter(), {
			logger: false,
		})

		try {
			await expect(app.listen(port)).rejects.toMatchObject({
				code: 'EADDRINUSE',
			})
		} finally {
			await app.close()
			await runningApp.close()
		}
	})

	test('rejects Node-only httpsOptions at setup', async () => {
		await expect(
			NestFactory.create(EmptyModule, new HonoAdapter(), {
				httpsOptions: { pfx: Buffer.from('pfx') },
				logger: false,
			})
		).rejects.toThrow(
			"HonoAdapter runtime 'bun' does not support httpsOptions: pfx"
		)
	})

	test('uses @hono/node-server when runtime node is forced', async () => {
		const app = await startApp(new HonoAdapter({ runtime: 'node' }))

		try {
			expect(app.adapter.getHttpServer()).toBeInstanceOf(Server)
			await expect(
				(await fetch(`${app.baseUrl}/returns/string`)).text()
			).resolves.toBe('plain string')
		} finally {
			await app.close()
		}
	})
})

describe.skipIf(isBunRuntime)('Bun runtime on Node.js', () => {
	test('rejects runtime bun at setup', async () => {
		await expect(
			NestFactory.create(EmptyModule, new HonoAdapter({ runtime: 'bun' }), {
				logger: false,
			})
		).rejects.toThrow("HonoAdapter runtime 'bun' requires the Bun runtime")
	})
})
