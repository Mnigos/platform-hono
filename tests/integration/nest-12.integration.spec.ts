import 'reflect-metadata'
import {
	Body,
	Controller,
	type INestApplication,
	Module,
	type NestApplicationOptions,
	Post,
} from '@nestjs/common'
import { NestApplication, NestFactory } from '@nestjs/core'
import { HonoAdapter } from '../../src'

interface Nest12Application extends INestApplication {
	enableCsrfProtection(): this
	useSecurityHeaders(): this
}

interface Nest12Adapter {
	beforeClose(): void
	isRouteOrderSensitive(): boolean
	query(path: string, handler: Function): void
	registerSecurityHook(hook: Function): void
}

type MethodDecoratorFactory = (path?: string) => MethodDecorator

const isNest12 =
	typeof (NestApplication.prototype as unknown as Partial<Nest12Application>)
		.useSecurityHeaders === 'function'

class Nest12Controller {
	form() {
		return { ok: true }
	}

	search(body: unknown) {
		return { body, method: 'QUERY' }
	}
}

async function defineRoutes() {
	const prototype = Nest12Controller.prototype
	const { QueryMethod: queryMethod } = (await import(
		'@nestjs/common'
	)) as unknown as { QueryMethod: MethodDecoratorFactory }
	Post('/form')(
		prototype,
		'form',
		Object.getOwnPropertyDescriptor(prototype, 'form') as PropertyDescriptor
	)
	queryMethod('/search')(
		prototype,
		'search',
		Object.getOwnPropertyDescriptor(prototype, 'search') as PropertyDescriptor
	)
	Body()(prototype, 'search', 0)
	Reflect.defineMetadata('design:paramtypes', [Object], prototype, 'search')
	Controller()(Nest12Controller)
}

class Nest12Module {}

async function startNest12App() {
	const adapter = new HonoAdapter()
	const app = await NestFactory.create<Nest12Application>(
		Nest12Module,
		adapter,
		{
			logger: false,
			return503OnClosing: true,
		} as NestApplicationOptions
	)
	app.useSecurityHeaders()
	app.enableCsrfProtection()
	await app.listen(0)
	return { adapter, app, baseUrl: await app.getUrl() }
}

describe('Nest 12 adapter members', () => {
	test('exposes route-order sensitivity and HTTP QUERY routes on every Nest version', async () => {
		const adapter = new HonoAdapter() as unknown as HonoAdapter & Nest12Adapter
		adapter.query(
			'/search',
			(_req: unknown, ctx: { text(body: string): Response }) =>
				ctx.text('queried')
		)

		const response = await adapter.hono.request('/search', { method: 'QUERY' })

		expect(adapter.isRouteOrderSensitive()).toBe(true)
		expect(typeof adapter.registerSecurityHook).toBe('function')
		expect(typeof adapter.beforeClose).toBe('function')
		await expect(response.text()).resolves.toBe('queried')
	})
})

describe.runIf(isNest12)('Nest 12 features over HTTP', () => {
	beforeAll(async () => {
		await defineRoutes()
		Module({ controllers: [Nest12Controller] })(Nest12Module)
	})

	test('serves @QueryMethod() routes with parsed bodies', async () => {
		const { app, baseUrl } = await startNest12App()

		try {
			const response = await fetch(`${baseUrl}/search`, {
				body: JSON.stringify({ term: 'hono' }),
				headers: { 'content-type': 'application/json' },
				method: 'QUERY',
			})

			expect(response.status).toBe(200)
			await expect(response.json()).resolves.toEqual({
				body: { term: 'hono' },
				method: 'QUERY',
			})
		} finally {
			await app.close()
		}
	})

	test('applies useSecurityHeaders() and enableCsrfProtection()', async () => {
		const { app, baseUrl } = await startNest12App()

		try {
			const sameOrigin = await fetch(`${baseUrl}/form`, {
				headers: { 'sec-fetch-site': 'same-origin' },
				method: 'POST',
			})
			const crossSite = await fetch(`${baseUrl}/form`, {
				headers: { 'sec-fetch-site': 'cross-site' },
				method: 'POST',
			})

			expect(sameOrigin.status).toBe(201)
			expect(sameOrigin.headers.get('x-content-type-options')).toBe('nosniff')
			expect(sameOrigin.headers.get('x-frame-options')).toBeTruthy()
			expect(crossSite.status).toBe(403)
			await expect(crossSite.json()).resolves.toMatchObject({
				statusCode: 403,
			})
		} finally {
			await app.close()
		}
	})

	test('answers 503 with Connection: close once shutdown starts when return503OnClosing is set', async () => {
		const { adapter, app, baseUrl } = await startNest12App()

		try {
			;(adapter as unknown as Nest12Adapter).beforeClose()
			const response = await fetch(`${baseUrl}/form`, {
				headers: { 'sec-fetch-site': 'same-origin' },
				method: 'POST',
			})

			expect(response.status).toBe(503)
			expect(response.headers.get('connection')).toBe('close')
		} finally {
			await app.close()
		}
	})
})
