import { request } from 'node:http'
import { HttpException, type NestApplicationOptions } from '@nestjs/common'
import { HonoAdapter } from '../../src'
import { createMultipartLimitScanner } from '../../src/helpers/multipart-limits'
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
		['request', undefined],
		['request', '0'],
		['request', '1'],
		['fetch', undefined],
		['fetch', '0'],
		['fetch', '1'],
	] as const)('rejects an unframed six-byte body through %s with Content-Length %s', async (method, contentLength) => {
		const adapter = new HonoAdapter({ bodyLimit: 3 })
		adapter.initHttpServer({ rawBody: false })
		adapter.setErrorHandler((error, _req, ctx) => {
			if (!(error instanceof HttpException)) throw error
			adapter.reply(ctx, error.getResponse(), error.getStatus())
		})
		adapter.post('/direct', (req, ctx) =>
			ctx.json({ body: getNestHonoRequest(req).body })
		)
		const headers = new Headers({ 'content-type': 'text/plain' })
		if (contentLength !== undefined)
			headers.set('content-length', contentLength)
		const request = new Request('http://localhost/direct', {
			body: '123456',
			headers,
			method: 'POST',
		})
		try {
			const response = await adapter.getInstance()[method](request)
			expect(response.status).toBe(413)
			await expect(response.json()).resolves.toMatchObject({ statusCode: 413 })
		} finally {
			await adapter.close()
		}
	})

	test('delivers a correctly framed body to the handler before the client finishes sending', async () => {
		const adapter = new HonoAdapter({
			bodyLimit: 6,
			skipBodyParserFor: ['/stream-prefix'],
		})
		let observePrefix: (bytes: number[]) => void = () => undefined
		const prefix = new Promise<number[]>(resolve => {
			observePrefix = resolve
		})
		const app = await startApp(adapter, {}, () => {
			adapter.post('/stream-prefix', async (req, ctx) => {
				const bytes: number[] = []
				const reader = req.raw.body?.getReader()
				if (!reader) throw new Error('Expected a request body')
				for (;;) {
					const { done, value } = await reader.read()
					if (done) break
					bytes.push(...value)
					if (bytes.length === 3) observePrefix([...bytes])
				}
				return ctx.json({ bytes })
			})
		})
		const abortController = new AbortController()
		let bodyController!: ReadableStreamDefaultController<Uint8Array>
		const response = fetch(`${app.baseUrl}/stream-prefix`, {
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					bodyController = controller
					controller.enqueue(Buffer.from('abc'))
				},
			}),
			duplex: 'half',
			method: 'POST',
			headers: { 'content-type': 'text/plain', 'content-length': '6' },
			signal: abortController.signal,
		} as RequestInit & { duplex: 'half' })
		response.catch(() => undefined)
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			await expect(
				Promise.race([
					prefix,
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(
							() =>
								reject(
									new Error(
										'Handler did not receive the prefix before the body ended'
									)
								),
							2000
						)
					}),
				])
			).resolves.toEqual([...Buffer.from('abc')])
			bodyController.enqueue(Buffer.from('def'))
			bodyController.close()
			const result = await response
			expect(result.status).toBe(200)
			await expect(result.json()).resolves.toEqual({
				bytes: [...Buffer.from('abcdef')],
			})
		} finally {
			clearTimeout(timer)
			abortController.abort()
			await response.catch(() => undefined)
			await app.close()
		}
	})

	test.each([
		'multipart/form-data; xboundary=decoy; boundary=real',
		'multipart/form-data; boundary=decoy; boundary=real',
	])('rejects ambiguous multipart boundaries over HTTP: %s', async contentType => {
		const app = await startApp(
			new HonoAdapter({ multipartLimits: { fileSize: 1 } })
		)
		try {
			const response = await fetch(`${app.baseUrl}/echo`, {
				method: 'POST',
				headers: { 'content-type': contentType },
				body: `--real\r\nContent-Disposition: form-data; name="f"; filename="x"\r\n\r\n${'x'.repeat(2000)}\r\n--real--\r\n`,
			})
			expect(response.status).toBe(400)
			await expect(response.json()).resolves.toMatchObject({
				message: 'Malformed request body',
			})
		} finally {
			await app.close()
		}
	})

	test.each([
		'real',
		'"real"',
	])('uses boundary %s for parsing and file-size limits over HTTP', async boundary => {
		const app = await startApp(
			new HonoAdapter({ multipartLimits: { fileSize: 1 } })
		)
		try {
			for (const size of [1, 2000]) {
				const response = await fetch(`${app.baseUrl}/echo`, {
					method: 'POST',
					headers: {
						'content-type': `multipart/form-data; boundary=${boundary}`,
					},
					body: `--real\r\nContent-Disposition: form-data; name="f"; filename="x"\r\n\r\n${'x'.repeat(size)}\r\n--real--\r\n`,
				})
				expect(response.status).toBe(size === 1 ? 201 : 413)
				if (size > 1)
					await expect(response.json()).resolves.toMatchObject({
						message: 'File too large',
					})
				else await response.arrayBuffer()
			}
		} finally {
			await app.close()
		}
	})

	test.each([
		{ fileSize: 1 },
		{ files: 0 },
	] as const)('rejects part headers that only one runtime parser accepts with limits %o', async limits => {
		for (const disposition of [
			' Content-Disposition: form-data; name="f"; filename="x"',
			'Content-Disposition: form-data; name="f"; filename="x"\n',
		]) {
			const body = `--x\r\n${disposition}\r\n\r\n1234567890\r\n--x--\r\n`
			const contentType = 'multipart/form-data; boundary=x'
			const scanner = createMultipartLimitScanner(contentType, limits)
			expect(() => scanner?.write(Buffer.from(body))).toThrow(
				'Malformed request body'
			)
			const app = await startApp(new HonoAdapter({ multipartLimits: limits }))
			try {
				const response = await fetch(`${app.baseUrl}/echo`, {
					body,
					method: 'POST',
					headers: { 'content-type': contentType },
				})
				expect(response.status).toBe(400)
				await expect(response.json()).resolves.toMatchObject({
					statusCode: 400,
					message: 'Malformed request body',
				})
			} finally {
				await app.close()
			}
		}
	})

	test.each([
		'application/json',
		'text/plain',
	])('preserves BOM and invalid UTF-8 bytes on a skipped %s route with rawBody disabled', async contentType => {
		const bytes = [0xef, 0xbb, 0xbf, 0x61, 0xff]
		const app = await startApp(
			new HonoAdapter({ skipBodyParserFor: ['/echo/bytes'] }),
			{ rawBody: false }
		)
		try {
			const response = await fetch(`${app.baseUrl}/echo/bytes`, {
				body: new Uint8Array(bytes),
				method: 'POST',
				headers: { 'content-type': contentType },
			})
			expect(response.status).toBe(201)
			await expect(response.json()).resolves.toEqual({ bytes, rawBody: false })
		} finally {
			await app.close()
		}
	})

	test.each([
		'application/json',
		'text/plain',
	])('delivers exact %s bytes to a custom parser with rawBody disabled', async contentType => {
		const bytes = [0xef, 0xbb, 0xbf, 0x61, 0xff]
		const adapter = new HonoAdapter({ skipBodyParserFor: ['/echo/bytes'] })
		const app = await startApp(adapter, { rawBody: false }, () => {
			adapter.use(async (req, _ctx, next) => {
				getNestHonoRequest(req).body = [
					...new Uint8Array(await req.raw.clone().arrayBuffer()),
				]
				await next()
			})
		})
		try {
			const response = await fetch(`${app.baseUrl}/echo/bytes`, {
				body: new Uint8Array(bytes),
				method: 'POST',
				headers: { 'content-type': contentType },
			})
			expect(response.status).toBe(201)
			await expect(response.json()).resolves.toEqual({
				body: bytes,
				bytes,
				rawBody: false,
			})
		} finally {
			await app.close()
		}
	})

	test('decodes a text BOM for Body while preserving invalid UTF-8 bytes for the Req reader', async () => {
		const bytes = [0xef, 0xbb, 0xbf, 0x61, 0xff]
		const app = await startApp(new HonoAdapter(), { rawBody: false })
		try {
			const response = await fetch(`${app.baseUrl}/echo/bytes`, {
				body: new Uint8Array(bytes),
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
			})
			expect(response.status).toBe(201)
			await expect(response.json()).resolves.toEqual({
				body: 'a\ufffd',
				bytes,
				rawBody: false,
			})
		} finally {
			await app.close()
		}
	})

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

	const parserDisabledConfigurations = [
		[
			'skipBodyParserFor',
			{ skipBodyParserFor: ['/raw-upload'] as string[] },
			{} as NestApplicationOptions,
		],
		[
			'bodyParser: false',
			{} as { skipBodyParserFor?: string[] },
			{ bodyParser: false } as NestApplicationOptions,
		],
	] as const

	test.each(
		parserDisabledConfigurations.flatMap(
			([label, adapterOptions, appOptions]) =>
				[
					[
						'leading whitespace',
						` Content-Disposition: form-data; name="file"; filename="a.txt"`,
					],
					[
						'a trailing bare LF',
						`Content-Disposition: form-data; name="file"; filename="a.txt"\n`,
					],
				].map(
					([form, header]) =>
						[label, form, header, adapterOptions, appOptions] as const
				)
		)
	)('rejects multipart part headers with %s and %s without parsing', async (_label, _form, header, adapterOptions, appOptions) => {
		const body =
			`--${BOUNDARY}\r\n${header}\r\n\r\n${'x'.repeat(1000)}\r\n` +
			`--${BOUNDARY}--\r\n`
		const app = await startApp(
			new HonoAdapter({
				...adapterOptions,
				multipartLimits: { fileSize: 1, files: 0 },
			}),
			appOptions
		)
		try {
			const response = await fetch(`${app.baseUrl}/raw-upload`, {
				body,
				method: 'POST',
				headers: { 'content-type': CONTENT_TYPE },
			})
			expect(response.status).toBe(400)
			await expect(response.json()).resolves.toMatchObject({
				message: 'Malformed request body',
			})
		} finally {
			await app.close()
		}
	})

	test.each(
		parserDisabledConfigurations
	)('enforces multipart file limits with %s', async (_label, adapterOptions, appOptions) => {
		for (const [limits, status] of [
			[{ fileSize: 1 }, 413],
			[{ files: 0 }, 400],
		] as const) {
			const app = await startApp(
				new HonoAdapter({ ...adapterOptions, multipartLimits: limits }),
				appOptions
			)
			try {
				const response = await fetch(`${app.baseUrl}/raw-upload`, {
					body: `${part('file', 'x'.repeat(1000), 'a.txt')}--${BOUNDARY}--\r\n`,
					method: 'POST',
					headers: { 'content-type': CONTENT_TYPE },
				})
				expect(response.status).toBe(status)
			} finally {
				await app.close()
			}
		}
	})

	test('counts a request body that middleware replaced after the server framed the original', async () => {
		const adapter = new HonoAdapter({ bodyLimit: 4 })
		adapter.hono.use(async (ctx, next) => {
			const original = ctx.req.raw
			ctx.req.raw = new Request(original.url, {
				body: 'x'.repeat(1000),
				headers: original.headers,
				method: original.method,
			})
			await next()
		})
		const app = await startApp(adapter)
		try {
			const response = await new Promise<{ status?: number }>(
				(resolve, reject) => {
					const client = request(
						`${app.baseUrl}/echo`,
						{
							headers: { 'content-length': '1', 'content-type': 'text/plain' },
							method: 'POST',
						},
						incoming => {
							incoming.resume()
							incoming.on('end', () => resolve({ status: incoming.statusCode }))
						}
					)
					client.on('error', reject)
					client.end('x')
				}
			)
			expect(response.status).toBe(413)
		} finally {
			await app.close()
		}
	})
})
