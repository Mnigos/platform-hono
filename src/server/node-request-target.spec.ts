import { getPath } from 'hono/utils/url'
import { getVerbatimPath, isVerbatimHost } from './node-request-target'

describe('verbatim Node request targets', () => {
	test.each([
		'/',
		'/users/42',
		'/Users',
		'/users/42?sort=asc&tags=a,b#top',
		'/a//b/',
		'/a.b/.../c',
		'/a#fragment',
		'/a+b;v=1',
	])('uses the same path as Hono for %s', target => {
		const request = { url: `http://localhost${target}` } as Request
		expect(getVerbatimPath(target)).toBe(getPath(request))
	})

	test.each([
		'http://example.com/users',
		'*',
		'users/42',
		'/caf%C3%A9',
		'/café',
		'/a\\b',
		'/a b',
		'/a/./b',
		'/a/../b',
		'/a/..',
		'/a/.?q=x',
		'/a?next=/../private',
	])('requires fallback for %s', target => {
		expect(getVerbatimPath(target)).toBeUndefined()
	})

	test.each([
		'localhost',
		'example.com',
		'127.0.0.1:3000',
		'api_test.local:59999',
	])('accepts host %s without URL normalization', host => {
		expect(isVerbatimHost(host)).toBe(true)
		expect(new URL(`http://${host}/`).host).toBe(host)
	})

	test.each([
		'',
		'LOCALHOST',
		'example.com:80',
		'example.com:999',
		'example.com:65536',
		'[::1]:3000',
		'user@example.com',
		'example.com/path',
		'example.com?query',
		'example.com#fragment',
		'example.com\\path',
	])('requires fallback for host %s', host => {
		expect(isVerbatimHost(host)).toBe(false)
	})
})
