import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'
import type { MultipartLimits } from '../options'

type ScannerState = 'body' | 'done' | 'headers'

const BOUNDARY_REGEX = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i
const FILE_PART_REGEX = /^content-disposition:[^\r\n]*;\s*filename\*?=/im
const HEADER_END = Buffer.from('\r\n\r\n')
const DASH = 45
const MAX_PART_HEADER_BYTES = 16 * 1024

/**
 * Counts multipart parts while the body streams in and throws as soon as a
 * configured part, field, file, or file size limit is exceeded, before the
 * remaining body is read or `Request.formData()` buffers it. Status codes
 * follow Nest's multer mapping: 413 for file size, 400 for count limits.
 */
export class MultipartLimitScanner {
	private carry: Buffer = Buffer.from('\r\n')
	private fields = 0
	private files = 0
	private inPart = false
	private isFile = false
	private partSize = 0
	private parts = 0
	private state: ScannerState = 'body'
	private readonly delimiter: Buffer
	private readonly limits: MultipartLimits

	constructor(boundary: string, limits: MultipartLimits) {
		this.delimiter = Buffer.from(`\r\n--${boundary}`)
		this.limits = limits
	}

	write(chunk: Uint8Array) {
		if (this.state === 'done') return
		const buffer = Buffer.concat([this.carry, chunk])
		let offset = 0

		while (this.state !== 'done') {
			if (this.state === 'headers') {
				const headerEnd = buffer.indexOf(HEADER_END, offset)
				if (headerEnd === -1) {
					if (buffer.length - offset > MAX_PART_HEADER_BYTES)
						throw new BadRequestException('Malformed request body')
					break
				}
				this.startPart(buffer.toString('latin1', offset, headerEnd))
				offset = headerEnd + HEADER_END.length
				this.state = 'body'
				continue
			}

			const delimiterIndex = buffer.indexOf(this.delimiter, offset)
			if (delimiterIndex === -1) {
				const scannedEnd = Math.max(
					offset,
					buffer.length - this.delimiter.length + 1
				)
				this.addPartBytes(scannedEnd - offset)
				offset = scannedEnd
				break
			}

			this.addPartBytes(delimiterIndex - offset)
			offset = delimiterIndex
			const afterDelimiter = delimiterIndex + this.delimiter.length
			if (buffer.length < afterDelimiter + 2) break

			this.inPart = false
			offset = afterDelimiter
			this.state =
				buffer[afterDelimiter] === DASH && buffer[afterDelimiter + 1] === DASH
					? 'done'
					: 'headers'
		}

		this.carry = Buffer.from(buffer.subarray(offset))
	}

	private addPartBytes(byteCount: number) {
		if (!(this.inPart && this.isFile)) return
		this.partSize += byteCount
		const { fileSize } = this.limits
		if (fileSize !== undefined && this.partSize > fileSize)
			throw new PayloadTooLargeException('File too large')
	}

	private startPart(headers: string) {
		this.inPart = true
		this.isFile = FILE_PART_REGEX.test(headers)
		this.partSize = 0
		this.parts += 1
		if (this.isFile) this.files += 1
		else this.fields += 1

		const { fields, files, parts } = this.limits
		if (parts !== undefined && this.parts > parts)
			throw new BadRequestException('Too many parts')
		if (files !== undefined && this.files > files)
			throw new BadRequestException('Too many files')
		if (fields !== undefined && this.fields > fields)
			throw new BadRequestException('Too many fields')
	}
}

/**
 * Creates a scanner for `multipart/form-data` requests when multipart limits
 * are configured, or returns `undefined` when there is nothing to enforce.
 */
export function createMultipartLimitScanner(
	contentType: string | undefined,
	limits: MultipartLimits | undefined
) {
	if (!(limits && Object.values(limits).some(limit => limit !== undefined)))
		return
	if (
		contentType?.split(';', 1)[0]?.trim().toLowerCase() !==
		'multipart/form-data'
	)
		return

	const match = contentType.match(BOUNDARY_REGEX)
	const boundary = match?.[1] ?? match?.[2]
	if (!boundary) return

	return new MultipartLimitScanner(boundary, limits)
}
