const CONTENT_DISPOSITION_REGEX = /^content-disposition\s*:(.*)$/i

interface DispositionParameter {
	hasSpaceBeforeEquals: boolean
	name: string
}

function splitParameters(value: string) {
	const segments: string[] = []
	let current = ''
	let quoted = false
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index]
		if (character === '\\' && quoted) {
			current += character + (value[index + 1] ?? '')
			index += 1
			continue
		}
		if (character === '"') quoted = !quoted
		if (character === ';' && !quoted) {
			segments.push(current)
			current = ''
			continue
		}
		current += character
	}
	segments.push(current)
	return segments
}

function getDispositionParameters(value: string) {
	const parameters: DispositionParameter[] = []
	for (const segment of splitParameters(value).slice(1)) {
		const equalsIndex = segment.indexOf('=')
		if (equalsIndex === -1) continue
		const rawName = segment.slice(0, equalsIndex).trimStart()
		parameters.push({
			hasSpaceBeforeEquals: rawName !== rawName.trimEnd(),
			name: rawName.trimEnd().toLowerCase(),
		})
	}
	return parameters
}

/**
 * Classifies a multipart part from its header block the way both runtime
 * parsers might: Bun treats `filename` (also with spaces around `=`) as a
 * file and `filename*` as a field, undici treats both `filename` and
 * `filename*` as files. A part either parser may read as a file counts as a
 * file, and a part either parser may read as a field counts as a field.
 */
export function classifyMultipartPart(headers: string) {
	const dispositions = headers
		.split('\r\n')
		.map(line => line.match(CONTENT_DISPOSITION_REGEX)?.[1])
		.filter(value => value !== undefined)
		.map(getDispositionParameters)

	const possiblyFile = dispositions.some(parameters =>
		parameters.some(({ name }) => name === 'filename' || name === 'filename*')
	)
	const certainlyFile =
		dispositions.length > 0 &&
		dispositions.every(parameters =>
			parameters.some(
				({ hasSpaceBeforeEquals, name }) =>
					name === 'filename' && !hasSpaceBeforeEquals
			)
		) &&
		dispositions.every(parameters =>
			parameters.every(
				({ hasSpaceBeforeEquals, name }) =>
					!(
						name === 'filename*' ||
						(name === 'filename' && hasSpaceBeforeEquals)
					)
			)
		)

	return { possiblyField: !certainlyFile, possiblyFile }
}
