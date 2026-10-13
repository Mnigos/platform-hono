import { EventEmitter } from 'node:events'
import type { ServerOptions as HttpsServerOptions } from 'node:https'
import type { AddressInfo } from 'node:net'
import { DEFAULT_BUN_IDLE_TIMEOUT } from '../options'

type FetchHandler = (
	request: Request,
	server: object
) => Response | Promise<Response>

type ListenCallback = () => void

export interface BunHttpServerOptions {
	forceCloseConnections?: boolean
	httpsOptions?: HttpsServerOptions
	idleTimeout?: number
}

const SUPPORTED_TLS_OPTIONS = new Set([
	'ca',
	'cert',
	'key',
	'passphrase',
	'rejectUnauthorized',
	'requestCert',
	'secureOptions',
])
const PORT_REGEX = /^\d+$/

/**
 * Maps Nest `httpsOptions` to `Bun.serve` TLS options and rejects Node-only
 * options, such as `pfx`, that Bun would otherwise ignore.
 */
export function toBunTlsOptions(httpsOptions: HttpsServerOptions) {
	const unsupportedOptions = Object.entries(httpsOptions)
		.filter(
			([name, value]) => value !== undefined && !SUPPORTED_TLS_OPTIONS.has(name)
		)
		.map(([name]) => name)
	if (unsupportedOptions.length > 0)
		throw new Error(
			`HonoAdapter runtime 'bun' does not support httpsOptions: ${unsupportedOptions.join(', ')}. Use ${[...SUPPORTED_TLS_OPTIONS].join(', ')}, or runtime 'node'.`
		)

	return Object.fromEntries(
		Object.entries(httpsOptions).filter(([, value]) => value !== undefined)
	) as Bun.TLSOptions
}

/**
 * Wraps `Bun.serve` in the subset of the Node.js `http.Server` API that Nest
 * and the adapter call: `listen`, `address`, `close`, and the `listening`,
 * `error`, and `close` events. Bun ignores a forced `stop(true)` once a
 * graceful stop has started, so `forceCloseConnections` is applied by `close`.
 * A forced stop closes every socket at once, but its promise still waits for
 * running handlers, so `close` completes without waiting for it, like
 * Node.js `server.close()` after `closeAllConnections()`.
 */
export class BunHttpServer extends EventEmitter {
	private server?: Bun.Server<undefined>
	private unixSocketPath?: string
	private readonly fetch: FetchHandler
	private readonly forceCloseConnections: boolean
	private readonly idleTimeout: number
	private readonly tls?: Bun.TLSOptions

	constructor(fetch: FetchHandler, options: BunHttpServerOptions = {}) {
		super()
		this.fetch = fetch
		this.forceCloseConnections = options.forceCloseConnections ?? false
		this.idleTimeout = options.idleTimeout ?? DEFAULT_BUN_IDLE_TIMEOUT
		if (options.httpsOptions) this.tls = toBunTlsOptions(options.httpsOptions)
	}

	get listening() {
		return this.server !== undefined
	}

	listen(port?: number | string, ...args: unknown[]) {
		const hostname = args.find(arg => typeof arg === 'string') as
			| string
			| undefined
		const callback = args.find(arg => typeof arg === 'function') as
			| ListenCallback
			| undefined
		if (callback) this.once('listening', callback)

		try {
			this.server = Bun.serve(this.getServeOptions(port, hostname))
		} catch (error) {
			if (callback) this.removeListener('listening', callback)
			process.nextTick(() => this.emit('error', error))
			return this
		}

		process.nextTick(() => this.emit('listening'))
		return this
	}

	address(): AddressInfo | string | null {
		if (!this.server) return null
		if (this.unixSocketPath) return this.unixSocketPath

		const address = this.server.hostname ?? 'localhost'
		return {
			address,
			family: address.includes(':') ? 'IPv6' : 'IPv4',
			port: this.server.port ?? 0,
		}
	}

	close(callback?: (error?: Error) => void) {
		const server = this.server
		if (!server) {
			process.nextTick(() => callback?.(new Error('Server is not running.')))
			return this
		}

		this.server = undefined
		this.unixSocketPath = undefined
		const finish = () => {
			this.emit('close')
			callback?.()
		}
		const stopped = server.stop(this.forceCloseConnections)
		if (this.forceCloseConnections) {
			stopped.catch(() => undefined)
			process.nextTick(finish)
			return this
		}
		stopped.then(finish, (error: Error) => callback?.(error))
		return this
	}

	closeAllConnections() {
		this.server?.stop(true)
	}

	private getServeOptions(
		port: number | string | undefined,
		hostname: string | undefined
	): Bun.Serve.Options<undefined> {
		const serverOptions = {
			fetch: this.fetch,
			maxRequestBodySize: Number.MAX_SAFE_INTEGER,
			...(this.tls ? { tls: this.tls } : {}),
		}
		if (typeof port === 'string' && !PORT_REGEX.test(port)) {
			this.unixSocketPath = port
			return { ...serverOptions, unix: port }
		}

		return {
			...serverOptions,
			...(hostname ? { hostname } : {}),
			idleTimeout: this.idleTimeout,
			port: Number(port ?? 0),
		}
	}
}
