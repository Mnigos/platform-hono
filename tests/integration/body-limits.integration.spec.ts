import { request } from 'node:http'
import { HonoAdapter } from '../../src'
import { getNestHonoRequest } from '../../src/helpers/request'
import { startApp } from './fixtures/minimal-nest-app'

function postChunks(url: string, chunks: string[]) {
	return new Promise<{ body: string; status?: number }>((resolve, reject) => {
		const client = request(
			url,
			{
				method: 'POST',
				headers: {
					'content-type': 'text/plain',
					'transfer-encoding': 'chunked',
				},
			},
			response => {
				const received: Buffer[] = []
				response.on('data', chunk => received.push(Buffer.from(chunk)))
				response.on('error', reject)
				response.on('end', () =>
					resolve({
						body: Buffer.concat(received).toString(),
						status: response.statusCode,
					})
				)
			}
		)
		client.on('error', reject)
		for (const chunk of chunks) client.write(chunk)
		client.end()
	})
}

const BOUNDARY = 'limits'
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`
function part(name: string, value: string, filename?: string) {
	return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ''}\r\n\r\n${value}\r\n`
}

async function postNeverEnding(url: string, chunk: string) {
	const abortController = new AbortController()
	const timer = setTimeout(() => abortController.abort(), 3000)
	try {
		const response = await fetch(url, {
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(chunk))
				},
			}),
			duplex: 'half',
			headers: { 'content-type': CONTENT_TYPE },
			method: 'POST',
			signal: abortController.signal,
		} as RequestInit & { duplex: 'half' })
		return { status: response.status, body: await response.json() }
	} finally {
		clearTimeout(timer)
		abortController.abort()
	}
}

