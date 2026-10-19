import { EventEmitter } from 'node:events'
import { Context, Hono } from 'hono'
import { HonoRequest } from 'hono/request'
import { getNestHonoRequest } from '../helpers/request'
import type { HonoAdapterOptions } from '../options'
import { prepareRequest } from '../request/request-layer'
import { getRequestState } from '../request/request-state'
import { ContextOptionsRecord, getAdapterContextClass } from './hono-context'

function createContexts(
	withSocket: boolean,
	options: HonoAdapterOptions = {},
	request = new Request('http://localhost/items/hello%20world?q=value', {
		headers: {
			'x-forwarded-for': '203.0.113.1, 10.0.0.1',
			'x-test': 'initial',
		},
	})
) {
	const AdapterContext = getAdapterContextClass(withSocket)
	if (!AdapterContext) throw new Error('Expected compatible Hono classes')
	const hono = new Hono()
	hono.get('/items/:id', ctx => ctx.text('unused'))
	const path = '/items/hello%20world'
	const socket = Object.assign(new EventEmitter(), {
		remoteAddress: '127.0.0.1',
	})
	const env = withSocket
		? { incoming: { headers: {}, socket }, outgoing: new EventEmitter() }
		: { requestIP: () => ({ address: '192.0.2.1' }), timeout: () => undefined }
	const matchResult = hono.router.match('GET', path)
	const contextOptions = new ContextOptionsRecord(
		env,
		matchResult,
		ctx => ctx.text('missing', 404),
		path
	)
	const fast = new AdapterContext(request, contextOptions)
	const fallback = new Context(request.clone() as Request, {
		...contextOptions,
		matchResult,
	})
	prepareRequest(fast, options, [])
	prepareRequest(fallback, options, [])
	return { fast, fallback }
}

function enumerableKeys(value: object) {
	const keys: string[] = []
	// biome-ignore lint/suspicious/useGuardForIn: inherited enumerable accessors are the behavior under test
	for (const key in value) keys.push(key)
	return keys.sort()
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.doUnmock('hono')
	vi.resetModules()
})

