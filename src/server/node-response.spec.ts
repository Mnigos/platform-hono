import {
	getLightweightResponse,
	withLightweightResponse,
} from './node-response'

describe('lightweight node-server responses', () => {
	test('captures the node-server Response class and keeps the native globals', () => {
		const nativeRequest = globalThis.Request
		const nativeResponse = globalThis.Response

		const lightweightResponse = getLightweightResponse()

		expect(lightweightResponse).not.toBe(nativeResponse)
		expect(globalThis.Request).toBe(nativeRequest)
		expect(globalThis.Response).toBe(nativeResponse)
		expect(new lightweightResponse('ok')).toBeInstanceOf(nativeResponse)
		expect(getLightweightResponse()).toBe(lightweightResponse)
	})

	test('swaps the global Response only while building', async () => {
		const nativeResponse = globalThis.Response

		const response = withLightweightResponse(() => new Response('body'))

		expect(response).toBeInstanceOf(getLightweightResponse())
		expect(globalThis.Response).toBe(nativeResponse)
		await expect(response.text()).resolves.toBe('body')
		expect(() =>
			withLightweightResponse(() => {
				throw new Error('build failed')
			})
		).toThrow('build failed')
		expect(globalThis.Response).toBe(nativeResponse)
	})
})
