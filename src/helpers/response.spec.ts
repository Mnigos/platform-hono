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
