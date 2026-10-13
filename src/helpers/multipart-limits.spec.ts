import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'
import type { MultipartLimits } from '../options'
import { createMultipartLimitScanner } from './multipart-limits'

interface MultipartEntry {
	content: string
	filename?: string
	name: string
}

async function encodeMultipart(entries: MultipartEntry[]) {
	const formData = new FormData()
	for (const { content, filename, name } of entries) {
		if (filename) formData.append(name, new Blob([content]), filename)
		else formData.append(name, content)
	}
	const request = new Request('http://localhost/upload', {
		method: 'POST',
		body: formData,
	})
	const contentType = request.headers.get('content-type') ?? ''
	return {
		body: new Uint8Array(await request.arrayBuffer()),
		contentType,
	}
}

async function scanInChunks(
	entries: MultipartEntry[],
	limits: MultipartLimits,
	chunkSize: number
) {
	const { body, contentType } = await encodeMultipart(entries)
	const scanner = createMultipartLimitScanner(contentType, limits)
	if (!scanner) throw new Error('Expected a multipart scanner')
	for (let offset = 0; offset < body.length; offset += chunkSize)
		scanner.write(body.subarray(offset, offset + chunkSize))
}

function scanBodyInChunks(
	body: string,
	limits: MultipartLimits,
	chunkSize: number,
	contentType = 'multipart/form-data; boundary=x'
) {
	const scanner = createMultipartLimitScanner(contentType, limits)
	if (!scanner) throw new Error('Expected a multipart scanner')
	const bytes = Buffer.from(body)
	for (let offset = 0; offset < bytes.length; offset += chunkSize)
		scanner.write(bytes.subarray(offset, offset + chunkSize))
}

function filePart(content: string, disposition = 'name="f"; filename="x"') {
	return `--x\r\nContent-Disposition: form-data; ${disposition}\r\n\r\n${content}\r\n--x--\r\n`
}

const ENTRIES = [
	{ content: 'alpha', name: 'first' },
	{ content: 'beta', name: 'second' },
	{ content: '0123456789', filename: 'one.txt', name: 'upload' },
	{ content: 'xyz', filename: 'two.txt', name: 'upload' },
] as const satisfies MultipartEntry[]

const CHUNK_SIZES = [1, 2, 3, 7, 16, 64, 4096] as const

