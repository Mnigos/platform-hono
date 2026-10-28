import 'reflect-metadata'
import { mkdtempSync, rmSync } from 'node:fs'
import { request, Server } from 'node:http'
import { join } from 'node:path'
import type { PassThrough } from 'node:stream'
import { Server as TlsServer } from 'node:tls'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { Context } from 'hono'
import { HonoAdapter } from '../../src'
import { startApp } from './fixtures/minimal-nest-app'
import { createSelfSignedCertificate } from './fixtures/self-signed-certificate'

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

describe.runIf(isBunRuntime)('Bun runtime integration', () => {
	test('serves Nest routes through Bun.serve and reports the app URL', async () => {
		const app = await startApp()

		try {
			const server = app.adapter.getHttpServer()
			const url = await app.getUrl()

			expect(server).not.toBeInstanceOf(Server)
			expect(server).not.toBeInstanceOf(TlsServer)
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

	test('waits for an in-flight handler when closing gracefully', async () => {
		const adapter = new HonoAdapter()
		let releaseHandler: () => void = () => undefined
		const handlerGate = new Promise<void>(resolve => {
			releaseHandler = resolve
		})
		let handlerStarted = false
		const app = await startApp(adapter, {}, () => {
			adapter.get('/pending-handler', async (_req, ctx) => {
				handlerStarted = true
				await handlerGate
				return ctx.text('completed')
			})
		})
		const server = app.adapter.getHttpServer() as ListeningServer
		const response = fetch(`${app.baseUrl}/pending-handler`)
		let closing: Promise<void> | undefined
		let closed = false

		try {
			await expect.poll(() => handlerStarted).toBe(true)
			closing = app.close().then(() => {
				closed = true
			})
			await expect.poll(() => server.listening).toBe(false)
			await new Promise(resolve => setTimeout(resolve, 25))
			expect(closed).toBe(false)
			releaseHandler()
			await expect((await response).text()).resolves.toBe('completed')
			await closing
			expect(closed).toBe(true)
		} finally {
			releaseHandler()
			await response.catch(() => undefined)
			await (closing ?? app.close())
		}
	})

	test('interrupts an in-flight handler response when forceCloseConnections is enabled', async () => {
		const adapter = new HonoAdapter()
		let releaseHandler: () => void = () => undefined
		const handlerGate = new Promise<void>(resolve => {
			releaseHandler = resolve
		})
		let handlerStarted = false
		const app = await startApp(adapter, { forceCloseConnections: true }, () => {
			adapter.get('/pending-handler', async (_req, ctx) => {
				handlerStarted = true
				await handlerGate
				return ctx.text('completed')
			})
		})
		const response = fetch(`${app.baseUrl}/pending-handler`).then(
			value => value,
			(error: unknown) => error
		)
		let closing: Promise<void> | undefined
		let closed = false

		try {
			await expect.poll(() => handlerStarted).toBe(true)
			closing = app.close().then(() => {
				closed = true
			})
			await expect.poll(() => closed).toBe(true)
			await expect(response).resolves.toBeInstanceOf(Error)
		} finally {
			releaseHandler()
			await response
			await (closing ?? app.close())
		}
	})

	test('listens on a Unix socket and clears its address on close', async () => {
		// Keep the path below the macOS Unix socket path limit.
		const directory = mkdtempSync('/tmp/ph-unix-')
		const socketPath = join(directory, 'http.sock')
		const adapter = new HonoAdapter()
		const app = await NestFactory.create(EmptyModule, adapter, {
			logger: false,
		})
		adapter.get('/unix', (_req, ctx) => ctx.text('unix response'))
		const server = adapter.getHttpServer() as ListeningServer & {
			address: () => string | null
		}

		try {
			await app.listen(socketPath)
			expect(server.listening).toBe(true)
			expect(server.address()).toBe(socketPath)
			const response = await new Promise<{
				body: string
				status?: number
			}>((resolve, reject) => {
				const clientRequest = request(
					{ path: '/unix', socketPath },
					incoming => {
						const chunks: Buffer[] = []
						incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
						incoming.on('error', reject)
						incoming.on('end', () => {
							resolve({
								body: Buffer.concat(chunks).toString(),
								status: incoming.statusCode,
							})
						})
					}
				)
				clientRequest.on('error', reject)
				clientRequest.end()
			})
			expect(response).toEqual({ body: 'unix response', status: 200 })
		} finally {
			await app.close()
			rmSync(directory, { force: true, recursive: true })
		}
		expect(server.listening).toBe(false)
		expect(server.address()).toBeNull()
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

			expect(app.adapter.getHttpServer()).toBeInstanceOf(TlsServer)
			expect(url).toBe(
				app.baseUrl.replace('http://127.0.0.1', 'https://localhost')
			)

			const response = await fetch(`${url}/hello/tls?q=secure`, {
				tls: { rejectUnauthorized: false },
			} as BunFetchInit)

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