describe.each([
	true,
	false,
])('adapter-owned Hono classes, socket=%s', withSocket => {
	test('preserves Hono identity and only adds its own prototype layer', () => {
		const contextDescriptors = Object.getOwnPropertyDescriptors(
			Context.prototype
		)
		const requestDescriptors = Object.getOwnPropertyDescriptors(
			HonoRequest.prototype
		)
		const { fast, fallback } = createContexts(withSocket)
		expect(fast).toBeInstanceOf(Context)
		expect(fast.req).toBeInstanceOf(HonoRequest)
		expect(fast.constructor).toBe(fallback.constructor)
		expect(fast.req.constructor).toBe(fallback.req.constructor)
		expect(Object.getPrototypeOf(Object.getPrototypeOf(fast))).toBe(
			Context.prototype
		)
		expect(Object.getPrototypeOf(Object.getPrototypeOf(fast.req))).toBe(
			HonoRequest.prototype
		)
		expect(Object.getOwnPropertyDescriptors(Context.prototype)).toEqual(
			contextDescriptors
		)
		expect(Object.getOwnPropertyDescriptors(HonoRequest.prototype)).toEqual(
			requestDescriptors
		)
	})

	test('inherits compatibility fields while fallback keeps own fields and enumeration', () => {
		const { fast, fallback } = createContexts(withSocket)
		const requestKeys = ['headers', 'ip', ...(withSocket ? ['socket'] : [])]
		for (const key of requestKeys) {
			expect(key in fast.req).toBe(true)
			expect(Object.hasOwn(fast.req, key)).toBe(false)
			expect(Object.hasOwn(fallback.req, key)).toBe(true)
			expect(
				Object.getOwnPropertyDescriptor(Object.getPrototypeOf(fast.req), key)
			).toMatchObject({
				configurable: true,
				enumerable: true,
				get: expect.any(Function),
				set: expect.any(Function),
			})
		}
		if (!withSocket) expect('socket' in fast.req).toBe(false)
		for (const key of ['raw', 'res']) {
			expect(
				Object.getOwnPropertyDescriptor(Object.getPrototypeOf(fast), key)
			).toMatchObject({
				configurable: true,
				enumerable: key === 'raw',
				get: expect.any(Function),
				set: expect.any(Function),
			})
			expect(key in fast).toBe(true)
			expect(Object.hasOwn(fast, key)).toBe(false)
			expect(Object.hasOwn(fallback, key)).toBe(true)
		}
		expect(enumerableKeys(fast.req)).toEqual(enumerableKeys(fallback.req))
		expect(enumerableKeys(fast)).toEqual(enumerableKeys(fallback))
		expect(Object.keys(fast.req)).toEqual(
			Object.keys(fallback.req).filter(key => !requestKeys.includes(key))
		)
		expect(Object.keys(fast)).toEqual(
			Object.keys(fallback).filter(key => key !== 'raw')
		)
		expect({ ...fast.req }).not.toHaveProperty('headers')
		expect(JSON.parse(JSON.stringify(fast.req))).not.toHaveProperty('headers')
		expect({ ...fallback.req }).toHaveProperty('headers', {
			'x-forwarded-for': '203.0.113.1, 10.0.0.1',
			'x-test': 'initial',
		})
	})

	test.each([
		false,
		true,
	])('preserves IP and header values with trustProxy=%s', trustProxy => {
		const { fast, fallback } = createContexts(withSocket, { trustProxy })
		const fastRequest = getNestHonoRequest(fast.req)
		const fallbackRequest = getNestHonoRequest(fallback.req)
		expect(fastRequest.ip).toBe(fallbackRequest.ip)
		const directIp = withSocket ? '127.0.0.1' : '192.0.2.1'
		expect(fastRequest.ip).toBe(trustProxy ? '10.0.0.1' : directIp)
		expect(fastRequest.headers).toEqual(fallbackRequest.headers)
		expect(Object.getPrototypeOf(fastRequest.headers)).toBe(Object.prototype)
		expect(fastRequest.headers).toBe(fastRequest.headers)
		if (withSocket) {
			expect(fastRequest.socket).toBe(fastRequest.socket)
			expect(fastRequest.socket).toHaveProperty('remoteAddress', '127.0.0.1')
			expect(fastRequest.socket).toBe(
				(fast.req.raw as Request & { socket?: unknown }).socket
			)
		}
	})

	test('refreshes cached headers when raw request is replaced and isolates requests', () => {
		const { fast, fallback } = createContexts(withSocket)
		for (const ctx of [fast, fallback]) {
			const request = getNestHonoRequest(ctx.req)
			const original = request.headers
			if (!original) throw new Error('Expected request headers')
			original.local = 'changed'
			ctx.req.raw = new Request('http://localhost/replaced', {
				headers: { 'x-test': 'replacement' },
			})
			expect(request.headers).toEqual({ 'x-test': 'replacement' })
			expect(request.headers).not.toBe(original)
			expect(Object.getPrototypeOf(request.headers)).toBe(Object.prototype)
		}
		expect(
			getNestHonoRequest(createContexts(withSocket).fast.req).headers
		).toEqual({
			'x-forwarded-for': '203.0.113.1, 10.0.0.1',
			'x-test': 'initial',
		})
	})

	test('assignments replace inherited compatibility accessors with own data properties', () => {
		const { fast, fallback } = createContexts(withSocket)
		for (const ctx of [fast, fallback]) {
			const request = getNestHonoRequest(ctx.req)
			const fields = {
				headers: { custom: 'header' },
				ip: '198.51.100.2',
				...(withSocket ? { socket: { custom: 'socket' } } : {}),
			}
			for (const [name, value] of Object.entries(fields)) {
				request[name] = value
				expect(Object.getOwnPropertyDescriptor(ctx.req, name)).toEqual({
					configurable: true,
					enumerable: true,
					value,
					writable: true,
				})
			}
			const raw = { custom: 'raw' }
			;(ctx as Context & { raw: unknown }).raw = raw
			expect(Object.getOwnPropertyDescriptor(ctx, 'raw')).toEqual({
				configurable: true,
				enumerable: true,
				value: raw,
				writable: true,
			})
		}
	})

	test('tracks response reads and preserves Hono response setter behavior', async () => {
		const { fast, fallback } = createContexts(withSocket)
		for (const ctx of [fast, fallback]) {
			const state = getRequestState(ctx, {})
			expect(state.touched).toBe(false)
			ctx.res.headers.set('x-retained', 'yes')
			expect(state.touched).toBe(true)
			ctx.res = new Response('replacement', { status: 201 })
			expect(ctx.finalized).toBe(true)
			expect(ctx.res.status).toBe(201)
			expect(ctx.res.headers.get('x-retained')).toBe('yes')
			await expect(ctx.res.text()).resolves.toBe('replacement')
		}
		expect(Object.hasOwn(fast, 'res')).toBe(false)
	})

	test('creates the same lazy SSE facade without installing an own raw property', () => {
		const { fast, fallback } = createContexts(withSocket)
		const fastRaw = (fast as Context & { raw: unknown }).raw
		const fallbackRaw = (fallback as Context & { raw: unknown }).raw
		expect(fastRaw).toBe((fast as Context & { raw: unknown }).raw)
		expect(fastRaw?.constructor).toBe(fallbackRaw?.constructor)
		expect(fastRaw).toMatchObject({
			write: expect.any(Function),
			end: expect.any(Function),
			on: expect.any(Function),
		})
		expect(Object.hasOwn(fast, 'raw')).toBe(false)
	})
})

