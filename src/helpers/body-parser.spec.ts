import { BadRequestException, PayloadTooLargeException } from '@nestjs/common'
import type { Context } from 'hono'
import type { HonoAdapterOptions, RequestSizeLimit } from '../options'
import {
	createBodyLimit,
	enforceRequestBodyLimit,
	parseRequestBodyWithLimits,
} from './body-parser'

interface FakeRequest extends Record<string, unknown> {
	body?: unknown
	header: (name: string) => string | undefined
	method: string
	path: string
	raw: Request
	rawBody?: Buffer
}

function createContext(options: {
	bodyBytes?: Uint8Array
	bodyText?: string
	environment?: object
	headers?: Record<string, string>
	path?: string
	signal?: AbortSignal
}) {
	const headers = new Headers(options.headers)
	const bodyBytes =
		options.bodyBytes ??
		(options.bodyText === undefined
			? undefined
			: new TextEncoder().encode(options.bodyText))
	const body =
		bodyBytes === undefined
			? undefined
			: new ReadableStream({
					start(controller) {
						controller.enqueue(bodyBytes)
						controller.close()
					},
				})
	const request: FakeRequest = {
		header: name => headers.get(name) ?? undefined,
		method: bodyBytes === undefined ? 'GET' : 'POST',
		path: options.path ?? '/parse',
		raw: new Request(`http://localhost${options.path ?? '/parse'}`, {
			body,
			duplex: body ? 'half' : undefined,
			headers,
			method: bodyBytes === undefined ? 'GET' : 'POST',
			signal: options.signal,
		}),
	}

	return { env: options.environment, req: request } as unknown as Context
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
		await expect(req.raw.text()).resolves.toBe(bodyText)
	})

	test('preserves exact raw JSON bytes before UTF-8 decoding', async () => {
		const bodyBytes = new Uint8Array([0x22, 0x80, 0x22])
		const req = await parse(
			createContext({
				bodyBytes,
				headers: { 'content-type': 'application/json' },
			}),
			{},
			true
		)

		expect(req.body).toBe('\uFFFD')
		expect(req.rawBody).toEqual(Buffer.from(bodyBytes))
		expect(Buffer.from(await req.raw.arrayBuffer())).toEqual(
			Buffer.from(bodyBytes)
		)
	})

	test('parses application structured JSON media types', async () => {
		const req = await parse(
			createContext({
				bodyText: '{"ok":true}',
				headers: {
					'content-type': 'Application/Problem+JSON; charset=utf-8',
				},
			})
		)

		expect(req.body).toEqual({ ok: true })
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

	test('parses URL-encoded request bodies', async () => {
		const req = await parse(
			createContext({
				bodyText: 'name=Ada',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
			})
		)

		expect(req.body).toEqual({ name: 'Ada' })
		await expect(req.raw.text()).resolves.toBe('name=Ada')
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

	test('enforces body limits for unsupported content types', async () => {
		await expect(
			parse(
				createContext({
					bodyText: '<xml />',
					headers: { 'content-type': 'application/xml' },
				}),
				{ bodyLimit: 3 }
			)
		).rejects.toBeInstanceOf(PayloadTooLargeException)
	})

	test('exposes body-limit enforcement for skipped parsing', async () => {
		await expect(
			enforceRequestBodyLimit(
				createContext({
					bodyText: 'hello',
					headers: { 'content-type': 'application/octet-stream' },
				}),
				{ bodyLimit: 3 }
			)
		).rejects.toBeInstanceOf(PayloadTooLargeException)
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

	test('destroys bodyless Node requests with oversized content lengths', async () => {
		const destroy = vi.fn()
		const ctx = createContext({
			environment: { incoming: { destroy } },
			headers: { 'content-length': '1000000000' },
		})

		await expect(
			enforceRequestBodyLimit(ctx, { bodyLimit: 3 })
		).rejects.toBeInstanceOf(PayloadTooLargeException)
		expect(destroy).toHaveBeenCalledOnce()
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

	test('treats a zero-byte body limit as an active limit', async () => {
		await expect(
			parse(
				createContext({
					bodyText: 'x',
					headers: { 'content-type': 'text/plain' },
				}),
				{ bodyLimit: 0 }
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

	test('preserves the source abort signal when rebuilding a request', async () => {
		const controller = new AbortController()
		const req = await parse(
			createContext({
				bodyText: 'hello',
				headers: { 'content-type': 'text/plain' },
				signal: controller.signal,
			})
		)

		expect(req.raw.signal.aborted).toBe(false)
		controller.abort()
		expect(req.raw.signal.aborted).toBe(true)
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
