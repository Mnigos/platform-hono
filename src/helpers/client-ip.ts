import { isIP } from 'node:net'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'
import {
	DEFAULT_TRUSTED_PROXY_HEADERS,
	type HonoAdapterOptions,
} from '../options.js'

const QUOTED_VALUE_REGEX = /^"|"$/g
const BRACKETED_IP_WITH_OPTIONAL_PORT_REGEX = /^\[(.*)](?::\d+)?$/
const IPV4_WITH_PORT_REGEX = /^(.*):(\d+)$/

/**
 * Returns the direct socket peer unless explicitly configured to trust a proxy
 * header. Direct client-supplied forwarding headers are ignored by default.
 */
export function extractClientIp(ctx: Context, options: HonoAdapterOptions) {
	const trustProxy = options.trustProxy
	const directClientIp = getDirectClientIp(ctx)
	if (!trustProxy) return directClientIp

	const trustedHeaders =
		typeof trustProxy === 'object' && trustProxy.headers !== undefined
			? trustProxy.headers
			: DEFAULT_TRUSTED_PROXY_HEADERS
	const configuredHops =
		typeof trustProxy === 'object' ? trustProxy.trustedHops : undefined
	const trustedHops =
		configuredHops && Number.isInteger(configuredHops) && configuredHops > 0
			? configuredHops
			: 1

	for (const headerName of trustedHeaders) {
		const headerValue = ctx.req.header(headerName)
		const clientIp = parseClientIpHeader(headerName, headerValue, trustedHops)
		if (clientIp) return clientIp
	}

	return directClientIp
}

function getDirectClientIp(ctx: Context) {
	try {
		return normalizeIpAddress(getConnInfo(ctx).remote.address)
	} catch {
		return
	}
}

function parseClientIpHeader(
	headerName: string,
	headerValue: string | undefined,
	trustedHops: number
) {
	if (!headerValue) return
	const values = headerValue
		.split(',')
		.map(value => value.trim())
		.filter(Boolean)
	const trustedValue = values.at(-trustedHops)
	if (!trustedValue) return

	if (headerName.toLowerCase() === 'forwarded') {
		const forwardedFor = trustedValue
			.split(';')
			.map(value => value.trim())
			.find(value => value.toLowerCase().startsWith('for='))
			?.slice(4)

		return normalizeIpAddress(forwardedFor)
	}

	return normalizeIpAddress(trustedValue)
}

function normalizeIpAddress(value?: string) {
	if (!value) return

	const normalizedValue = value.trim().replace(QUOTED_VALUE_REGEX, '')
	const bracketedAddress = normalizedValue.match(
		BRACKETED_IP_WITH_OPTIONAL_PORT_REGEX
	)?.[1]
	if (bracketedAddress && isIP(bracketedAddress)) return bracketedAddress
	if (isIP(normalizedValue)) return normalizedValue

	const ipv4WithPort = normalizedValue.match(IPV4_WITH_PORT_REGEX)?.[1]
	if (ipv4WithPort && isIP(ipv4WithPort) === 4) return ipv4WithPort

	return
}
