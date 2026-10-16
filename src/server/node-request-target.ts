const VALID_HOST = /^[a-z0-9._-]+(?::(?:[1-5]\d{3,4}|[6-9]\d{3}))?$/
const VALID_REQUEST_URL = /^\/[!#$&-;=?-[\]_a-z~]*$/
const DOT_SEGMENT = /\/\.\.?(?:[/?#]|$)/

/**
 * Whether `@hono/node-server`'s `buildUrl()` uses this `Host` header verbatim
 * in the request URL instead of normalizing it with `new URL()`. The pattern
 * is the same in every 2.x release.
 */
export function isVerbatimHost(host: string) {
	return VALID_HOST.test(host)
}

/**
 * Returns the path of an origin-form request target `@hono/node-server`'s
 * `buildUrl()` uses verbatim (the same patterns in every 2.x release), which
 * is also the path Hono's `getPath()` reads from it (no `%` to decode), or
 * `undefined` for any other target.
 */
export function getVerbatimPath(url: string) {
	if (!VALID_REQUEST_URL.test(url) || DOT_SEGMENT.test(url)) return
	let end = 0
	while (end < url.length) {
		const charCode = url.charCodeAt(end)
		if (charCode === 63 || charCode === 35) break
		end += 1
	}
	return end === url.length ? url : url.slice(0, end)
}
