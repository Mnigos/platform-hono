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
		expect(isPathMatch('/api/auth///', '/api/auth/')).toBe(true)
		expect(isPathMatch('/anything', '/')).toBe(true)
		expect(isPathMatch('/anything', '')).toBe(true)
	})

	test.each<[string, string, boolean]>([
		['/api/%75ploads/avatar', '/api/uploads', true],
		['/api/uploads/avatar', '/api/%75ploads', true],
		['/caf%C3%A9/menu', '/caf%C3%A9', true],
		['/api%2Fadmin/users', '/api/admin', false],
		['/api%2fadmin/users', '/api%2Fadmin', true],
		['/api/%zz/users', '/api/users', false],
		['/api/%75ploads/%zz', '/api/uploads', true],
		['/api/%2575ploads', '/api/uploads', false],
	])('matches encoded path %s against %s', (pathname, configuredPath, expected) => {
		expect(isPathMatch(pathname, configuredPath)).toBe(expected)
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

	test('selects limits for canonicalized request and configured paths', () => {
		const limits: RequestSizeLimit[] = [
			{ path: '/api', maxBytes: 100 },
			{ path: '/api/%75ploads', maxBytes: 10 },
		]

		expect(getRequestSizeLimit('/api/uplo%61ds/avatar', limits)).toEqual({
			path: '/api/%75ploads',
			maxBytes: 10,
		})
	})
})
