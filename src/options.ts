export interface RequestSizeLimit {
	errorMessage?: string
	maxBytes: number
	path: string
}

export interface TrustProxyOptions {
	headers?: string[]
	trustedHops?: number
}

/**
 * `auto` serves with `Bun.serve` when the Bun global is available and with
 * `@hono/node-server` otherwise.
 */
export type HonoAdapterRuntime = 'auto' | 'bun' | 'node'

export interface BunRuntimeOptions {
	/**
	 * Seconds a connection may stay idle before Bun closes it. Bun counts a slow
	 * handler that has not written any bytes yet as idle. `0` disables the
	 * timeout. Defaults to 255, Bun's maximum.
	 */
	idleTimeout?: number
}

/**
 * Limits for `multipart/form-data` bodies, enforced while the body streams in.
 */
export interface MultipartLimits {
	/** Maximum number of non-file fields. */
	fields?: number
	/** Maximum size of a single file in bytes. */
	fileSize?: number
	/** Maximum number of file parts. */
	files?: number
	/** Maximum number of parts, fields and files combined. */
	parts?: number
}

export interface HonoAdapterOptions {
	bodyLimit?: number | false
	bun?: BunRuntimeOptions
	multipartLimits?: MultipartLimits
	requestSizeLimits?: RequestSizeLimit[]
	runtime?: HonoAdapterRuntime
	skipBodyParserFor?: string[]
	trustProxy?: boolean | TrustProxyOptions
}

export const DEFAULT_BODY_LIMIT = 1024 * 1024

export const DEFAULT_BUN_IDLE_TIMEOUT = 255

export const DEFAULT_TRUSTED_PROXY_HEADERS = ['x-forwarded-for'] as const
