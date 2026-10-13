import { BunHttpServer, toBunTlsOptions } from './bun-http-server'

interface FakeBunServer {
	hostname?: string
	port?: number
	stop: ReturnType<typeof vi.fn>
}

const fetchHandler = () => new Response('ok')

function stubBunServe(server: Partial<FakeBunServer> = {}) {
	const bunServer: FakeBunServer = {
		hostname: 'localhost',
		port: 4321,
		stop: vi.fn(() => Promise.resolve()),
		...server,
	}
	const serve = vi.fn(() => bunServer)
	vi.stubGlobal('Bun', { serve })
	return { bunServer, serve }
}

function waitForEvent(server: BunHttpServer, event: string) {
	return new Promise<unknown[]>(resolve => {
		server.once(event, (...args: unknown[]) => resolve(args))
	})
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('BunHttpServer', () => {
	test('starts Bun.serve with the fetch handler, port, hostname, and defaults', async () => {
		const { serve } = stubBunServe()
		const server = new BunHttpServer(fetchHandler)
		const listeningCallback = vi.fn()

		expect(server.listening).toBe(false)
		expect(server.address()).toBeNull()
		expect(server.listen(4321, '127.0.0.1', listeningCallback)).toBe(server)
		expect(serve).toHaveBeenCalledWith({
			fetch: fetchHandler,
			hostname: '127.0.0.1',
			idleTimeout: 255,
			maxRequestBodySize: Number.MAX_SAFE_INTEGER,
			port: 4321,
		})
		expect(listeningCallback).not.toHaveBeenCalled()

		await waitForEvent(server, 'listening')

		expect(listeningCallback).toHaveBeenCalledOnce()
		expect(server.listening).toBe(true)
		expect(server.address()).toEqual({
			address: 'localhost',
			family: 'IPv4',
			port: 4321,
		})
	})

	test('accepts string ports, a custom idle timeout, and IPv6 hosts', () => {
		const { serve } = stubBunServe({ hostname: '::', port: 3000 })
		const server = new BunHttpServer(fetchHandler, { idleTimeout: 0 })

		server.listen('3000', '::')

		expect(serve).toHaveBeenCalledWith(
			expect.objectContaining({ hostname: '::', idleTimeout: 0, port: 3000 })
		)
		expect(server.address()).toEqual({
			address: '::',
			family: 'IPv6',
			port: 3000,
		})
	})

	test('listens on a unix socket when the port is a path', () => {
		const { serve } = stubBunServe({ hostname: undefined, port: undefined })
		const server = new BunHttpServer(fetchHandler)

		server.listen('/tmp/platform-hono.sock')

		expect(serve).toHaveBeenCalledWith({
			fetch: fetchHandler,
			maxRequestBodySize: Number.MAX_SAFE_INTEGER,
			unix: '/tmp/platform-hono.sock',
		})
		expect(server.address()).toBe('/tmp/platform-hono.sock')
	})

	test('emits Bun.serve startup errors asynchronously', async () => {
		const error = Object.assign(new Error('Failed to start server'), {
			code: 'EADDRINUSE',
		})
		vi.stubGlobal('Bun', {
			serve: vi.fn(() => {
				throw error
			}),
		})
		const server = new BunHttpServer(fetchHandler)
		const listeningCallback = vi.fn()
		const errorEvent = waitForEvent(server, 'error')

		server.listen(3000, listeningCallback)

		expect(await errorEvent).toEqual([error])
		expect(listeningCallback).not.toHaveBeenCalled()
		expect(server.listening).toBe(false)
	})

	test('stops Bun.serve gracefully on close', async () => {
		const { bunServer } = stubBunServe()
		const server = new BunHttpServer(fetchHandler)
		const closeEvent = waitForEvent(server, 'close')
		server.listen(0)

		await new Promise<void>((resolve, reject) => {
			server.close(error => (error ? reject(error) : resolve()))
		})

		await closeEvent
		expect(bunServer.stop).toHaveBeenCalledExactlyOnceWith(false)
		expect(server.listening).toBe(false)
		expect(server.address()).toBeNull()
	})

	test('force stops Bun.serve when forceCloseConnections is enabled', async () => {
		const { bunServer } = stubBunServe()
		const server = new BunHttpServer(fetchHandler, {
			forceCloseConnections: true,
		})
		server.listen(0)

		await new Promise(resolve => server.close(resolve))

		expect(bunServer.stop).toHaveBeenCalledExactlyOnceWith(true)
	})

	test('closes all connections of a running server', () => {
		const { bunServer } = stubBunServe()
		const server = new BunHttpServer(fetchHandler)
		server.listen(0)

		server.closeAllConnections()

		expect(bunServer.stop).toHaveBeenCalledExactlyOnceWith(true)
	})

	test('reports an error when closing a server that is not running', async () => {
		stubBunServe()
		const server = new BunHttpServer(fetchHandler)

		const error = await new Promise<Error | undefined>(resolve => {
			server.close(resolve)
		})

		expect(error?.message).toBe('Server is not running.')
	})

	test('passes TLS options to Bun.serve', () => {
		const { serve } = stubBunServe()
		const server = new BunHttpServer(fetchHandler, {
			httpsOptions: { cert: 'cert', key: 'key', passphrase: undefined },
		})

		server.listen(443)

		expect(serve).toHaveBeenCalledWith(
			expect.objectContaining({ tls: { cert: 'cert', key: 'key' } })
		)
	})
})

describe('toBunTlsOptions', () => {
	test('keeps the TLS options Bun.serve supports', () => {
		expect(
			toBunTlsOptions({
				ca: 'ca',
				cert: 'cert',
				key: 'key',
				passphrase: 'secret',
				rejectUnauthorized: false,
				requestCert: true,
				secureOptions: 1,
			})
		).toEqual({
			ca: 'ca',
			cert: 'cert',
			key: 'key',
			passphrase: 'secret',
			rejectUnauthorized: false,
			requestCert: true,
			secureOptions: 1,
		})
	})

	test('rejects Node-only TLS options', () => {
		expect(() =>
			toBunTlsOptions({ ciphers: 'HIGH', pfx: Buffer.from('pfx') })
		).toThrow(
			"HonoAdapter runtime 'bun' does not support httpsOptions: ciphers, pfx"
		)
	})
})