test('adapter initialization leaves a second Hono app unchanged', async () => {
	const before = new Hono()
	const after = new Hono()
	const inspect = (ctx: Context) =>
		ctx.json({
			contextKeys: Object.keys(ctx),
			requestKeys: Object.keys(ctx.req),
			contextEnumerable: enumerableKeys(ctx),
			requestEnumerable: enumerableKeys(ctx.req),
			hasHeaders: 'headers' in ctx.req,
			hasIp: 'ip' in ctx.req,
			hasSocket: 'socket' in ctx.req,
			hasRaw: 'raw' in ctx,
			ownRes: Object.hasOwn(ctx, 'res'),
		})
	before.get('/plain', inspect)
	const initial = await (await before.request('/plain')).json()
	createContexts(true)
	createContexts(false)
	after.get('/plain', inspect)
	expect(await (await after.request('/plain')).json()).toEqual(initial)
	expect(initial).toMatchObject({
		hasHeaders: false,
		hasIp: false,
		hasSocket: false,
		hasRaw: false,
		ownRes: false,
	})
})

test('binds Nest view methods on the first adapter-owned request, including detached private methods', async () => {
	// Reload this module so no earlier fallback request can seed its method cache.
	vi.resetModules()
	const { getNestRequest: getFirstNestRequest } = await import(
		'../request/nest-request'
	)
	const { fast } = createContexts(
		true,
		{},
		new Request('http://localhost/items/hello%20world?q=value', {
			method: 'POST',
			body: '{"ok":true}',
			headers: { 'content-type': 'application/json', 'x-test': 'value' },
		})
	)
	const request = getFirstNestRequest(fast.req)
	const { param, header, json, text, arrayBuffer } = request
	expect(request.param('id')).toBe('hello world')
	expect(param('id')).toBe('hello world')
	expect(request.header('x-test')).toBe('value')
	expect(header('x-test')).toBe('value')
	await expect(json()).resolves.toEqual({ ok: true })
	await expect(text()).resolves.toBe('{"ok":true}')
	await expect(arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer)
	expect(getFirstNestRequest(fast.req)).toBe(request)
})

describe('Hono compatibility probes', () => {
	test('caches the successful class separately for Node and Bun', async () => {
		const { getAdapterContextClass: getFreshClass } = await import(
			'./hono-context'
		)
		expect(getFreshClass(true)).toBe(getFreshClass(true))
		expect(getFreshClass(false)).toBe(getFreshClass(false))
		expect(getFreshClass(true)).not.toBe(getFreshClass(false))
	})

	test.each([
		'key mismatch',
		'missing context class',
		'missing request class',
		'no captured context',
		'throwing fetch',
	])('disables both fast paths and caches a failed probe for %s', async failure => {
		const constructSpy = vi.fn()
		vi.doMock('hono', () => ({
			Hono: class extends Hono {
				constructor() {
					super()
					constructSpy()
					if (failure === 'no captured context') {
						this.fetch = () => new Response(null)
					} else if (failure === 'throwing fetch') {
						this.fetch = () => {
							throw new Error('incompatible fetch')
						}
					} else {
						this.use('*', (ctx, next) => {
							if (failure === 'key mismatch')
								Object.defineProperty(ctx, 'extra', {
									enumerable: true,
									value: true,
								})
							if (failure === 'missing context class')
								Object.defineProperty(ctx, 'constructor', { value: undefined })
							if (failure === 'missing request class')
								Object.defineProperty(ctx.req, 'constructor', {
									value: undefined,
								})
							return next()
						})
					}
				}
			},
		}))
		const { getAdapterContextClass: getIncompatibleClass } = await import(
			'./hono-context'
		)
		expect(getIncompatibleClass(true)).toBeUndefined()
		expect(getIncompatibleClass(true)).toBeUndefined()
		expect(getIncompatibleClass(false)).toBeUndefined()
		expect(getIncompatibleClass(false)).toBeUndefined()
		expect(constructSpy).toHaveBeenCalledTimes(1)
	})
})
