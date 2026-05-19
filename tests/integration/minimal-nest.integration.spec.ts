import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HonoAdapter } from '../../src'
import { startApp } from './fixtures/minimal-nest-app'

function delay(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

describe('minimal Nest integration', () => {
	test('boots a Nest app and serves controller params, query strings, headers, and metadata over HTTP', async () => {
		const app = await startApp()

		try {
			const response = await fetch(`${app.baseUrl}/hello/42?q=search`, {
				headers: { 'x-test': 'from-client' },
			})

			expect(response.status).toBe(200)
			await expect(response.json()).resolves.toEqual({
				baseUrl: '/hello/42',
				header: 'from-client',
				id: '42',
				query: 'search',
			})
		} finally {
			await app.close()
		}
	})

	test('parses JSON request bodies and exposes raw bodies when Nest rawBody is enabled', async () => {
		const app = await startApp(new HonoAdapter())

		try {
			const response = await fetch(`${app.baseUrl}/echo`, {
				body: JSON.stringify({ ok: true }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			})

			expect(response.status).toBe(201)
			await expect(response.json()).resolves.toEqual({
				body: { ok: true },
			})
		} finally {
			await app.close()
		}

		const rawBodyApp = await startApp(new HonoAdapter(), { rawBody: true })

		try {
			const response = await fetch(`${rawBodyApp.baseUrl}/echo`, {
				body: JSON.stringify({ raw: true }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			})

			expect(response.status).toBe(201)
			await expect(response.json()).resolves.toEqual({
				body: { raw: true },
				rawBody: JSON.stringify({ raw: true }),
			})
		} finally {
			await rawBodyApp.close()
		}
	})

	test('keeps request.body available for guards while preserving the raw request body', async () => {
		const app = await startApp(new HonoAdapter())

		try {
			const response = await fetch(`${app.baseUrl}/compatibility`, {
				body: JSON.stringify({ ok: true }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			})

			expect(response.status).toBe(201)
			await expect(response.json()).resolves.toEqual({
				body: { ok: true },
				guardBody: { ok: true },
				rawBody: { ok: true },
			})
		} finally {
			await app.close()
		}
	})

	test('serves PUT, PATCH, DELETE, and OPTIONS routes over HTTP', async () => {
		const app = await startApp()

		try {
			const putResponse = await fetch(`${app.baseUrl}/echo`, {
				body: JSON.stringify({ put: true }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT',
			})
			expect(putResponse.status).toBe(200)
			await expect(putResponse.json()).resolves.toEqual({
				body: { put: true },
				method: 'PUT',
			})

			const patchResponse = await fetch(`${app.baseUrl}/echo`, {
				body: JSON.stringify({ patch: true }),
				headers: { 'content-type': 'application/json' },
				method: 'PATCH',
			})
			expect(patchResponse.status).toBe(200)
			await expect(patchResponse.json()).resolves.toEqual({
				body: { patch: true },
				method: 'PATCH',
			})

			const deleteResponse = await fetch(`${app.baseUrl}/resource/abc`, {
				method: 'DELETE',
			})
			expect(deleteResponse.status).toBe(200)
			await expect(deleteResponse.json()).resolves.toEqual({ deleted: 'abc' })

			const optionsResponse = await fetch(`${app.baseUrl}/resource`, {
				method: 'OPTIONS',
			})
			expect(optionsResponse.status).toBe(204)
		} finally {
			await app.close()
		}
	})

	test('parses text, form, and multipart bodies over HTTP', async () => {
		const app = await startApp()

		try {
			const textResponse = await fetch(`${app.baseUrl}/echo`, {
				body: 'hello',
				headers: { 'content-type': 'text/plain' },
				method: 'POST',
			})
			expect(textResponse.status).toBe(201)
			await expect(textResponse.json()).resolves.toEqual({ body: 'hello' })

			const formResponse = await fetch(`${app.baseUrl}/echo`, {
				body: new URLSearchParams({ name: 'Ada' }),
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				method: 'POST',
			})
			expect(formResponse.status).toBe(201)
			await expect(formResponse.json()).resolves.toEqual({
				body: { name: 'Ada' },
			})

			const formData = new FormData()
			formData.append('name', 'Ada')
			formData.append('file', new Blob(['abc']), 'avatar.txt')

			const multipartResponse = await fetch(`${app.baseUrl}/echo`, {
				body: formData,
				method: 'POST',
			})
			expect(multipartResponse.status).toBe(201)
			await expect(multipartResponse.json()).resolves.toMatchObject({
				body: { name: 'Ada' },
			})
		} finally {
			await app.close()
		}
	})

	test('returns bad request responses for malformed JSON and form bodies over HTTP', async () => {
		const app = await startApp()

		try {
			const jsonResponse = await fetch(`${app.baseUrl}/echo`, {
				body: '{',
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			})
			expect(jsonResponse.status).toBe(400)
			await expect(jsonResponse.json()).resolves.toMatchObject({
				message: 'Malformed JSON body',
				statusCode: 400,
			})

			const formResponse = await fetch(`${app.baseUrl}/echo`, {
				body: 'bad-form',
				headers: { 'content-type': 'multipart/form-data; boundary=missing' },
				method: 'POST',
			})
			expect(formResponse.status).toBe(400)
			await expect(formResponse.json()).resolves.toMatchObject({
				message: 'Malformed request body',
				statusCode: 400,
			})
		} finally {
			await app.close()
		}
	})

	test('skips parser routes without applying sibling prefix matches', async () => {
		const app = await startApp(
			new HonoAdapter({ skipBodyParserFor: ['/auth/session'] })
		)

		try {
			const response = await fetch(`${app.baseUrl}/auth/session`, {
				body: JSON.stringify({ shouldStayRaw: true }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			})

			expect(response.status).toBe(201)
			await expect(response.json()).resolves.toEqual({ bodyWasParsed: false })

			const siblingResponse = await fetch(`${app.baseUrl}/auth-sibling`, {
				body: JSON.stringify({ parsed: true }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			})
			expect(siblingResponse.status).toBe(201)
			await expect(siblingResponse.json()).resolves.toEqual({
				body: { parsed: true },
			})
		} finally {
			await app.close()
		}
	})

	test('returns Nest exception and custom exception filter responses over HTTP', async () => {
		const app = await startApp()

		try {
			const response = await fetch(`${app.baseUrl}/fail`)

			expect(response.status).toBe(400)
			await expect(response.json()).resolves.toMatchObject({
				error: 'Bad Request',
				message: 'Nope',
				statusCode: 400,
			})

			const filteredResponse = await fetch(`${app.baseUrl}/filtered-fail`)
			expect(filteredResponse.status).toBe(422)
			await expect(filteredResponse.json()).resolves.toEqual({
				filtered: true,
				message: 'Filtered nope',
			})
		} finally {
			await app.close()
		}
	})

	test('handles redirects, cookies, and not found responses over HTTP', async () => {
		const app = await startApp()

		try {
			const redirectResponse = await fetch(`${app.baseUrl}/redirect`, {
				redirect: 'manual',
			})
			expect(redirectResponse.status).toBe(302)
			expect(redirectResponse.headers.get('location')).toBe(
				'/hello/redirected?q=yes'
			)

			const headersResponse = await fetch(`${app.baseUrl}/headers`)
			expect(headersResponse.status).toBe(200)
			expect(headersResponse.headers.get('set-cookie')).toContain('session=abc')

			const notFoundResponse = await fetch(`${app.baseUrl}/missing`)
			expect(notFoundResponse.status).toBe(404)
			await expect(notFoundResponse.text()).resolves.toBe('Not Found')
		} finally {
			await app.close()
		}
	})

	test('returns supported plain Nest controller values over HTTP', async () => {
		const app = await startApp()

		try {
			const arrayResponse = await fetch(`${app.baseUrl}/returns/array`)
			expect(arrayResponse.status).toBe(200)
			await expect(arrayResponse.json()).resolves.toEqual(['one', 'two'])

			await expect(
				(await fetch(`${app.baseUrl}/returns/string`)).text()
			).resolves.toBe('plain string')

			await expect(
				(await fetch(`${app.baseUrl}/returns/number`)).text()
			).resolves.toBe('42')

			await expect(
				(await fetch(`${app.baseUrl}/returns/boolean`)).text()
			).resolves.toBe('true')

			const bufferResponse = await fetch(`${app.baseUrl}/returns/buffer`)
			expect(bufferResponse.headers.get('content-type')).toBe(
				'application/octet-stream'
			)
			await expect(bufferResponse.text()).resolves.toBe('direct buffer')

			const fetchResponse = await fetch(`${app.baseUrl}/returns/response`)
			expect(fetchResponse.status).toBe(202)
			expect(fetchResponse.headers.get('x-fetch-response')).toBe('yes')
			await expect(fetchResponse.text()).resolves.toBe('fetch response')

			await expect(
				(await fetch(`${app.baseUrl}/returns/promise`)).json()
			).resolves.toEqual({ resolved: true })

			await expect(
				(await fetch(`${app.baseUrl}/returns/observable`)).json()
			).resolves.toEqual({ resolved: 'observable' })
		} finally {
			await app.close()
		}
	})

	test('streams Nest StreamableFile responses over HTTP', async () => {
		const app = await startApp()

		try {
			const bufferResponse = await fetch(`${app.baseUrl}/download/buffer`)
			expect(bufferResponse.status).toBe(200)
			expect(bufferResponse.headers.get('content-type')).toBe('text/plain')
			expect(bufferResponse.headers.get('content-disposition')).toBe(
				'attachment; filename="buffer.txt"'
			)
			expect(bufferResponse.headers.get('content-length')).toBe('11')
			await expect(bufferResponse.text()).resolves.toBe('buffer file')

			const streamResponse = await fetch(`${app.baseUrl}/download/stream`)
			expect(streamResponse.status).toBe(200)
			expect(streamResponse.headers.get('content-type')).toBe('text/plain')
			expect(streamResponse.headers.get('content-disposition')).toBe(
				'attachment; filename="stream.txt"'
			)
			expect(streamResponse.headers.get('content-length')).toBe('13')
			await expect(streamResponse.text()).resolves.toBe('streamed file')

			const chunkedResponse = await fetch(`${app.baseUrl}/download/chunked`)
			expect(chunkedResponse.status).toBe(200)
			expect(chunkedResponse.headers.get('content-type')).toBe('text/plain')
			expect(chunkedResponse.headers.get('content-disposition')).toBe(
				'attachment; filename="chunked.txt"'
			)

			const reader = chunkedResponse.body?.getReader()
			if (!reader) throw new Error('Expected a chunked response body reader')

			const firstChunk = await reader.read()
			expect(firstChunk.done).toBe(false)
			expect(new TextDecoder().decode(firstChunk.value)).toBe('chunk-one\n')

			const secondRead = reader.read()
			await expect(
				Promise.race([
					secondRead.then(() => 'resolved'),
					delay(25).then(() => 'pending'),
				])
			).resolves.toBe('pending')

			const secondChunk = await secondRead
			expect(secondChunk.done).toBe(false)
			expect(new TextDecoder().decode(secondChunk.value)).toBe('chunk-two\n')
			await expect(reader.read()).resolves.toMatchObject({ done: true })

			const directNodeResponse = await fetch(
				`${app.baseUrl}/download/direct-node-stream`
			)
			expect(directNodeResponse.status).toBe(200)
			expect(directNodeResponse.headers.get('content-type')).toBe(
				'application/octet-stream'
			)
			await expect(directNodeResponse.text()).resolves.toBe(
				'direct node stream'
			)

			const directWebResponse = await fetch(
				`${app.baseUrl}/download/direct-web-stream`
			)
			expect(directWebResponse.status).toBe(200)
			expect(directWebResponse.headers.get('content-type')).toBe(
				'application/octet-stream'
			)
			await expect(directWebResponse.text()).resolves.toBe('direct web stream')
		} finally {
			await app.close()
		}
	})

	test('serves Nest server-sent event streams over HTTP', async () => {
		const app = await startApp()

		try {
			const response = await fetch(`${app.baseUrl}/events`)

			expect(response.status).toBe(200)
			expect(response.headers.get('content-type')).toContain(
				'text/event-stream'
			)
			expect(response.headers.get('cache-control')).toContain('no-cache')
			expect(response.headers.get('x-sse-test')).toBe('yes')
			const body = await response.text()
			expect(body).toContain('event: message')
			expect(body).toContain('data: {"hello":"one"}')
			expect(body).toContain('id: custom')
			expect(body).toContain('data: two')
		} finally {
			await app.close()
		}
	})

	test('serves CORS preflight and static assets over HTTP', async () => {
		const staticRoot = join(process.cwd(), '.cache', 'integration-static')
		await mkdir(join(staticRoot, 'assets'), { recursive: true })
		await writeFile(join(staticRoot, 'assets', 'asset.txt'), 'asset-body')

		const adapter = new HonoAdapter()
		const app = await startApp(adapter, {}, nestApp => {
			nestApp.enableCors({ origin: 'https://example.test' })
			adapter.useStaticAssets('/assets/*', { root: staticRoot })
		})

		try {
			const corsResponse = await fetch(`${app.baseUrl}/echo`, {
				headers: {
					'access-control-request-method': 'POST',
					origin: 'https://example.test',
				},
				method: 'OPTIONS',
			})
			expect(corsResponse.status).toBe(204)
			expect(corsResponse.headers.get('access-control-allow-origin')).toBe(
				'https://example.test'
			)

			const staticResponse = await fetch(`${app.baseUrl}/assets/asset.txt`)
			expect(staticResponse.status).toBe(200)
			await expect(staticResponse.text()).resolves.toBe('asset-body')
		} finally {
			await app.close()
		}
	})

	test('applies proxy trust settings over HTTP', async () => {
		const untrustedApp = await startApp()

		try {
			const response = await fetch(`${untrustedApp.baseUrl}/ip`, {
				headers: { 'x-forwarded-for': '203.0.113.10' },
			})
			expect(response.status).toBe(200)
			await expect(response.json()).resolves.toEqual({})
		} finally {
			await untrustedApp.close()
		}

		const trustedApp = await startApp(new HonoAdapter({ trustProxy: true }))

		try {
			const response = await fetch(`${trustedApp.baseUrl}/ip`, {
				headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' },
			})
			expect(response.status).toBe(200)
			await expect(response.json()).resolves.toEqual({ ip: '203.0.113.10' })
		} finally {
			await trustedApp.close()
		}
	})

	test('rejects oversized payloads and chooses the most specific route limit over HTTP', async () => {
		const app = await startApp(
			new HonoAdapter({
				requestSizeLimits: [
					{
						errorMessage: 'Payload is too large for this route',
						maxBytes: 3,
						path: '/echo',
					},
					{
						maxBytes: 20,
						path: '/echo/nested',
					},
				],
			})
		)

		try {
			const response = await fetch(`${app.baseUrl}/echo`, {
				body: 'hello',
				headers: { 'content-type': 'text/plain' },
				method: 'POST',
			})

			expect(response.status).toBe(413)
			expect(response.headers.get('content-type')).toContain('application/json')

			const nestedResponse = await fetch(`${app.baseUrl}/echo/nested`, {
				body: JSON.stringify({ ok: true }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			})
			expect(nestedResponse.status).toBe(201)
			await expect(nestedResponse.json()).resolves.toEqual({
				body: { ok: true },
			})
		} finally {
			await app.close()
		}
	})
})
