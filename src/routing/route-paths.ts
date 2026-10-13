const HONO_CONSTRAINT_MARKER_REGEX = /[\\[\]()+*?|^$]/
const HONO_PARAMETER_SUFFIX_REGEX = /:[A-Za-z_$][\w$]*$/
const HONO_WILDCARD_SUFFIX_REGEX = /:[A-Za-z_$][\w$]*\{(?:\.\*|\.\+)\}$/
const OPTIONAL_GROUP_PARAMETER_REGEX = /(?:^|[/.-]):[A-Za-z_$][\w$]*/
const TRAILING_SLASHES_REGEX = /\/+$/

interface OptionalRouteGroup {
	content: string
	end: number
	start: number
}

export interface OptionalParameterSuffix {
	name: string
	suffix: string
}

function findClosingBrace(path: string, start: number) {
	let depth = 0
	let insideCharacterClass = false
	for (let index = start; index < path.length; index += 1) {
		const character = path[index]
		if (character === '\\') {
			index += 1
			continue
		}
		if (character === '[') insideCharacterClass = true
		else if (character === ']') insideCharacterClass = false
		else if (!insideCharacterClass && character === '{') depth += 1
		else if (!insideCharacterClass && character === '}') {
			depth -= 1
			if (depth === 0) return index
		}
	}
}

function findOptionalRouteGroup(path: string): OptionalRouteGroup | undefined {
	for (let start = 0; start < path.length; start += 1) {
		if (path[start] !== '{') continue
		const end = findClosingBrace(path, start)
		if (end === undefined) return
		const content = path.slice(start + 1, end)
		const followsHonoParameter = HONO_PARAMETER_SUFFIX_REGEX.test(
			path.slice(0, start)
		)
		if (
			!followsHonoParameter ||
			OPTIONAL_GROUP_PARAMETER_REGEX.test(content) ||
			!HONO_CONSTRAINT_MARKER_REGEX.test(content)
		) {
			return { content, end, start }
		}
		start = end
	}
}

function getOptionalParameterSuffix(
	path: string,
	optionalGroup: OptionalRouteGroup
): OptionalParameterSuffix | undefined {
	const name = path
		.slice(0, optionalGroup.start)
		.match(HONO_PARAMETER_SUFFIX_REGEX)?.[0]
		.slice(1)
	const { content } = optionalGroup
	if (
		!(name && content) ||
		content.includes('/') ||
		OPTIONAL_GROUP_PARAMETER_REGEX.test(content) ||
		HONO_CONSTRAINT_MARKER_REGEX.test(content)
	)
		return

	return { name, suffix: content }
}

/**
 * Collects literal suffixes of optional route parameters, such as `.json` in
 * `/:file{.json}`, so they can be stripped from matched parameter values.
 */
export function getOptionalParameterSuffixes(path: string) {
	const suffixes: OptionalParameterSuffix[] = []
	let remainingPath = path
	for (;;) {
		const optionalGroup = findOptionalRouteGroup(remainingPath)
		if (!optionalGroup) return suffixes
		const suffix = getOptionalParameterSuffix(remainingPath, optionalGroup)
		if (suffix) suffixes.push(suffix)
		remainingPath = `${remainingPath.slice(0, optionalGroup.start)}${remainingPath.slice(optionalGroup.end + 1)}`
	}
}

/**
 * Converts a Nest route path into the Hono paths that match it, expanding
 * optional groups and named wildcards.
 */
export function normalizeHonoPaths(path: string): string[] {
	const optionalGroup = findOptionalRouteGroup(path)
	if (!optionalGroup) {
		return [path.replace(/\/\*([A-Za-z_$][\w$]*)/g, '/:$1{.+}')]
	}

	const before = path.slice(0, optionalGroup.start)
	const after = path.slice(optionalGroup.end + 1)
	if (getOptionalParameterSuffix(path, optionalGroup)) {
		return normalizeHonoPaths(`${before}${after}`)
	}
	return [
		...normalizeHonoPaths(`${before}${optionalGroup.content}${after}`),
		...normalizeHonoPaths(`${before}${after}`),
	]
}

/**
 * Converts a Nest middleware path into a Hono prefix pattern.
 */
export function normalizeHonoMiddlewarePath(path: string) {
	if (path === '*') return path
	if (path === '/') return '/*'
	if (path.endsWith('/*') || HONO_WILDCARD_SUFFIX_REGEX.test(path)) return path

	return `${path.replace(TRAILING_SLASHES_REGEX, '')}/*`
}