describe('body stream integration', () => {
	test.each([
		'/echo',
		'/raw-upload',
	])('enforces declared and chunked body limits while preserving allowed bodies at %s', async path => {
		const app = await startApp(
			new HonoAdapter({ bodyLimit: 4, skipBodyParserFor: ['/raw-upload'] })
		)
		try {
			for (const body of ['four', 'longer']) {
				const response = await fetch(`${app.baseUrl}${path}`, {
					body,
					method: 'POST',
					headers: {
						'content-type': 'text/plain',
						'content-length': String(body.length),
					},
				})
				expect(response.status).toBe(body.length > 4 ? 413 : 201)
				if (body.length === 4)
					await expect(response.json()).resolves.toEqual(
						path === '/echo' ? { body } : { size: 4 }
					)
			}
			const allowed = await postChunks(`${app.baseUrl}${path}`, ['fo', 'ur'])
			expect(allowed.status).toBe(201)
			expect(JSON.parse(allowed.body)).toEqual(
				path === '/echo' ? { body: 'four' } : { size: 4 }
			)
			expect(
				(await postChunks(`${app.baseUrl}${path}`, ['four', 'more'])).status
			).toBe(413)
		} finally {
			await app.close()
		}
	})

	test.each([
		['application/json', '{ "message": "żółw" }', { message: 'żółw' }],
		['text/plain', 'żółw\n', 'żółw\n'],
	])('retains exact raw bytes while parsing %s', async (contentType, body, parsed) => {
		const app = await startApp(new HonoAdapter(), { rawBody: true })
		try {
			const response = await fetch(`${app.baseUrl}/echo`, {
				body: String(body),
				method: 'POST',
				headers: { 'content-type': String(contentType) },
			})
			expect(response.status).toBe(201)
			await expect(response.json()).resolves.toEqual({
				body: parsed,
				rawBody: body,
			})
		} finally {
			await app.close()
		}
	})

	test('leaves a skipped webhook stream unread with rawBody enabled', async () => {
		const adapter = new HonoAdapter({
			bodyLimit: 128,
			skipBodyParserFor: ['/webhook'],
		})
		const app = await startApp(adapter, { rawBody: true }, () => {
			adapter.registerParserMiddleware('', true)
			adapter.post('/webhook', async (request, ctx) => {
				const req = getNestHonoRequest(request)
				const used = request.raw.bodyUsed
				return ctx.json({
					used,
					parsed: req.body !== undefined,
					rawBody: req.rawBody !== undefined,
					payload: await request.raw.text(),
				})
			})
		})
		try {
			const payload = '{ "signed": true }'
			const response = await fetch(`${app.baseUrl}/webhook`, {
				method: 'POST',
				body: payload,
				headers: { 'content-type': 'application/json' },
			})
			expect(response.status).toBe(200)
			await expect(response.json()).resolves.toEqual({
				used: false,
				parsed: false,
				rawBody: false,
				payload,
			})
		} finally {
			await app.close()
		}
	})

	test.each([
		'before',
		'after',
	])('runs a custom raw parser registered %s the defaults', async order => {
		const adapter = new HonoAdapter()
		if (order === 'after') adapter.registerParserMiddleware('', false)
		adapter.useBodyParser('raw', false)
		const app = await startApp(adapter)
		try {
			const response = await fetch(`${app.baseUrl}/echo`, {
				body: 'custom',
				method: 'POST',
				headers: { 'content-type': 'application/octet-stream' },
			})
			expect(response.status).toBe(201)
			await expect(response.json()).resolves.toEqual({
				body: { type: 'Buffer', data: [...Buffer.from('custom')] },
			})
		} finally {
			await app.close()
		}
	})

	test.each([
		'GET',
		'HEAD',
	])('currently parses a bodyless %s with JSON Content-Type as an empty object', async method => {
		const adapter = new HonoAdapter()
		adapter.registerParserMiddleware('', false)
		const seen: unknown[] = []
		const app = await startApp(adapter, {}, () => {
			adapter.get('/bodyless', (req, ctx) => {
				seen.push(getNestHonoRequest(req).body)
				return ctx.json({ ok: true })
			})
		})
		try {
			const response = await fetch(`${app.baseUrl}/bodyless`, {
				method,
				headers: { 'content-type': 'application/json' },
			})
			expect(response.status).toBe(200)
			expect(seen).toEqual([{}])
			if (method === 'HEAD') expect(await response.text()).toBe('')
		} finally {
			await app.close()
		}
	})

	test.each([
		'/echo',
		'/raw-upload',
	])('enforces each multipart limit on %s before an unfinished body ends', async path => {
		const cases = [
			{
				limits: { fileSize: 4 },
				chunk: part('file', 'x'.repeat(64), 'file.txt'),
				status: 413,
				message: 'File too large',
			},
			{
				limits: { files: 1 },
				chunk: part('a', 'a', 'a.txt') + part('b', '', 'b.txt'),
				status: 400,
				message: 'Too many files',
			},
			{
				limits: { fields: 1 },
				chunk: part('a', 'a') + part('b', ''),
				status: 400,
				message: 'Too many fields',
			},
			{
				limits: { parts: 1 },
				chunk: part('a', 'a') + part('b', '', 'b.txt'),
				status: 400,
				message: 'Too many parts',
			},
			{
				limits: { parts: 1 },
				chunk: `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${'x'.repeat(17 * 1024)}`,
				status: 400,
				message: 'Malformed request body',
			},
		]
		for (const { limits, chunk, status, message } of cases) {
			const app = await startApp(
				new HonoAdapter({
					bodyLimit: false,
					multipartLimits: limits,
					skipBodyParserFor: ['/raw-upload'],
				})
			)
			try {
				expect(
					await postNeverEnding(`${app.baseUrl}${path}`, chunk)
				).toMatchObject({ status, body: { statusCode: status, message } })
			} finally {
				await app.close()
			}
		}
	})

	test('keeps a multipart body unread on a skipped route after checking its limits', async () => {
		const body =
			part('field', 'value') +
			part('file', '1234', 'a.txt') +
			`--${BOUNDARY}--\r\n`
		const app = await startApp(
			new HonoAdapter({
				multipartLimits: { fields: 1, files: 1, parts: 2, fileSize: 4 },
				skipBodyParserFor: ['/raw-upload'],
			})
		)
		try {
			const response = await fetch(`${app.baseUrl}/raw-upload`, {
				body,
				method: 'POST',
				headers: { 'content-type': CONTENT_TYPE },
			})
			expect(response.status).toBe(201)
			await expect(response.json()).resolves.toEqual({
				size: Buffer.byteLength(body),
			})
		} finally {
			await app.close()
		}
	})
})
