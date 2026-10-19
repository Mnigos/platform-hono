import { type IncomingMessage, ServerResponse } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { getNodeServerInternals } from './node-internals'
import { getLightweightResponse } from './node-response'
import {
	getCachedResponseWriter,
	type ResponseCache,
} from './node-response-writer'

interface BufferedResponse extends ServerResponse {
	outputData: { data: unknown }[]
}

interface WireCase {
	body: string
	headers?: Record<string, string | string[]>
	httpVersionMinor?: number
	name: string
	prepare?: (outgoing: ServerResponse) => void
	status?: number
}

function outgoingResponse(httpVersionMinor = 1) {
	const outgoing = new ServerResponse({
		headers: {},
		httpVersionMajor: 1,
		httpVersionMinor,
		method: 'GET',
	} as IncomingMessage) as BufferedResponse
	outgoing.sendDate = false
	return outgoing
}

function bytes(outgoing: BufferedResponse) {
	return outgoing.outputData.map(({ data }) => String(data)).join('')
}

function supportedWriter() {
	const internals = getNodeServerInternals()
	if (!internals) throw new Error('Supported node-server must pass its probe')
	const writer = getCachedResponseWriter(internals.responseCacheKey)
	if (!writer)
		throw new Error('Supported node-server must have a compatible writer')
	return { cacheKey: internals.responseCacheKey, writer }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('cached Node response writer', () => {
	const wireCases: WireCase[] = [
		{ name: 'Unicode byte length', body: 'zażółć' },
		{ name: 'empty body', body: '' },
		{ name: 'HTTP/1.0', body: 'hello', httpVersionMinor: 0 },
		{ name: '204 body suppression', body: 'discarded', status: 204 },
		{ name: '304 body suppression', body: 'discarded', status: 304 },
		{
			name: 'explicit mixed-case Content-Length',
			body: 'hello',
			headers: { 'cOnTeNt-LeNgTh': '5' },
		},
		{
			name: 'multiple cookies and JSON content type',
			body: '{"ok":true}',
			headers: {
				'content-type': 'application/json',
				'set-cookie': ['a=1', 'b=2'],
			},
		},
		{
			name: 'pre-existing outgoing headers',
			body: 'hello',
			prepare: outgoing => outgoing.setHeader('x-existing', 'kept'),
		},
		{
			name: 'pre-existing Content-Length',
			body: 'hello',
			prepare: outgoing => outgoing.setHeader('Content-Length', '5'),
		},
		{
			name: 'response Transfer-Encoding',
			body: 'hello',
			headers: { 'Transfer-Encoding': 'chunked' },
		},
		{
			name: 'pre-existing Transfer-Encoding',
			body: 'hello',
			prepare: outgoing => outgoing.setHeader('Transfer-Encoding', 'chunked'),
		},
		{
			name: 'response Trailer',
			body: 'hello',
			headers: { Trailer: 'x-checksum', 'Transfer-Encoding': 'chunked' },
		},
		{
			name: 'pre-existing Trailer',
			body: 'hello',
			prepare: outgoing => {
				outgoing.setHeader('Trailer', 'x-checksum')
				outgoing.setHeader('Transfer-Encoding', 'chunked')
			},
		},
	]
	test.each(
		wireCases
	)('writes the same HTTP bytes and header mutations as node-server for $name', async ({
		body,
		headers,
		httpVersionMinor,
		prepare,
		status,
	}) => {
		const { cacheKey, writer } = supportedWriter()
		const LightweightResponse = getLightweightResponse()
		const makeResponse = () =>
			new LightweightResponse(body, {
				headers: headers && ({ ...headers } as ResponseInit['headers']),
				status,
			}) as Response & Record<symbol, ResponseCache>
		const expectedResponse = makeResponse()
		const actualResponse = makeResponse()
		const actual = outgoingResponse(httpVersionMinor)
		const expected = outgoingResponse(httpVersionMinor)
		prepare?.(actual)
		prepare?.(expected)
		const cache = actualResponse[cacheKey]
		if (!cache) throw new Error('Lightweight response cache missing')

		await getRequestListener(() => expectedResponse, {
			overrideGlobalObjects: false,
		})(
			{
				headers: { host: 'localhost' },
				method: 'GET',
				url: '/',
			} as IncomingMessage,
			expected
		)
		expect(writer(actual, cache)).toBe(true)
		expect(bytes(actual)).toBe(bytes(expected))
		expect(bytes(actual)).not.toBe('')
		expect(actual.writableEnded).toBe(true)
		expect(cache[2]).toEqual(expectedResponse[cacheKey]?.[2])
	})

	test.each([
		{ name: 'Buffer body', body: Buffer.from('body'), headers: undefined },
		{ name: 'stream body', body: new ReadableStream(), headers: undefined },
		{ name: 'null body', body: null, headers: undefined },
		{ name: 'Headers instance', body: 'body', headers: new Headers() },
		{ name: 'header tuples', body: 'body', headers: [['x-test', 'value']] },
		{ name: 'null headers', body: 'body', headers: null },
		{
			name: 'header object with null prototype',
			body: 'body',
			headers: Object.create(null),
		},
	])('leaves $name unwritten for the fallback writer', ({ body, headers }) => {
		const { writer } = supportedWriter()
		const outgoing = outgoingResponse()
		const writeHeadSpy = vi.spyOn(outgoing, 'writeHead')
		const endSpy = vi.spyOn(outgoing, 'end')

		expect(writer(outgoing, [200, body, headers])).toBe(false)
		expect(writeHeadSpy).not.toHaveBeenCalled()
		expect(endSpy).not.toHaveBeenCalled()
		expect(bytes(outgoing)).toBe('')
		expect(outgoing.headersSent).toBe(false)
	})

	test('caches a successful compatibility probe', () => {
		const { cacheKey, writer } = supportedWriter()
		expect(getCachedResponseWriter(cacheKey)).toBe(writer)
	})

	test('fails safe and caches failure when the response cache key changes', async () => {
		const { cacheKey } = supportedWriter()
		vi.resetModules()
		const isolated = await import('./node-response-writer')

		expect(
			isolated.getCachedResponseWriter(Symbol('incompatible cache'))
		).toBeUndefined()
		// Once a probe fails, later requests stay on node-server's writer.
		expect(isolated.getCachedResponseWriter(cacheKey)).toBeUndefined()
	})
})
