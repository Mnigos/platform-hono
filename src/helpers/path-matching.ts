import type { RequestSizeLimit } from '../options'

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
	return path.endsWith('/') ? path.slice(0, -1) : path
}
