import { isIP } from 'node:net'
import type { Context } from 'hono'
import {
	DEFAULT_TRUSTED_PROXY_HEADERS,
	type HonoAdapterOptions,
} from '../options'

const QUOTED_VALUE_REGEX = /^"|"$/g
const BRACKETED_IP_WITH_OPTIONAL_PORT_REGEX = /^\[(.*)](?::\d+)?$/
const PORT_SUFFIX_REGEX = /:\d+$/

/**
 * Returns a validated client IP from trusted proxy headers only when trustProxy
 * is enabled. Direct client-supplied forwarding headers are ignored by default.
 */
export function extractClientIp(ctx: Context, options: HonoAdapterOptions) {
	const trustProxy = options.trustProxy
	if (!trustProxy) return

	const trustedHeaders =
		typeof trustProxy === 'object' && trustProxy.headers?.length
			? trustProxy.headers
			: DEFAULT_TRUSTED_PROXY_HEADERS

	for (const headerName of trustedHeaders) {
		const headerValue = ctx.req.header(headerName)
		const clientIp = parseClientIpHeader(headerName, headerValue)
		if (clientIp) return clientIp
	}

	return
}

function parseClientIpHeader(headerName: string, headerValue?: string) {
	if (!headerValue) return

	if (headerName.toLowerCase() === 'forwarded') {
		const forwardedFor = headerValue
			.split(',')
			.map(value => value.trim())
			.find(Boolean)
			?.split(';')
			.map(value => value.trim())
			.find(value => value.toLowerCase().startsWith('for='))
			?.slice(4)

		return normalizeIpAddress(forwardedFor)
	}

	return normalizeIpAddress(headerValue.split(',')[0])
}

function normalizeIpAddress(value?: string) {
	if (!value) return

	const normalizedValue = value.trim().replace(QUOTED_VALUE_REGEX, '')
	const withoutBrackets = normalizedValue.replace(
		BRACKETED_IP_WITH_OPTIONAL_PORT_REGEX,
		'$1'
	)
	const withoutPort = withoutBrackets.includes(':')
		? withoutBrackets
		: withoutBrackets.replace(PORT_SUFFIX_REGEX, '')

	if (isIP(withoutPort)) return withoutPort
	return
}
