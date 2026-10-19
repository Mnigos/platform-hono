import { createConnection } from 'node:net'
import { HonoAdapter } from '../../src'
import { getNestHonoRequest } from '../../src/helpers/request'
import { startApp } from './fixtures/minimal-nest-app'

const isBunRuntime = 'Bun' in globalThis
const parserCases = [
	['json', 'application/json'],
	['urlencoded', 'application/x-www-form-urlencoded'],
	['text', 'text/plain'],
	['multipart', 'multipart/form-data; boundary=missing'],
	['raw', 'application/octet-stream'],
	['custom', 'application/vnd.test+json'],
] as const

const framingCases = [
	'zero',
	'double-zero',
	'length',
	'chunked-empty',
	'chunked-body',
] as const

function parserPayload(parser: string) {
	switch (parser) {
		case 'json':
			return { body: '{"message":"framed"}', parsed: { message: 'framed' } }
		case 'urlencoded':
			return { body: 'message=framed+body', parsed: { message: 'framed body' } }
		case 'multipart':
			return {
				body: '--missing\r\nContent-Disposition: form-data; name="message"\r\n\r\nframed\r\n--missing--\r\n',
				parsed: { message: 'framed' },
			}
		case 'raw':
			return {
				body: 'raw bytes',
				parsed: { type: 'Buffer', data: [...Buffer.from('raw bytes')] },
			}
		case 'custom':
			return { body: '{"custom":true}', parsed: { custom: true } }
		default:
			return { body: 'framed text', parsed: 'framed text' }
	}
}

