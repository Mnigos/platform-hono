import type { IncomingMessage, ServerResponse } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { createAbortOnClose, getNodeServerInternals } from './node-internals'

function captureRequest() {
	let captured: Request | undefined
	getRequestListener(
		request => {
			captured = request
			return new Promise<Response>(() => undefined)
		},
		{ overrideGlobalObjects: false }
	)(
		{
			headers: { host: 'localhost' },
			method: 'GET',
			url: '/',
		} as IncomingMessage,
		{ on: () => undefined } as unknown as ServerResponse
	)
	if (!captured) throw new Error('node-server did not create a request')
	return captured
}

describe('Node request abort on close', () => {
	test('probes supported node-server once without replacing global classes', () => {
		const nativeRequest = globalThis.Request
		const nativeResponse = globalThis.Response
		const internals = getNodeServerInternals()

		expect(internals).toBeDefined()
		expect(getNodeServerInternals()).toBe(internals)
		expect(globalThis.Request).toBe(nativeRequest)
		expect(globalThis.Response).toBe(nativeResponse)
	})

	test.each([
		{
			name: 'premature disconnect',
			errored: null,
			finished: false,
			reason: 'Client connection prematurely closed.',
		},
		{
			name: 'request error',
			errored: new Error('socket failed'),
			finished: false,
			reason: 'Error: socket failed',
		},
		{
			name: 'request error after the response finished',
			errored: new Error('late failure'),
			finished: true,
			reason: 'Error: late failure',
		},
		{
			name: 'normal response completion',
			errored: null,
			finished: true,
			reason: undefined,
		},
	])('preserves the signal state and reason for $name', ({
		errored,
		finished,
		reason,
	}) => {
		const internals = getNodeServerInternals()
		if (!internals) throw new Error('Supported node-server must pass its probe')
		const request = captureRequest()
		const abortListener = vi.fn()
		request.signal.addEventListener('abort', abortListener)
		const onClose = createAbortOnClose(
			internals,
			request,
			{ errored } as IncomingMessage,
			{ writableFinished: finished } as ServerResponse
		)

		onClose()
		onClose()

		expect(request.signal.aborted).toBe(reason !== undefined)
		expect(request.signal.reason).toBe(reason)
		expect(abortListener).toHaveBeenCalledTimes(reason === undefined ? 0 : 1)
	})
})
