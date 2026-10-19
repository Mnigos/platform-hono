import type { IncomingMessage, ServerResponse } from 'node:http'
import { Hono } from 'hono'
import { createBodyLimitMiddleware } from '../request/body-limit-middleware'
import { createRequestLayer } from '../request/request-layer'
import { RouteRegistry } from '../routing/route-registry'
import { BunFastPath, createBunFastPath } from './bun-fast-path'
import { createServer } from './create-server'
import type { FastPathOptions } from './fast-routes'
import { getAdapterContextClass } from './hono-context'
import { createNodeFastPath, NodeFastPath } from './node-fast-path'
import { getNodeServerInternals } from './node-internals'

vi.mock('./hono-context', async importOriginal => {
	const actual = await importOriginal<typeof import('./hono-context')>()
	return {
		...actual,
		getAdapterContextClass: vi.fn(actual.getAdapterContextClass),
	}
})

vi.mock('./node-internals', async importOriginal => {
	const actual = await importOriginal<typeof import('./node-internals')>()
	return {
		...actual,
		getNodeServerInternals: vi.fn(actual.getNodeServerInternals),
	}
})

function fixture() {
	const hono = new Hono()
	const requestLayer = createRequestLayer({}, [])
	const routes = new RouteRegistry(hono, {})
	const options: FastPathOptions = {
		adapterOptions: {},
		hono,
		requestLayer,
		routes,
		securityHooks: [],
	}
	hono.use(requestLayer)
	hono.use(createBodyLimitMiddleware({ adapterOptions: {} }))
	routes.register('get', '/health', (_req, ctx) => ctx.text('healthy'))
	return options
}