describe('createMultipartLimitScanner', () => {
	test('skips requests without multipart limits, content type, or boundary', () => {
		expect(
			createMultipartLimitScanner('multipart/form-data; boundary=x', undefined)
		).toBeUndefined()
		expect(
			createMultipartLimitScanner('multipart/form-data; boundary=x', {
				files: undefined,
			})
		).toBeUndefined()
		expect(
			createMultipartLimitScanner('application/json', { files: 1 })
		).toBeUndefined()
		expect(
			createMultipartLimitScanner('multipart/form-data', { files: 1 })
		).toBeUndefined()
		expect(
			createMultipartLimitScanner('multipart/form-data; boundary="a b"', {
				files: 1,
			})
		).toBeDefined()
	})

	test.each(
		CHUNK_SIZES
	)('accepts bodies at the exact limits with %i byte chunks', async chunkSize => {
		await expect(
			scanInChunks(
				ENTRIES,
				{ fields: 2, fileSize: 10, files: 2, parts: 4 },
				chunkSize
			)
		).resolves.toBeUndefined()
	})

	test.each(
		CHUNK_SIZES
	)('rejects files over fileSize with %i byte chunks', async chunkSize => {
		await expect(
			scanInChunks(ENTRIES, { fileSize: 9 }, chunkSize)
		).rejects.toThrow(new PayloadTooLargeException('File too large'))
	})

	test.each([
		[{ files: 1 }, 'Too many files'],
		[{ fields: 1 }, 'Too many fields'],
		[{ parts: 3 }, 'Too many parts'],
	] as const)('rejects bodies over %o', async (limits, message) => {
		for (const chunkSize of CHUNK_SIZES)
			await expect(scanInChunks(ENTRIES, limits, chunkSize)).rejects.toThrow(
				new BadRequestException(message)
			)
	})

	test('does not count field values against fileSize', async () => {
		await expect(
			scanInChunks(
				[{ content: 'a long field value', name: 'field' }],
				{ fileSize: 1 },
				5
			)
		).resolves.toBeUndefined()
	})

	test('rejects as soon as the limit is crossed, before the body ends', () => {
		const scanner = createMultipartLimitScanner(
			'multipart/form-data; boundary=edge',
			{ fileSize: 4 }
		)
		const encoder = new TextEncoder()

		scanner?.write(
			encoder.encode(
				'--edge\r\nContent-Disposition: form-data; name="f"; filename="a"\r\n\r\n'
			)
		)
		expect(() => scanner?.write(encoder.encode('1234567890123456'))).toThrow(
			new PayloadTooLargeException('File too large')
		)
	})

	test.each([
		'multipart/form-data; xboundary=decoy; boundary=real',
		'multipart/form-data; boundary=decoy; boundary=real',
	])('rejects ambiguous boundary parameters in %s', contentType => {
		expect(() =>
			createMultipartLimitScanner(contentType, { fileSize: 1 })
		).toThrow(new BadRequestException('Malformed request body'))
	})

	test.each(
		CHUNK_SIZES
	)('uses a quoted boundary for file limits with %i byte chunks', chunkSize => {
		const contentType = 'multipart/form-data; boundary="real"'
		const body = filePart('x'.repeat(2000)).replaceAll('--x', '--real')
		expect(() =>
			scanBodyInChunks(body, { fileSize: 2000 }, chunkSize, contentType)
		).not.toThrow()
		expect(() =>
			scanBodyInChunks(body, { fileSize: 1 }, chunkSize, contentType)
		).toThrow(new PayloadTooLargeException('File too large'))
	})

	test.each(
		CHUNK_SIZES
	)('counts a fake delimiter as file data with %i byte chunks', chunkSize => {
		const content = `abc\r\n--xNO\r\n\r\n${'z'.repeat(10_000)}`
		expect(Buffer.byteLength(content)).toBe(10_014)
		expect(() =>
			scanBodyInChunks(filePart(content), { fileSize: 5 }, chunkSize)
		).toThrow(new PayloadTooLargeException('File too large'))
		expect(() =>
			scanBodyInChunks(filePart(content), { fileSize: 10_014 }, chunkSize)
		).not.toThrow()
	})

	test.each([
		'NO\r\n\r\n',
		' \t\r\n',
		'-- \t\r\n',
	])('keeps the delimiter suffix %j as file data at every chunk offset', suffix => {
		const delimiter = `\r\n--x${suffix}`
		const chunkSize = delimiter.length + 1
		for (let padding = 0; padding < chunkSize; padding += 1) {
			// Shift the delimiter across every possible chunk boundary.
			const content = `abc${delimiter}${'z'.repeat(32)}`
			const body = `${'p'.repeat(padding)}${filePart(content)}`
			for (const size of [1, chunkSize]) {
				expect(() => scanBodyInChunks(body, { fileSize: 5 }, size)).toThrow(
					new PayloadTooLargeException('File too large')
				)
				expect(() =>
					scanBodyInChunks(body, { fileSize: content.length }, size)
				).not.toThrow()
			}
		}
	})

	test('ends parts and closes the body only at complete CRLF delimiters at every chunk offset', () => {
		const body = filePart('abc').replace(
			'--x--\r\n',
			'--x\r\nContent-Disposition: form-data; name="second"; filename="y"\r\n\r\nxyz\r\n--x--\r\n'
		)
		const chunkSize = '\r\n--x--\r\n'.length + 1
		for (let padding = 0; padding < chunkSize; padding += 1) {
			const shiftedBody = `${'p'.repeat(padding)}${body}${'epilogue'.repeat(20)}`
			for (const size of [1, chunkSize]) {
				expect(() =>
					scanBodyInChunks(
						shiftedBody,
						{ files: 2, parts: 2, fileSize: 3 },
						size
					)
				).not.toThrow()
				expect(() => scanBodyInChunks(shiftedBody, { files: 1 }, size)).toThrow(
					new BadRequestException('Too many files')
				)
			}
		}
	})

	test.each([
		[{ files: 0 }, 'Too many files'],
		[{ fileSize: 1 }, 'File too large'],
	] as const)('counts a spaced filename parameter against %o', (limits, message) => {
		for (const chunkSize of CHUNK_SIZES)
			expect(() =>
				scanBodyInChunks(
					filePart('x'.repeat(64), 'name="f"; filename = "x"'),
					limits,
					chunkSize
				)
			).toThrow(message)
	})

	test.each([
		[{ fields: 0 }, 'Too many fields'],
		[{ files: 0 }, 'Too many files'],
		[{ fileSize: 1 }, 'File too large'],
	] as const)('counts filename* against %o for both parser interpretations', (limits, message) => {
		for (const chunkSize of CHUNK_SIZES)
			expect(() =>
				scanBodyInChunks(
					filePart('x'.repeat(64), 'name="f"; filename*=UTF-8\'\'x'),
					limits,
					chunkSize
				)
			).toThrow(message)
	})

	test.each([
		'name="f; filename=decoy"',
		'name="f\\"; filename=decoy"',
	])('does not treat filename text inside the quoted parameter %s as a file', disposition => {
		for (const chunkSize of CHUNK_SIZES) {
			expect(() =>
				scanBodyInChunks(
					filePart('value', disposition),
					{ files: 0, fields: 1, fileSize: 0 },
					chunkSize
				)
			).not.toThrow()
			expect(() =>
				scanBodyInChunks(
					filePart('value', disposition),
					{ fields: 0 },
					chunkSize
				)
			).toThrow(new BadRequestException('Too many fields'))
		}
	})

	test('recognizes filenames containing escaped quotes and semicolons', () => {
		for (const chunkSize of CHUNK_SIZES) {
			const body = filePart('value', 'name="f\\";part"; filename="x\\";y"')
			expect(() =>
				scanBodyInChunks(body, { files: 1, fields: 0, fileSize: 5 }, chunkSize)
			).not.toThrow()
			expect(() => scanBodyInChunks(body, { files: 0 }, chunkSize)).toThrow(
				new BadRequestException('Too many files')
			)
		}
	})

	test('rejects a complete part header over 16 KiB in one chunk', () => {
		const scanner = createMultipartLimitScanner(
			'multipart/form-data; boundary=edge',
			{ parts: 1 }
		)
		expect(() =>
			scanner?.write(
				Buffer.from(
					`--edge\r\nContent-Disposition: form-data; name="${'x'.repeat(17 * 1024)}"\r\n\r\nvalue\r\n--edge--\r\n`
				)
			)
		).toThrow(new BadRequestException('Malformed request body'))
	})

	test('rejects oversized part headers as malformed', () => {
		const scanner = createMultipartLimitScanner(
			'multipart/form-data; boundary=edge',
			{ parts: 1 }
		)

		scanner?.write(new TextEncoder().encode('--edge\r\n'))
		expect(() => scanner?.write(new Uint8Array(17 * 1024).fill(65))).toThrow(
			new BadRequestException('Malformed request body')
		)
	})
})
