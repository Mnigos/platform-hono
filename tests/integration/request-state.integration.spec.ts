import { VersioningType } from '@nestjs/common'
import type { Context } from 'hono'
import { HonoAdapter } from '../../src'
import {
	captureRequestState,
	type StateRequest,
	startApp,
} from './fixtures/minimal-nest-app'

const LOOPBACK_IP = /127\.0\.0\.1$/

async function startStateApp(trustProxy = false) {
	return await startApp(new HonoAdapter({ trustProxy }), {}, app => {
		app.setGlobalPrefix('api')
		app.enableVersioning({ type: VersioningType.URI })
		app.use((req: StateRequest, _res: Context, next: () => void) => {
			captureRequestState(req, 'global')
			next()
		})
	})
}

describe('request state across Nest layers', () => {
	test.each([
		false,
		true,
	])('preserves query, headers, IP and versioned prefixed metadata with trustProxy=%s', async trustProxy => {
		const app = await startStateApp(trustProxy)
		try {
			for (const suffix of ['', '.json']) {
				const response = await fetch(
					`${app.baseUrl}/api/v1/state/report${suffix}?__proto__=value&constructor=ctor&toString=text&tag=a&tag=b&empty=&bare`,
					{
						headers: {
							'x-test': 'state',
							'x-forwarded-for': '203.0.113.1, 10.0.0.2',
						},
					}
				)
				expect(response.status).toBe(200)
				const trace = (await response.json()) as ReturnType<
					typeof captureRequestState
				>[]
				expect(trace.map(entry => entry.stage)).toEqual([
					'global',
					'middleware',
					'guard',
					'handler',
				])
				for (const entry of trace) {
					expect(entry).toMatchObject({
						baseUrl: `/api/v1/state/report${suffix}`,
						headers: {
							'x-test': 'state',
							'x-forwarded-for': '203.0.113.1, 10.0.0.2',
						},
						ip: trustProxy ? '10.0.0.2' : expect.stringMatching(LOOPBACK_IP),
						query: {
							['__proto__']: 'value',
							constructor: 'ctor',
							toString: 'text',
							tag: ['a', 'b'],
							empty: '',
							bare: '',
						},
						queryHasNullPrototype: true,
					})
				}
				// Global middleware runs before a route layer binds its params.
				expect(trace[0]?.params).toEqual({})
				for (const entry of trace.slice(1))
					expect(entry.params).toEqual({ file: 'report' })
				const direct = await fetch(
					`${app.baseUrl}/api/v1/state/report${suffix}`
				)
				expect(direct.status).toBe(200)
				for (const entry of (await direct.json()) as ReturnType<
					typeof captureRequestState
				>[])
					expect(entry.ip).toMatch(LOOPBACK_IP)
			}
		} finally {
			await app.close()
		}
	})

	test('preserves middleware query mutations through the guard and handler', async () => {
		const app = await startStateApp()
		try {
			const response = await fetch(
				`${app.baseUrl}/api/v1/state/report.json?original=yes`,
				{
					headers: { 'x-mutate-state': 'yes' },
				}
			)
			expect(response.status).toBe(200)
			const trace = (await response.json()) as ReturnType<
				typeof captureRequestState
			>[]
			for (const entry of trace.slice(2))
				expect(entry.query).toEqual({ original: 'yes', changed: 'middleware' })
		} finally {
			await app.close()
		}
	})

	test('preserves middleware parameter mutations through the guard and handler', async () => {
		const app = await startStateApp()
		try {
			const response = await fetch(`${app.baseUrl}/api/v1/state/report.json`, {
				headers: { 'x-mutate-state': 'yes' },
			})
			expect(response.status).toBe(200)
			const trace = (await response.json()) as ReturnType<
				typeof captureRequestState
			>[]
			for (const entry of trace.slice(2))
				expect(entry.params).toEqual({ file: 'changed' })
		} finally {
			await app.close()
		}
	})
})
