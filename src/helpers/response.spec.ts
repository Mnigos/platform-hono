import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import { StreamableFile } from '@nestjs/common'
import { Hono } from 'hono'
import {
	createResponse,
	finalizeResponse,
	getFinalizedResponse,
	normalizeContext,
} from './response'

async function getContext(environment: object = {}) {
	const app = new Hono()
	let capturedContext: Parameters<typeof createResponse>[0] | undefined

	app.get('/', ctx => {
		capturedContext = ctx
		return ctx.text('ok')
	})

	await app.request('/', undefined, environment)

	if (!capturedContext) throw new Error('Context was not captured')
	return capturedContext
}

function delay(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

describe('response helpers', () => {
	test('normalizes direct and lazy contexts', async () => {
		const ctx = await getContext()

		expect(await normalizeContext(ctx)).toBe(ctx)
		expect(await normalizeContext(async () => ctx)).toBe(ctx)
	})

	test('creates JSON responses for object bodies', async () => {
		const ctx = await getContext()

		const response = await createResponse(ctx, { ok: true })

		expect(response.headers.get('content-type')).toContain('application/json')
		await expect(response.json()).resolves.toEqual({ ok: true })
	})

	test('creates binary responses for buffer bodies', async () => {
		const ctx = await getContext()

		const response = await createResponse(ctx, Buffer.from('abc'))

		expect(response.headers.get('content-type')).toBe(
			'application/octet-stream'
		)
		await expect(response.text()).resolves.toBe('abc')
	})

	test('creates streamable file responses with file headers', async () => {
		const ctx = await getContext()
		const file = new StreamableFile(Readable.from(['abc']), {
			disposition: 'attachment; filename="file.txt"',
			length: 3,
			type: 'text/plain',
		})

		const response = await createResponse(ctx, file)

		expect(response.headers.get('content-type')).toBe('text/plain')
		expect(response.headers.get('content-disposition')).toBe(
			'attachment; filename="file.txt"'
		)
		expect(response.headers.get('content-length')).toBe('3')
		await expect(response.text()).resolves.toBe('abc')
	})

	test('creates direct Node readable stream responses', async () => {
		const ctx = await getContext()

		const response = await createResponse(ctx, Readable.from(['node stream']))

		expect(response.headers.get('content-type')).toBe(
			'application/octet-stream'
		)
		await expect(response.text()).resolves.toBe('node stream')
	})

	test('preserves explicit content types for direct streams', async () => {
		const ctx = await getContext()
		ctx.res.headers.set('Content-Type', 'text/plain; charset=utf-8')

		const response = await createResponse(ctx, Readable.from(['node stream']))

		expect(response.headers.get('content-type')).toBe(
			'text/plain; charset=utf-8'
		)
		await expect(response.text()).resolves.toBe('node stream')
	})

	test('creates direct Web readable stream responses', async () => {
		const ctx = await getContext()
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('web stream'))
				controller.close()
			},
		})

		const response = await createResponse(ctx, stream)

		expect(response.headers.get('content-type')).toBe(
			'application/octet-stream'
		)
		await expect(response.text()).resolves.toBe('web stream')
	})

	test('streams streamable file chunks as they become available', async () => {
		const ctx = await getContext()
		const stream = new PassThrough()
		const file = new StreamableFile(stream, {
			type: 'text/plain',
		})

		const response = await createResponse(ctx, file)
		const reader = response.body?.getReader()

		if (!reader) throw new Error('Expected a response body reader')

		stream.write('first')
		const firstChunk = await reader.read()
		expect(firstChunk.done).toBe(false)
		expect(new TextDecoder().decode(firstChunk.value)).toBe('first')

		const secondRead = reader.read()
		await expect(
			Promise.race([
				secondRead.then(() => 'resolved'),
				delay(10).then(() => 'pending'),
			])
		).resolves.toBe('pending')

		stream.end('second')
		const secondChunk = await secondRead
		expect(secondChunk.done).toBe(false)
		expect(new TextDecoder().decode(secondChunk.value)).toBe('second')
		await expect(reader.read()).resolves.toMatchObject({ done: true })
	})

	test('rejects unsupported streamable file chunk shapes', async () => {
		const ctx = await getContext()
		const file = new StreamableFile(
			Readable.from([{ unexpected: true }], { objectMode: true })
		)

		const response = await createResponse(ctx, file)

		await expect(response.text()).rejects.toThrow(
			'Unsupported response stream chunk type: object, constructor: Object'
		)
	})

	test('runs StreamableFile error handlers and loggers', async () => {
		const ctx = await getContext()
		const streamError = new Error('stream failed')
		const errorHandlerSpy = vi.fn()
		const errorLoggerSpy = vi.fn()
		const file = new StreamableFile(
			new Readable({
				read() {
					this.destroy(streamError)
				},
			})
		)
			.setErrorHandler(errorHandlerSpy)
			.setErrorLogger(errorLoggerSpy)

		const response = await createResponse(ctx, file)

		await expect(response.text()).rejects.toThrow('stream failed')
		expect(errorHandlerSpy).toHaveBeenCalledWith(
			streamError,
			expect.objectContaining({
				destroyed: false,
				headersSent: false,
				statusCode: 200,
			})
		)
		expect(errorLoggerSpy).toHaveBeenCalledWith(streamError)
	})

	test('preserves prebuilt responses', async () => {
		const ctx = await getContext()
		const response = new Response('created', {
			headers: { 'x-result': 'ok' },
			status: 201,
		})

		const createdResponse = await createResponse(ctx, response)

		expect(createdResponse.status).toBe(201)
		expect(createdResponse.headers.get('x-result')).toBe('ok')
		await expect(createdResponse.text()).resolves.toBe('created')
	})

	test('serializes objects for structured JSON content types', async () => {
		const ctx = await getContext()
		ctx.res.headers.set('Content-Type', 'application/problem+json')

		const response = await createResponse(ctx, { title: 'Bad request' })

		expect(response.headers.get('content-type')).toBe(
			'application/problem+json'
		)
		await expect(response.json()).resolves.toEqual({ title: 'Bad request' })
	})

	test('preserves existing non-empty context response for empty bodies', async () => {
		const ctx = await getContext()
		ctx.res = new Response('already done', { status: 202 })

		const response = await createResponse(ctx)

		expect(response.status).toBe(202)
		await expect(response.text()).resolves.toBe('already done')
	})

	test('creates empty responses for undefined bodies', async () => {
		const ctx = await getContext()

		const response = await createResponse(ctx)

		expect(response.body).toBeNull()
	})

	test('finalizes responses idempotently', async () => {
		const ctx = await getContext()
		const response = new Response('ok', {
			headers: { 'x-finalized': 'yes' },
			status: 201,
		})

		const finalized = finalizeResponse(ctx, response)

		expect(finalized).toBe(ctx.res)
		expect(finalizeResponse(ctx, response)).toBe(finalized)
		expect(ctx.res.status).toBe(201)
		expect(ctx.res.headers.get('x-finalized')).toBe('yes')
		await expect(finalized.text()).resolves.toBe('ok')
	})

	test('propagates cancellation through finalized response streams', async () => {
		const app = new Hono()
		const cancelSpy = vi.fn()

		app.get('/', ctx =>
			getFinalizedResponse(
				ctx,
				new ReadableStream({
					cancel: cancelSpy,
					start(controller) {
						controller.enqueue(new TextEncoder().encode('chunk'))
					},
				})
			)
		)

		const response = await app.request('/')
		const reader = response.body?.getReader()

		if (!reader) throw new Error('Expected a response body reader')
		await reader.read()
		const cancellation = reader.cancel('done')

		await expect(
			Promise.race([
				cancellation.then(() => 'cancelled'),
				delay(25).then(() => 'pending'),
			])
		).resolves.toBe('cancelled')
		expect(cancelSpy).toHaveBeenCalledWith('done')
	})

	test('cancels Web response streams when the client disconnects', async () => {
		const socket = new EventEmitter()
		const cancelSpy = vi.fn()
		const ctx = await getContext({ incoming: { socket } })
		const response = await createResponse(
			ctx,
			new ReadableStream({ cancel: cancelSpy })
		)
		const reader = response.body?.getReader()

		if (!reader) throw new Error('Expected a response body reader')
		const pendingRead = reader.read()
		socket.emit('close')

		await expect(pendingRead).resolves.toMatchObject({ done: true })
		expect(cancelSpy).toHaveBeenCalledOnce()
	})

	test('cancels prebuilt Response streams when the client disconnects', async () => {
		const socket = new EventEmitter()
		const cancelSpy = vi.fn()
		const ctx = await getContext({ incoming: { socket } })
		const response = await createResponse(
			ctx,
			new Response(new ReadableStream({ cancel: cancelSpy }))
		)
		const reader = response.body?.getReader()

		if (!reader) throw new Error('Expected a response body reader')
		const pendingRead = reader.read()
		socket.emit('close')

		await expect(pendingRead).resolves.toMatchObject({ done: true })
		expect(cancelSpy).toHaveBeenCalledOnce()
	})

	test('destroys Node response streams when the client disconnects', async () => {
		const socket = new EventEmitter()
		const stream = new PassThrough()
		const ctx = await getContext({ incoming: { socket } })
		const response = await createResponse(ctx, stream)
		const reader = response.body?.getReader()

		if (!reader) throw new Error('Expected a response body reader')
		const pendingRead = reader.read()
		socket.emit('close')

		await expect(pendingRead).resolves.toMatchObject({ done: true })
		expect(stream.destroyed).toBe(true)
	})

	test('builds and finalizes responses in one step', async () => {
		const ctx = await getContext()

		const response = await getFinalizedResponse(ctx, 'hello')

		expect(ctx.res.status).toBe(response.status)
		await expect(response.text()).resolves.toBe('hello')
	})
})
