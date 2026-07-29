import type { RequestSizeLimit } from '../options.js'

/**
 * Selects the most specific matching request size limit so broad upload limits
 * cannot shadow stricter nested route policies.
 */
export function getRequestSizeLimit(
	pathname: string,
	requestSizeLimits: RequestSizeLimit[] = []
) {
	return requestSizeLimits
		.filter(requestSizeLimit => isPathMatch(pathname, requestSizeLimit.path))
		.sort(
			(leftLimit, rightLimit) =>
				normalizeRoutePath(rightLimit.path).length -
				normalizeRoutePath(leftLimit.path).length
		)[0]
}

/**
 * Matches exact paths or segment descendants. For example, `/api/auth` matches
 * `/api/auth/session`, but not `/api/authentication`.
 */
export function isPathMatch(pathname: string, configuredPath: string) {
	const normalizedPathname = normalizeRoutePath(pathname)
	const normalizedConfiguredPath = normalizeRoutePath(configuredPath)

	if (normalizedConfiguredPath === '/') return true

	return (
		normalizedPathname === normalizedConfiguredPath ||
		normalizedPathname.startsWith(`${normalizedConfiguredPath}/`)
	)
}

function normalizeRoutePath(path: string) {
	if (!path || path === '/') return '/'

	const protectedPercentPath = path.replace(/%25/gi, '%2525')
	let normalizedPath = protectedPercentPath
	try {
		normalizedPath = decodeURI(protectedPercentPath)
	} catch {
		normalizedPath = protectedPercentPath.replace(
			/(?:%[\da-f]{2})+/gi,
			encodedValue => {
				try {
					return decodeURI(encodedValue)
				} catch {
					return encodedValue
				}
			}
		)
	}

	normalizedPath = normalizedPath.replace(/%[\da-f]{2}/gi, value =>
		value.toUpperCase()
	)
	while (normalizedPath.length > 1 && normalizedPath.endsWith('/'))
		normalizedPath = normalizedPath.slice(0, -1)

	return normalizedPath
}
