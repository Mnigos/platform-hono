import { PassThrough, Readable } from 'node:stream'
import { StreamableFile } from '@nestjs/common'
import { Hono } from 'hono'
import {
	createResponse,
	finalizeResponse,
	getFinalizedResponse,
	normalizeContext,
} from './response'

async function getContext() {
	const app = new Hono()
	let capturedContext: Parameters<typeof createResponse>[0] | undefined

	app.get('/', ctx => {
		capturedContext = ctx
		return ctx.text('ok')
	})

	await app.request('/')

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

	test('preserves prebuilt responses', async () => {
		const ctx = await getContext()
		const response = new Response('created', {
			headers: { 'x-result': 'ok' },
			status: 201,
		})

		expect(await createResponse(ctx, response)).toBe(response)
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

		expect(finalizeResponse(ctx, response)).toBe(response)
		expect(finalizeResponse(ctx, response)).toBe(response)
		expect(ctx.res.status).toBe(201)
		expect(ctx.res.headers.get('x-finalized')).toBe('yes')
	})

	test('builds and finalizes responses in one step', async () => {
		const ctx = await getContext()

		const response = await getFinalizedResponse(ctx, 'hello')

		expect(ctx.res.status).toBe(response.status)
		await expect(response.text()).resolves.toBe('hello')
	})
})
