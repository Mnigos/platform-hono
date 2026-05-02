import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'
import type { Context } from 'hono'
import type { HonoAdapterOptions, RequestSizeLimit } from '../options'
import { createBodyLimit, parseRequestBodyWithLimits } from './body-parser'

interface FakeRequest extends Record<string, unknown> {
	body?: unknown
	header: (name: string) => string | undefined
	method: string
	parseBody: () => Promise<unknown>
	path: string
	raw: Request
	rawBody?: Buffer
	text: () => Promise<string>
}

function createContext(options: {
	bodyText?: string
	headers?: Record<string, string>
	parsedBody?: unknown
	parseError?: Error
	path?: string
}) {
	const headers = new Headers(options.headers)
	const body =
		options.bodyText === undefined
			? undefined
			: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(options.bodyText))
						controller.close()
					},
				})
	const request: FakeRequest = {
		header: name => headers.get(name) ?? undefined,
		method: options.bodyText === undefined ? 'GET' : 'POST',
		parseBody: () =>
			options.parseError
				? Promise.reject(options.parseError)
				: Promise.resolve(options.parsedBody ?? {}),
		path: options.path ?? '/parse',
		raw: new Request(`http://localhost${options.path ?? '/parse'}`, {
			body,
			duplex: body ? 'half' : undefined,
			headers,
			method: options.bodyText === undefined ? 'GET' : 'POST',
		}),
		text: async () => options.bodyText ?? '',
	}

	return { req: request } as unknown as Context
}

async function parse(
	ctx: Context,
	options: HonoAdapterOptions = {},
	rawBody = false,
	requestSizeLimit?: RequestSizeLimit
) {
	await parseRequestBodyWithLimits(ctx, options, rawBody, requestSizeLimit)
	return ctx.req as unknown as FakeRequest
}

