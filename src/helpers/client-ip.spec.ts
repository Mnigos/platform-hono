import type { Context } from 'hono'
import { extractClientIp } from './client-ip'

function createContext(
	headers: Record<string, string>,
	remoteAddress?: string
) {
	const normalizedHeaders = new Map(
		Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
	)

	return {
		env: remoteAddress
			? {
					incoming: {
						socket: {
							remoteAddress,
							remoteFamily: remoteAddress.includes(':') ? 'IPv6' : 'IPv4',
							remotePort: 4321,
						},
					},
				}
			: {},
		req: {
			header: (name: string) => normalizedHeaders.get(name.toLowerCase()),
		},
	} as unknown as Context
}

describe('client IP extraction', () => {
	test('does not trust forwarded headers by default', () => {
		const ctx = createContext(
			{ 'x-forwarded-for': '203.0.113.10' },
			'198.51.100.20'
		)

		expect(extractClientIp(ctx, {})).toBe('198.51.100.20')
	})

	test('selects proxy addresses from the trusted edge', () => {
		const ctx = createContext({
			'x-forwarded-for': '203.0.113.10, 10.0.0.1',
		})

		expect(extractClientIp(ctx, { trustProxy: true })).toBe('10.0.0.1')
		expect(extractClientIp(ctx, { trustProxy: { trustedHops: 2 } })).toBe(
			'203.0.113.10'
		)
	})

	test('uses and normalizes configured trusted proxy headers', () => {
		const ctx = createContext({
			'cf-connecting-ip': '203.0.113.10',
			'x-real-ip': '198.51.100.2:443',
		})

		expect(
			extractClientIp(ctx, { trustProxy: { headers: ['x-real-ip'] } })
		).toBe('198.51.100.2')
	})

	test('limits which proxy headers are trusted', () => {
		const directIp = '198.51.100.20'

		expect(
			extractClientIp(
				createContext({ 'cf-connecting-ip': '203.0.113.10' }, directIp),
				{ trustProxy: true }
			)
		).toBe(directIp)
		expect(
			extractClientIp(
				createContext({ 'x-forwarded-for': '203.0.113.10' }, directIp),
				{ trustProxy: { headers: [] } }
			)
		).toBe(directIp)
	})

	test('parses Forwarded header values safely', () => {
		const ctx = createContext({
			forwarded: 'for="[2001:db8::1]:443";proto=https, for=198.51.100.1',
		})

		expect(
			extractClientIp(ctx, {
				trustProxy: { headers: ['forwarded'], trustedHops: 2 },
			})
		).toBe('2001:db8::1')
	})

	test('ignores malformed forwarded IP values', () => {
		const ctx = createContext(
			{ 'x-forwarded-for': '203.0.113.10, not-an-ip' },
			'198.51.100.20'
		)

		expect(extractClientIp(ctx, { trustProxy: true })).toBe('198.51.100.20')
	})

	test('ignores empty forwarded IP values', () => {
		const ctx = createContext({ forwarded: 'for=' })

		expect(
			extractClientIp(ctx, { trustProxy: { headers: ['forwarded'] } })
		).toBeUndefined()
	})
})
