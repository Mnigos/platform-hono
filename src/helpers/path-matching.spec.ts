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

	test('canonicalizes unreserved percent-encoding before matching', () => {
		expect(isPathMatch('/api/%75ploads/avatar', '/api/uploads')).toBe(true)
		expect(isPathMatch('/api/uploads/avatar', '/api/%75ploads')).toBe(true)
		expect(isPathMatch('/caf%C3%A9/menu', '/caf%C3%A9')).toBe(true)
	})

	test('does not decode escaped path separators', () => {
		expect(isPathMatch('/api%2Fadmin/users', '/api/admin')).toBe(false)
		expect(isPathMatch('/api%2fadmin/users', '/api%2Fadmin')).toBe(true)
	})

	test('handles malformed percent-encoding without throwing', () => {
		expect(isPathMatch('/api/%zz/users', '/api/users')).toBe(false)
		expect(isPathMatch('/api/%75ploads/%zz', '/api/uploads')).toBe(true)
	})

	test('does not repeatedly decode percent-encoded percent signs', () => {
		expect(isPathMatch('/api/%2575ploads', '/api/uploads')).toBe(false)
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
