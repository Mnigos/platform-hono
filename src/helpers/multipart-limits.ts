import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'
import type { MultipartLimits } from '../options'
import { classifyMultipartPart } from './multipart-part'

type ScannerState = 'body' | 'done' | 'headers' | 'preamble'

const BOUNDARY_PARAMETER_REGEX = /boundary\s*=/gi
const BOUNDARY_TOKEN_REGEX = /^[^;\s]+/
const BOUNDARY_END_REGEX = /^\s*(?:;|$)/
const HEADER_END = Buffer.from('\r\n\r\n')
const CR = 13
const LF = 10
const DASH = 45
const MAX_PART_HEADER_BYTES = 16 * 1024

/**
 * Counts multipart parts while the body streams in and throws as soon as a
 * configured part, field, file, or file size limit is exceeded, before the
 * remaining body is read or `Request.formData()` buffers it. Status codes
 * follow Nest's multer mapping: 413 for file size, 400 for count limits.
 *
 * Where Bun's and undici's `formData()` parsers disagree, the scanner counts
 * the larger interpretation: only `--boundary` followed by CRLF opens a part,
 * a close delimiter only counts when followed by CRLF, anything else stays
 * part data, and parts either parser may treat as files count as files.
 */
export class MultipartLimitScanner {
	private carry: Buffer = Buffer.alloc(0)
	private fields = 0
	private files = 0
	private isFile = false
	private partSize = 0
	private parts = 0
	private state: ScannerState = 'preamble'
	private tailStart?: number
	private readonly dashBoundary: Buffer
	private readonly delimiter: Buffer
	private readonly limits: MultipartLimits

	constructor(boundary: string, limits: MultipartLimits) {
		this.dashBoundary = Buffer.from(`--${boundary}`)
		this.delimiter = Buffer.from(`\r\n--${boundary}`)
		this.limits = limits
	}

	write(chunk: Uint8Array) {
		if (this.state === 'done') return
		const buffer = this.carry.length
			? Buffer.concat([this.carry, chunk])
			: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
		let offset = 0
		this.tailStart = undefined

		while (!this.isDone() && this.tailStart === undefined)
			offset = this.scan(buffer, offset)

		this.carry =
			this.tailStart === undefined
				? Buffer.alloc(0)
				: Buffer.from(buffer.subarray(this.tailStart))
	}

	private isDone() {
		return this.state === 'done'
	}

	private keep(offset: number) {
		this.tailStart = offset
		return offset
	}

	private scan(buffer: Buffer, offset: number) {
		if (this.state === 'headers') return this.scanHeaders(buffer, offset)
		if (this.state === 'preamble') return this.scanPreamble(buffer, offset)
		return this.scanBody(buffer, offset)
	}

	private scanPreamble(buffer: Buffer, offset: number) {
		const index = buffer.indexOf(this.dashBoundary, offset)
		if (index === -1)
			return this.keep(
				Math.max(offset, buffer.length - this.dashBoundary.length + 1)
			)
		const afterBoundary = index + this.dashBoundary.length
		if (buffer.length < afterBoundary + 2) return this.keep(index)
		if (buffer[afterBoundary] === CR && buffer[afterBoundary + 1] === LF) {
			this.state = 'headers'
			return afterBoundary
		}
		return index + 1
	}

	private scanHeaders(buffer: Buffer, offset: number) {
		const headerEnd = buffer.indexOf(HEADER_END, offset)
		if (headerEnd === -1) {
			if (buffer.length - offset > MAX_PART_HEADER_BYTES)
				throw new BadRequestException('Malformed request body')
			return this.keep(offset)
		}
		if (headerEnd - offset > MAX_PART_HEADER_BYTES)
			throw new BadRequestException('Malformed request body')
		this.startPart(buffer.toString('latin1', offset + 2, headerEnd))
		this.state = 'body'
		return headerEnd + HEADER_END.length
	}

	private scanBody(buffer: Buffer, offset: number) {
		const index = buffer.indexOf(this.delimiter, offset)
		if (index === -1) {
			const scannedEnd = Math.max(
				offset,
				buffer.length - this.delimiter.length + 1
			)
			this.addPartBytes(scannedEnd - offset)
			return this.keep(scannedEnd)
		}

		this.addPartBytes(index - offset)
		const afterDelimiter = index + this.delimiter.length
		const isClose =
			buffer[afterDelimiter] === DASH && buffer[afterDelimiter + 1] === DASH
		const suffixStart = isClose ? afterDelimiter + 2 : afterDelimiter
		if (buffer.length < suffixStart + 2) return this.keep(index)
		if (buffer[suffixStart] === CR && buffer[suffixStart + 1] === LF) {
			this.state = isClose ? 'done' : 'headers'
			return afterDelimiter
		}

		this.addPartBytes(1)
		return index + 1
	}

