export interface RequestSizeLimit {
	errorMessage?: string
	maxBytes: number
	path: string
}

export interface TrustProxyOptions {
	headers?: string[]
	trustedHops?: number
}

export interface HonoAdapterOptions {
	bodyLimit?: number | false
	requestSizeLimits?: RequestSizeLimit[]
	skipBodyParserFor?: string[]
	trustProxy?: boolean | TrustProxyOptions
}

export const DEFAULT_BODY_LIMIT = 1024 * 1024

export const DEFAULT_TRUSTED_PROXY_HEADERS = ['x-forwarded-for'] as const