describe('body parser helpers', () => {
	test('parses JSON request bodies and stores raw bodies from one read', async () => {
		const bodyText = JSON.stringify({ ok: true })
		const req = await parse(
			createContext({
				bodyText,
				headers: { 'content-type': 'application/json' },
			}),
			{},
			true
		)

		expect(req.body).toEqual({ ok: true })
		expect(req.rawBody).toEqual(Buffer.from(bodyText))
	})

	test('parses empty JSON bodies as empty objects', async () => {
		const req = await parse(
			createContext({
				bodyText: '',
				headers: { 'content-type': 'application/json' },
			})
		)

		expect(req.body).toEqual({})
	})

	test('parses text request bodies and raw bodies', async () => {
		const req = await parse(
			createContext({
				bodyText: 'hello',
				headers: { 'content-type': 'text/plain' },
			}),
			{},
			true
		)

		expect(req.body).toBe('hello')
		expect(req.rawBody).toEqual(Buffer.from('hello'))
	})

	test('parses form and multipart request bodies', async () => {
		const formBody = { name: 'Ada' }
		const req = await parse(
			createContext({
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				parsedBody: formBody,
			})
		)

		expect(req.body).toBe(formBody)

		const multipartReq = await parse(
			createContext({
				headers: { 'content-type': 'multipart/form-data; boundary=test' },
				parsedBody: { file: new Blob(['abc']) },
			})
		)

		expect(multipartReq.body).toMatchObject({ file: expect.any(Blob) })
	})

	test('ignores unsupported content types', async () => {
		const req = await parse(
			createContext({
				bodyText: '<xml />',
				headers: { 'content-type': 'application/xml' },
			})
		)

		expect(req.body).toBeUndefined()
	})

	test('rejects malformed JSON and form bodies as bad requests', async () => {
		await expect(
			parse(
				createContext({
					bodyText: '{',
					headers: { 'content-type': 'application/json' },
				})
			)
		).rejects.toBeInstanceOf(BadRequestException)

		await expect(
			parse(
				createContext({
					headers: { 'content-type': 'multipart/form-data; boundary=test' },
					parseError: new Error('bad form'),
				})
			)
		).rejects.toBeInstanceOf(BadRequestException)
	})

	test('rejects oversized bodies by content length with custom message', async () => {
		const promise = parse(
			createContext({
				bodyText: 'hello',
				headers: {
					'content-length': '5',
					'content-type': 'text/plain',
				},
			}),
			{},
			false,
			{ errorMessage: 'Too much', maxBytes: 3, path: '/parse' }
		)

		await expect(promise).rejects.toBeInstanceOf(PayloadTooLargeException)
		await expect(promise).rejects.toMatchObject({ message: 'Too much' })
	})

	test('ignores invalid content length values before body limit enforcement', async () => {
		const req = await parse(
			createContext({
				bodyText: 'hello',
				headers: {
					'content-length': 'invalid',
					'content-type': 'text/plain',
				},
			}),
			{ bodyLimit: false },
			false,
			{ maxBytes: 10, path: '/parse' }
		)

		expect(req.body).toBe('hello')
	})

	test('rejects oversized bodies through the effective body limit', async () => {
		await expect(
			parse(
				createContext({
					bodyText: 'hello',
					headers: { 'content-type': 'text/plain' },
				}),
				{ bodyLimit: 3 }
			)
		).rejects.toBeInstanceOf(PayloadTooLargeException)
	})

	test('uses default payload-too-large messages when no custom message is provided', async () => {
		await expect(
			parse(
				createContext({
					bodyText: 'hello',
					headers: {
						'content-length': '5',
						'content-type': 'text/plain',
					},
				}),
				{ bodyLimit: false },
				false,
				{ maxBytes: 3, path: '/parse' }
			)
		).rejects.toMatchObject({ message: 'Payload too large' })
	})

	test('rejects oversized parsed bodies when global limit is disabled', async () => {
		await expect(
			parse(
				createContext({
					headers: { 'content-type': 'multipart/form-data; boundary=test' },
					parsedBody: { file: new Blob(['abc']), name: 'long-value' },
				}),
				{ bodyLimit: false },
				false,
				{
					errorMessage: 'Parsed payload too large',
					maxBytes: 3,
					path: '/parse',
				}
			)
		).rejects.toMatchObject({ message: 'Parsed payload too large' })
	})

	test('uses default message for oversized parsed bodies without custom message', async () => {
		await expect(
			parse(
				createContext({
					headers: { 'content-type': 'multipart/form-data; boundary=test' },
					parsedBody: { name: 'long-value' },
				}),
				{ bodyLimit: false },
				false,
				{ maxBytes: 3, path: '/parse' }
			)
		).rejects.toMatchObject({ message: 'Payload too large' })
	})

	test('counts nested arrays and primitive values for parsed body size', async () => {
		await expect(
			parse(
				createContext({
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					parsedBody: { values: ['abcd', 123, true, null] },
				}),
				{ bodyLimit: false },
				false,
				{
					errorMessage: 'Nested payload too large',
					maxBytes: 3,
					path: '/parse',
				}
			)
		).rejects.toMatchObject({ message: 'Nested payload too large' })
	})

	test('allows route-specific limits to override the default global limit', async () => {
		const req = await parse(
			createContext({
				bodyText: 'hello',
				headers: { 'content-type': 'text/plain' },
			}),
			{},
			false,
			{ maxBytes: 10, path: '/parse' }
		)

		expect(req.body).toBe('hello')
	})

	test('parses bodies when global body limit is disabled', async () => {
		const req = await parse(
			createContext({
				bodyText: 'hello',
				headers: { 'content-type': 'text/plain' },
			}),
			{ bodyLimit: false }
		)

		expect(req.body).toBe('hello')
	})

	test('uses the default global body limit when no explicit limit is configured', async () => {
		const req = await parse(
			createContext({
				bodyText: 'hello',
				headers: { 'content-type': 'text/plain' },
			})
		)

		expect(req.body).toBe('hello')
	})

	test('creates Nest-compatible body limit middleware', async () => {
		const middleware = createBodyLimit(3)
		const ctx = createContext({
			bodyText: 'hello',
			headers: {
				'content-length': '5',
				'content-type': 'text/plain',
			},
		})

		await expect(middleware(ctx, async () => undefined)).rejects.toBeInstanceOf(
			PayloadTooLargeException
		)
	})

	test('uses unknown size in body limit errors without content length', async () => {
		const middleware = createBodyLimit(3)
		const ctx = createContext({
			bodyText: 'hello',
			headers: { 'content-type': 'text/plain' },
		})

		await expect(middleware(ctx, async () => undefined)).rejects.toMatchObject({
			message:
				'Body size exceeded: 3 bytes. Size: unknown bytes. Method: POST. Path: /parse',
		})
	})
})