	private addPartBytes(byteCount: number) {
		if (!this.isFile || byteCount <= 0) return
		this.partSize += byteCount
		const { fileSize } = this.limits
		if (fileSize !== undefined && this.partSize > fileSize)
			throw new PayloadTooLargeException('File too large')
	}

	private startPart(headers: string) {
		const classification = classifyMultipartPart(headers)
		if (!classification) throw new BadRequestException('Malformed request body')
		const { possiblyFile, possiblyField } = classification
		this.isFile = possiblyFile
		this.partSize = 0
		this.parts += 1
		if (possiblyFile) this.files += 1
		if (possiblyField) this.fields += 1
		assertMultipartCounts(
			{ fields: this.fields, files: this.files, parts: this.parts },
			this.limits
		)
	}
}

interface MultipartCounts {
	fields: number
	files: number
	parts: number
}

/**
 * Throws when part, file, or field counts exceed the configured limits.
 */
export function assertMultipartCounts(
	counts: MultipartCounts,
	limits: MultipartLimits
) {
	if (limits.parts !== undefined && counts.parts > limits.parts)
		throw new BadRequestException('Too many parts')
	if (limits.files !== undefined && counts.files > limits.files)
		throw new BadRequestException('Too many files')
	if (limits.fields !== undefined && counts.fields > limits.fields)
		throw new BadRequestException('Too many fields')
}

interface FormDataEntries {
	entries(): Iterable<[string, unknown]>
}

/**
 * Checks multipart limits against the parsed `FormData`, so the limits hold
 * for the runtime parser's own interpretation of the body as well.
 */
export function assertMultipartFormLimits(
	formData: FormDataEntries,
	limits: MultipartLimits | undefined
) {
	if (!hasMultipartLimits(limits)) return
	const counts: MultipartCounts = { fields: 0, files: 0, parts: 0 }
	for (const [, value] of formData.entries()) {
		counts.parts += 1
		if (typeof value === 'string') {
			counts.fields += 1
			continue
		}
		counts.files += 1
		if (limits.fileSize !== undefined && (value as Blob).size > limits.fileSize)
			throw new PayloadTooLargeException('File too large')
	}
	assertMultipartCounts(counts, limits)
}

function hasMultipartLimits(
	limits: MultipartLimits | undefined
): limits is MultipartLimits {
	return (
		limits !== undefined &&
		Object.values(limits).some(limit => limit !== undefined)
	)
}

/**
 * Reads the multipart boundary. A `Content-Type` that mentions `boundary=`
 * more than once is rejected, because Bun picks the first `boundary=`
 * substring while undici reads the `boundary` parameter. Quoted boundaries
 * with a backslash or an embedded quote are rejected too: undici unescapes
 * them as an RFC 7230 quoted-string while Bun reads them differently, so the
 * delimiter would be ambiguous.
 */
function getBoundary(contentType: string) {
	const matches = [...contentType.matchAll(BOUNDARY_PARAMETER_REGEX)]
	if (matches.length > 1)
		throw new BadRequestException('Malformed request body')
	const [match] = matches
	if (match?.index === undefined) return
	const rawValue = contentType.slice(match.index + match[0].length).trimStart()
	if (!rawValue.startsWith('"')) {
		const token = rawValue.match(BOUNDARY_TOKEN_REGEX)?.[0]
		if (token?.includes('"') || token?.includes('\\'))
			throw new BadRequestException('Malformed request body')
		return token || undefined
	}
	const closingQuote = rawValue.indexOf('"', 1)
	const quoted = rawValue.slice(1, closingQuote)
	const rest = rawValue.slice(closingQuote + 1)
	if (
		closingQuote === -1 ||
		quoted.includes('\\') ||
		!BOUNDARY_END_REGEX.test(rest)
	)
		throw new BadRequestException('Malformed request body')
	return quoted || undefined
}

/**
 * Creates a scanner for `multipart/form-data` requests when multipart limits
 * are configured, or returns `undefined` when there is nothing to enforce.
 */
export function createMultipartLimitScanner(
	contentType: string | undefined,
	limits: MultipartLimits | undefined
) {
	if (!hasMultipartLimits(limits)) return
	if (
		contentType?.split(';', 1)[0]?.trim().toLowerCase() !==
		'multipart/form-data'
	)
		return

	const boundary = getBoundary(contentType)
	if (!boundary) return

	return new MultipartLimitScanner(boundary, limits)
}