function sendBody(
	url: string,
	method: string,
	contentType: string,
	framing: (typeof framingCases)[number],
	payload: string
) {
	// Use identical wire bytes on both runtimes, including chunked GETs.
	const target = new URL(url)
	const chunked = framing.startsWith('chunked')
	const body = framing === 'length' || framing === 'chunked-body' ? payload : ''
	const length = Buffer.byteLength(body)
	const wireBody = chunked
		? `${body ? `${length.toString(16)}\r\n${body}\r\n` : ''}0\r\n\r\n`
		: body
	return new Promise<string>((resolve, reject) => {
		const client = createConnection({
			host: target.hostname,
			port: Number(target.port),
		})
		let response = ''
		client.setEncoding('utf8')
		client.setTimeout(3000, () => {
			client.destroy()
			reject(new Error('Timed out waiting for raw HTTP response'))
		})
		client.on('data', chunk => {
			response += chunk
		})
		client.on('error', reject)
		client.on('end', () => resolve(response))
		client.on('connect', () =>
			client.write(
				[
					`${method} ${target.pathname} HTTP/1.1`,
					'Host: localhost',
					'Connection: close',
					`Content-Type: ${contentType}`,
					chunked
						? 'Transfer-Encoding: chunked'
						: `Content-Length: ${framing === 'double-zero' ? '00' : length}`,
					'',
					wireBody,
				].join('\r\n')
			)
		)
	}).then(response => {
		const end = response.indexOf('\r\n\r\n')
		const headers = response.slice(0, end).toLowerCase()
		let body = response.slice(end + 4)
		if (headers.includes('transfer-encoding: chunked')) {
			let decoded = ''
			while (body) {
				const lineEnd = body.indexOf('\r\n')
				const size = Number.parseInt(body.slice(0, lineEnd), 16)
				if (!size) break
				decoded += body.slice(lineEnd + 2, lineEnd + 2 + size)
				body = body.slice(lineEnd + 2 + size + 2)
			}
			body = decoded
		}
		return {
			status: Number(response.slice(9, 12)),
			body: JSON.parse(body) as unknown,
		}
	})
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('GET body parsing', () => {
	test.each(
		parserCases
	)('leaves a bodyless %s GET undefined over HTTP and direct Hono dispatch', async (parser, contentType) => {
		const adapter = new HonoAdapter()
		if (parser === 'raw') adapter.useBodyParser('raw', true)
		if (parser === 'custom') adapter.useBodyParser(contentType, true)
		const app = await startApp(adapter, { rawBody: true }, () => {
			adapter.get('/bodyless', (req, ctx) => {
				const nestReq = getNestHonoRequest(req)
				return ctx.json({
					bodyUndefined: nestReq.body === undefined,
					rawBodyUndefined: nestReq.rawBody === undefined,
					hasRawBody: Object.hasOwn(req, 'rawBody'),
				})
			})
		})
		try {
			const headers = { 'content-type': contentType, host: 'localhost' }
			const expected = {
				bodyUndefined: true,
				rawBodyUndefined: true,
				hasRawBody: false,
			}
			const http = await fetch(`${app.baseUrl}/bodyless`, { headers })
			expect(http.status).toBe(200)
			await expect(http.json()).resolves.toEqual(expected)
			const direct = await adapter.hono.request('/bodyless', { headers })
			expect(direct.status).toBe(200)
			await expect(direct.json()).resolves.toEqual(expected)
		} finally {
			await app.close()
		}
	})

	test.each([
		false,
		true,
	])('leaves a framed GET body undefined, chunked=%s', async chunked => {
		const adapter = new HonoAdapter()
		const app = await startApp(adapter, { rawBody: true }, () => {
			adapter.get('/get-body', (req, ctx) =>
				ctx.json({
					bodyUndefined: getNestHonoRequest(req).body === undefined,
					hasRawBody: Object.hasOwn(req, 'rawBody'),
					ownHeaders: Object.hasOwn(req, 'headers'),
				})
			)
		})
		try {
			expect(
				await sendBody(
					`${app.baseUrl}/get-body`,
					'GET',
					'application/json',
					chunked ? 'chunked-body' : 'length',
					'{"message":"framed"}'
				)
			).toEqual({
				status: 200,
				body: {
					bodyUndefined: true,
					hasRawBody: false,
					ownHeaders: !isBunRuntime,
				},
			})
		} finally {
			await app.close()
		}
	})

	describe.each(
		parserCases
	)('%s parser over raw sockets', (parser, contentType) => {
		test.each(
			framingCases
		)('never parses GET with %s framing', async framing => {
			const adapter = new HonoAdapter()
			if (parser === 'raw') adapter.useBodyParser('raw', true)
			if (parser === 'custom') adapter.useBodyParser(contentType, true)
			const app = await startApp(adapter, { rawBody: true }, () => {
				adapter.get('/get-body', (req, ctx) =>
					ctx.json({
						bodyUndefined: getNestHonoRequest(req).body === undefined,
						rawBodyUndefined: getNestHonoRequest(req).rawBody === undefined,
						hasRawBody: Object.hasOwn(req, 'rawBody'),
						ownHeaders: Object.hasOwn(req, 'headers'),
					})
				)
			})
			try {
				expect(
					await sendBody(
						`${app.baseUrl}/get-body`,
						'GET',
						contentType,
						framing,
						parserPayload(parser).body
					)
				).toEqual({
					status: 200,
					body: {
						bodyUndefined: true,
						rawBodyUndefined: true,
						hasRawBody: false,
						ownHeaders:
							!isBunRuntime || parser === 'raw' || parser === 'custom',
					},
				})
			} finally {
				await app.close()
			}
		})

		test.each(
			framingCases
		)('still parses POST with %s framing', async framing => {
			const adapter = new HonoAdapter()
			if (parser === 'raw') adapter.useBodyParser('raw', true)
			if (parser === 'custom') adapter.useBodyParser(contentType, true)
			const app = await startApp(adapter, { rawBody: true }, () => {
				adapter.post('/post-body', (req, ctx) =>
					ctx.json({
						body: getNestHonoRequest(req).body,
						rawBody: getNestHonoRequest(req).rawBody?.toString(),
						hasRawBody: Object.hasOwn(req, 'rawBody'),
					})
				)
			})
			try {
				const nonempty = framing === 'length' || framing === 'chunked-body'
				const payload = parserPayload(parser)
				let emptyBody: unknown = {}
				if (parser === 'raw') emptyBody = { type: 'Buffer', data: [] }
				if (parser === 'text') emptyBody = ''
				const response = await sendBody(
					`${app.baseUrl}/post-body`,
					'POST',
					contentType,
					framing,
					payload.body
				)
				if (parser === 'multipart' && !nonempty) {
					// An empty multipart body is malformed; the unchanged POST parser rejects it.
					expect(response.status).toBe(400)
				} else {
					expect(response).toEqual({
						status: 200,
						body: {
							body: nonempty ? payload.parsed : emptyBody,
							rawBody: nonempty ? payload.body : '',
							hasRawBody: true,
						},
					})
				}
			} finally {
				await app.close()
			}
		})
	})

	test('leaves GET with Content-Length zero bodyless and keeps HEAD parsing unchanged', async () => {
		const adapter = new HonoAdapter()
		const seen: unknown[] = []
		const app = await startApp(adapter, { rawBody: true }, () => {
			adapter.get('/zero', (req, ctx) => {
				const nestReq = getNestHonoRequest(req)
				seen.push({ body: nestReq.body, rawBody: nestReq.rawBody?.toString() })
				return ctx.text('ok')
			})
		})
		try {
			for (const method of ['GET', 'HEAD']) {
				const response = await fetch(`${app.baseUrl}/zero`, {
					headers: {
						host: 'localhost',
						'content-type': 'application/json',
						'content-length': '0',
					},
					method,
				})
				expect(response.status).toBe(200)
				await expect(response.text()).resolves.toBe(
					method === 'HEAD' ? '' : 'ok'
				)
			}
			expect(seen).toEqual([
				{ body: undefined, rawBody: undefined },
				{ body: {}, rawBody: '' },
			])
		} finally {
			await app.close()
		}
	})

	test.each([
		'raw',
		'custom',
	] as const)('keeps the explicitly registered %s parser working on POST', async parser => {
		const adapter = new HonoAdapter()
		const contentType =
			parser === 'raw'
				? 'application/octet-stream'
				: 'application/vnd.test+json'
		adapter.useBodyParser(parser === 'raw' ? 'raw' : contentType, true)
		const app = await startApp(adapter)
		try {
			const body = parser === 'raw' ? 'raw bytes' : '{"custom":true}'
			const response = await fetch(`${app.baseUrl}/echo`, {
				body,
				headers: { 'content-type': contentType },
				method: 'POST',
			})
			expect(response.status).toBe(201)
			await expect(response.json()).resolves.toEqual({
				body:
					parser === 'raw'
						? { type: 'Buffer', data: [...Buffer.from(body)] }
						: { custom: true },
				rawBody: body,
			})
		} finally {
			await app.close()
		}
	})
})
