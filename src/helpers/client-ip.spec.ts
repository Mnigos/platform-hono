import type { Context } from 'hono'
import { extractClientIp } from './client-ip'

function createContext(headers: Record<string, string>) {
	const normalizedHeaders = new Map(
		Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
	)

	return {
		req: {
			header: (name: string) => normalizedHeaders.get(name.toLowerCase()),
		},
	} as unknown as Context
}

test('does not trust forwarded headers by default', () => {
	const ctx = createContext({ 'x-forwarded-for': '203.0.113.10' })

	expect(extractClientIp(ctx, {})).toBeUndefined()
})

test('uses default trusted proxy headers when trustProxy is enabled', () => {
	const ctx = createContext({
		'x-forwarded-for': '203.0.113.10, 10.0.0.1',
	})

	expect(extractClientIp(ctx, { trustProxy: true })).toBe('203.0.113.10')
})

test('uses configured trusted proxy headers', () => {
	const ctx = createContext({
		'cf-connecting-ip': '203.0.113.10',
		'x-real-ip': '198.51.100.2',
	})

	expect(extractClientIp(ctx, { trustProxy: { headers: ['x-real-ip'] } })).toBe(
		'198.51.100.2'
	)
})

test('parses Forwarded header values safely', () => {
	const ctx = createContext({
		forwarded: 'for="[2001:db8::1]:443";proto=https, for=198.51.100.1',
	})

	expect(extractClientIp(ctx, { trustProxy: { headers: ['forwarded'] } })).toBe(
		'2001:db8::1'
	)
})

test('ignores malformed forwarded IP values', () => {
	const ctx = createContext({
		'x-forwarded-for': 'not-an-ip, 203.0.113.10',
	})

	expect(extractClientIp(ctx, { trustProxy: true })).toBeUndefined()
})

test('ignores empty forwarded IP values', () => {
	const ctx = createContext({ forwarded: 'for=' })

	expect(
		extractClientIp(ctx, { trustProxy: { headers: ['forwarded'] } })
	).toBeUndefined()
})
