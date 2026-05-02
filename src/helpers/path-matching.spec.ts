import type { RequestSizeLimit } from '../options'
import { getRequestSizeLimit, isPathMatch } from './path-matching'

describe('path matching helpers', () => {
	test('matches exact paths and segment descendants', () => {
		expect(isPathMatch('/api/auth', '/api/auth')).toBe(true)
		expect(isPathMatch('/api/auth/session', '/api/auth')).toBe(true)
		expect(isPathMatch('/api/authentication', '/api/auth')).toBe(false)
	})

	test('normalizes trailing slashes and root paths', () => {
		expect(isPathMatch('/api/auth/', '/api/auth')).toBe(true)
		expect(isPathMatch('/anything', '/')).toBe(true)
		expect(isPathMatch('/anything', '')).toBe(true)
	})

	test('selects the longest matching request size limit', () => {
		const requestSizeLimits: RequestSizeLimit[] = [
			{ path: '/api', maxBytes: 100 },
			{ path: '/api/uploads/images', maxBytes: 10 },
			{ path: '/api/uploads', maxBytes: 50 },
		]

		expect(
			getRequestSizeLimit('/api/uploads/images/avatar', requestSizeLimits)
		).toEqual({ path: '/api/uploads/images', maxBytes: 10 })
	})

	test('does not match sibling path prefixes for request size limits', () => {
		expect(
			getRequestSizeLimit('/api/authentication', [
				{ path: '/api/auth', maxBytes: 10 },
			])
		).toBeUndefined()
	})
})
