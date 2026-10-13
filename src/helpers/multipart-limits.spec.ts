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
	const response = new Response(formData)
	return {
		body: new Uint8Array(await response.arrayBuffer()),
		contentType: response.headers.get('content-type') ?? '',
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
				new PayloadTooLargeException(message)
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