afterEach(() => {
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

describe('fast path startup probes', () => {
	test('creates the Node fast path when both probes pass', () => {
		vi.stubGlobal('Bun', undefined)
		expect(createNodeFastPath(fixture())).toBeInstanceOf(NodeFastPath)
		expect(getNodeServerInternals).toHaveBeenCalledOnce()
		expect(getAdapterContextClass).toHaveBeenCalledExactlyOnceWith(true)
	})

	test.each([
		'node-server internals',
		'Hono Context',
	])('disables the Node fast path if the %s probe fails', probe => {
		vi.stubGlobal('Bun', undefined)
		if (probe === 'node-server internals')
			vi.mocked(getNodeServerInternals).mockReturnValueOnce(undefined)
		else vi.mocked(getAdapterContextClass).mockReturnValueOnce(undefined)

		expect(createNodeFastPath(fixture())).toBeUndefined()
	})

	test('does not probe Node internals while running on Bun', () => {
		vi.stubGlobal('Bun', {})
		expect(createNodeFastPath(fixture())).toBeUndefined()
		expect(getNodeServerInternals).not.toHaveBeenCalled()
		expect(getAdapterContextClass).not.toHaveBeenCalled()
	})

	test('does not probe Node internals for an explicit Bun runtime', () => {
		vi.stubGlobal('Bun', undefined)
		const options = fixture()
		options.adapterOptions.runtime = 'bun'
		expect(createNodeFastPath(options)).toBeUndefined()
		expect(getNodeServerInternals).not.toHaveBeenCalled()
		expect(getAdapterContextClass).not.toHaveBeenCalled()
	})

	test('creates the Bun fast path when its Context probe passes', () => {
		vi.stubGlobal('Bun', {})
		expect(createBunFastPath(fixture())).toBeInstanceOf(BunFastPath)
		expect(getAdapterContextClass).toHaveBeenCalledExactlyOnceWith(false)
		expect(getNodeServerInternals).not.toHaveBeenCalled()
	})

	test('disables the Bun fast path if its Context probe fails', () => {
		vi.stubGlobal('Bun', {})
		vi.mocked(getAdapterContextClass).mockReturnValueOnce(undefined)
		expect(createBunFastPath(fixture())).toBeUndefined()
	})

	test('does not probe Bun Context on Node', () => {
		vi.stubGlobal('Bun', undefined)
		expect(createBunFastPath(fixture())).toBeUndefined()
		expect(getAdapterContextClass).not.toHaveBeenCalled()
	})

	test('keeps an explicit Node runtime on Bun off the Bun fast path', () => {
		vi.stubGlobal('Bun', {})
		const options = fixture()
		options.adapterOptions.runtime = 'node'
		expect(createBunFastPath(options)).toBeUndefined()
		expect(getAdapterContextClass).not.toHaveBeenCalled()
	})

	test('passes hono.fetch to Bun.serve when the probe fails', async () => {
		const serve = vi.fn((_options: { fetch: Hono['fetch'] }) => ({
			hostname: 'localhost',
			port: 1234,
			stop: vi.fn(() => Promise.resolve()),
		}))
		vi.stubGlobal('Bun', { serve })
		vi.mocked(getAdapterContextClass).mockReturnValueOnce(undefined)
		const options = fixture()
		const fastPath = createBunFastPath(options)
		const server = createServer(options.hono, {}, { runtime: 'bun' }, fastPath)

		server.listen(0)
		expect(serve).toHaveBeenCalledWith(
			expect.objectContaining({ fetch: options.hono.fetch })
		)
		const response = await serve.mock.calls[0]?.[0].fetch(
			new Request('http://localhost/health'),
			{}
		)
		expect(await response?.text()).toBe('healthy')
		await new Promise<void>(resolve => server.close(() => resolve()))
	})
})

function nodeFixture() {
	const options = fixture()
	const AdapterContext = getAdapterContextClass(true)
	const internals = getNodeServerInternals()
	if (!(AdapterContext && internals))
		throw new Error('Supported Node dependencies must pass their probes')
	const fastPath = new NodeFastPath(options, { AdapterContext, internals })
	options.hono.notFound(ctx => ctx.text('missing', 404))
	const routeHandler = vi.fn(() => new Promise<Response>(() => undefined))
	options.routes.register('get', '/pending', routeHandler)
	const fallbackListener = vi.fn(() => 'fallback')
	const listener = fastPath.wrapListener(fallbackListener)
	const incoming = {
		headers: { host: 'localhost' },
		httpVersionMajor: 1,
		httpVersionMinor: 1,
		method: 'GET',
		rawHeaders: ['Host', 'localhost'],
		socket: { remoteAddress: '127.0.0.1' },
		url: '/pending',
	} as IncomingMessage
	const outgoing = { on: vi.fn() } as unknown as ServerResponse
	return { fallbackListener, incoming, listener, outgoing, routeHandler }
}

describe('Node listener selection', () => {
	test.each([0, 1])('consumes an eligible HTTP/1.%s GET', minor => {
		const { fallbackListener, incoming, listener, outgoing, routeHandler } =
			nodeFixture()
		incoming.httpVersionMinor = minor

		expect(listener(incoming, outgoing)).toBeUndefined()
		expect(routeHandler).toHaveBeenCalledOnce()
		expect(fallbackListener).not.toHaveBeenCalled()
		expect(outgoing.on).toHaveBeenCalledWith('close', expect.any(Function))
	})

	test.each([
		{ name: 'HEAD', change: { method: 'HEAD' } },
		{ name: 'POST', change: { method: 'POST' } },
		{ name: 'missing URL', change: { url: undefined } },
		{ name: 'encoded target', change: { url: '/pend%69ng' } },
		{ name: 'dot-segment target', change: { url: '/other/../pending' } },
		{ name: 'absolute target', change: { url: 'http://localhost/pending' } },
		{ name: 'unmatched route', change: { url: '/missing' } },
		{
			name: 'zero Content-Length',
			change: { headers: { host: 'localhost', 'content-length': '0' } },
		},
		{
			name: 'Content-Length',
			change: { headers: { host: 'localhost', 'content-length': '5' } },
		},
		{
			name: 'Transfer-Encoding',
			change: {
				headers: { host: 'localhost', 'transfer-encoding': 'chunked' },
			},
		},
		{
			name: 'Content-Type',
			change: {
				headers: { host: 'localhost', 'content-type': 'application/json' },
			},
		},
		{ name: 'missing Host', change: { headers: {} } },
		{ name: 'normalized Host', change: { headers: { host: 'LOCALHOST' } } },
	])('passes $name to the existing listener unchanged', ({ change }) => {
		const { fallbackListener, incoming, listener, outgoing, routeHandler } =
			nodeFixture()
		Object.assign(incoming, change)

		expect(listener(incoming, outgoing)).toBe('fallback')
		expect(fallbackListener).toHaveBeenCalledExactlyOnceWith(incoming, outgoing)
		expect(routeHandler).not.toHaveBeenCalled()
		expect(outgoing.on).not.toHaveBeenCalled()
	})

	test.each([
		0,
		2,
		3,
		undefined,
	])('leaves HTTP major %s to the existing listener untouched', major => {
		const { fallbackListener, incoming, listener, outgoing, routeHandler } =
			nodeFixture()
		Object.assign(incoming, { httpVersionMajor: major })
		const before = Object.getOwnPropertyDescriptors(incoming)

		expect(listener(incoming, outgoing)).toBe('fallback')

		expect(Object.getOwnPropertyDescriptors(incoming)).toEqual(before)
		expect(outgoing.on).not.toHaveBeenCalled()
		expect(fallbackListener).toHaveBeenCalledExactlyOnceWith(incoming, outgoing)
		expect(routeHandler).not.toHaveBeenCalled()
	})
})
