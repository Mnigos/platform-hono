import 'reflect-metadata'
import type { Server } from 'node:http'
import { Readable } from 'node:stream'
import {
	type ArgumentsHost,
	BadRequestException,
	Body,
	type CanActivate,
	Catch,
	Controller,
	Delete,
	type ExceptionFilter,
	type ExecutionContext,
	Get,
	Head,
	Header,
	Headers,
	HttpCode,
	type INestApplication,
	Injectable,
	type MessageEvent,
	type MiddlewareConsumer,
	Module,
	type NestMiddleware,
	type NestModule,
	Options,
	Param,
	Patch,
	Post,
	Put,
	Query,
	Redirect,
	Req,
	RequestMethod,
	Sse,
	StreamableFile,
	UseFilters,
	UseGuards,
} from '@nestjs/common'
import type { NestApplicationOptions } from '@nestjs/common/interfaces'
import { NestFactory } from '@nestjs/core'
import type { Context } from 'hono'
import { Observable } from 'rxjs'
import { HonoAdapter } from '../../../src'

interface CapturedRequest {
	baseUrl?: string
	body?: unknown
	guardBody?: unknown
	headers?: Record<string, string>
	middlewareRan?: boolean
	raw?: Request
	rawBody?: Buffer
}

interface TestNestApplication extends INestApplication {
	useBodyParser(type: string, options?: unknown): this
	useStaticAssets(path: string, options?: unknown): this
}

function delay(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

async function* streamFileChunks() {
	yield Buffer.from('chunk-one\n')
	await delay(75)
	yield Buffer.from('chunk-two\n')
}

function createSseEvents() {
	return new Observable<MessageEvent>(subscriber => {
		subscriber.next({ data: { hello: 'one' }, type: 'message' })
		const timeout = setTimeout(() => {
			subscriber.next({ data: 'two', id: 'custom' })
			subscriber.complete()
		}, 20)

		return () => clearTimeout(timeout)
	})
}

let activeSseSubscriptions = 0

function createInfiniteSseEvents() {
	return new Observable<MessageEvent>(subscriber => {
		activeSseSubscriptions += 1
		const interval = setInterval(() => {
			subscriber.next({ data: 'tick' })
		}, 5)

		return () => {
			activeSseSubscriptions -= 1
			clearInterval(interval)
		}
	})
}

export function getActiveSseSubscriptions() {
	return activeSseSubscriptions
}

@Injectable()
class RequestBodyCompatibilityGuard implements CanActivate {
	canActivate(context: ExecutionContext) {
		const request = context.switchToHttp().getRequest<CapturedRequest>()
		request.guardBody = request.body
		return true
	}
}

@Catch(BadRequestException)
class TestExceptionFilter implements ExceptionFilter {
	catch(exception: BadRequestException, host: ArgumentsHost) {
		const ctx = host.switchToHttp().getResponse<Context>()
		ctx.status(422)
		ctx.res = ctx.json({
			filtered: true,
			message: exception.message,
		})
	}
}

@Injectable()
class TestMiddleware implements NestMiddleware {
	use(request: CapturedRequest, _response: Context, next: () => void) {
		request.middlewareRan = true
		next()
	}
}

@Controller({ host: 'example.test' })
class HostController {
	@Get('/hosted')
	hosted() {
		return { hosted: true }
	}
}

@Controller()
class TestController {
	@Get('/hello/:id')
	hello(
		@Param('id') id: string,
		@Query('q') query: string,
		@Headers('x-test') header: string,
		@Req() req: CapturedRequest
	) {
		return {
			baseUrl: req.baseUrl,
			header,
			id,
			query,
		}
	}

	@Post('/echo')
	echo(@Body() body: unknown, @Req() req: CapturedRequest) {
		return {
			body,
			rawBody: req.rawBody?.toString('utf8'),
		}
	}

	@Put('/echo')
	putEcho(@Body() body: unknown) {
		return { body, method: 'PUT' }
	}

	@Patch('/echo')
	patchEcho(@Body() body: unknown) {
		return { body, method: 'PATCH' }
	}

	@Delete('/resource/:id')
	deleteResource(@Param('id') id: string) {
		return { deleted: id }
	}

	@Options('/resource')
	@HttpCode(204)
	optionsResource() {
		return
	}

	@Head('/resource/head')
	@Header('x-head-handler', 'yes')
	headResource() {
		return
	}

	@Get('/optional{/:id}')
	optional(@Param('id') id?: string) {
		return { id: id ?? null }
	}

	@Post('/echo/nested')
	echoNested(@Body() body: unknown) {
		return { body }
	}

	@Post('/compatibility')
	@UseGuards(RequestBodyCompatibilityGuard)
	async compatibility(@Body() body: unknown, @Req() req: CapturedRequest) {
		return {
			body,
			guardBody: req.guardBody,
			rawBody: req.raw ? await req.raw.clone().json() : undefined,
		}
	}

	@Post('/auth/session')
	authSession(@Req() req: CapturedRequest) {
		return {
			bodyWasParsed: req.body !== undefined,
		}
	}

	@Post('/auth-sibling')
	authSibling(@Body() body: unknown) {
		return { body }
	}

	@Post('/raw-upload')
	async rawUpload(@Req() req: CapturedRequest) {
		return { size: req.raw ? (await req.raw.arrayBuffer()).byteLength : 0 }
	}

	@Get('/middleware/included')
	middlewareIncluded(@Req() req: CapturedRequest) {
		return { middlewareRan: req.middlewareRan ?? false }
	}

	@Get('/middleware/excluded')
	middlewareExcluded(@Req() req: CapturedRequest) {
		return { middlewareRan: req.middlewareRan ?? false }
	}

	@Get('/ip')
	ip(@Req() req: CapturedRequest & { ip?: string }) {
		return { ip: req.ip }
	}

	@Get('/headers')
	@Header('set-cookie', 'session=abc; Path=/; HttpOnly')
	headers() {
		return { ok: true }
	}

	@Get('/returns/array')
	returnArray() {
		return ['one', 'two']
	}

	@Get('/returns/string')
	returnString() {
		return 'plain string'
	}

	@Get('/returns/number')
	returnNumber() {
		return 42
	}

	@Get('/returns/boolean')
	returnBoolean() {
		return true
	}

	@Get('/returns/buffer')
	returnBuffer() {
		return Buffer.from('direct buffer')
	}

	@Get('/returns/response')
	returnResponse() {
		return new Response('fetch response', {
			headers: { 'x-fetch-response': 'yes' },
			status: 202,
		})
	}

	@Get('/returns/promise')
	returnPromise() {
		return Promise.resolve({ resolved: true })
	}

	@Get('/returns/observable')
	returnObservable() {
		return new Observable(subscriber => {
			subscriber.next({ ignored: true })
			subscriber.next({ resolved: 'observable' })
			subscriber.complete()
		})
	}

	@Get('/returns/problem')
	@Header('content-type', 'application/problem+json')
	returnProblem() {
		return { detail: 'problem' }
	}

	@Get('/redirect')
	@Redirect('/hello/redirected?q=yes', 302)
	redirect() {
		return
	}

	@Get('/download/buffer')
	downloadBuffer() {
		return new StreamableFile(Buffer.from('buffer file'), {
			disposition: 'attachment; filename="buffer.txt"',
			type: 'text/plain',
		})
	}

	@Get('/download/stream')
	downloadStream() {
		return new StreamableFile(Readable.from(['streamed file']), {
			disposition: 'attachment; filename="stream.txt"',
			length: 13,
			type: 'text/plain',
		})
	}

	@Get('/download/chunked')
	downloadChunked() {
		return new StreamableFile(Readable.from(streamFileChunks()), {
			disposition: 'attachment; filename="chunked.txt"',
			type: 'text/plain',
		})
	}

	@Get('/download/direct-node-stream')
	downloadDirectNodeStream() {
		return Readable.from(['direct node stream'])
	}

	@Get('/download/direct-web-stream')
	downloadDirectWebStream() {
		return new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('direct web stream'))
				controller.close()
			},
		})
	}

	@Sse('/events')
	@Header('x-sse-test', 'yes')
	events() {
		return createSseEvents()
	}

	@Sse('/events/infinite')
	infiniteEvents() {
		return createInfiniteSseEvents()
	}

	@Get('/fail')
	fail() {
		throw new BadRequestException('Nope')
	}

	@Get('/filtered-fail')
	@UseFilters(TestExceptionFilter)
	filteredFail() {
		throw new BadRequestException('Filtered nope')
	}
}

@Module({
	controllers: [HostController, TestController],
	providers: [RequestBodyCompatibilityGuard, TestMiddleware],
})
class TestModule implements NestModule {
	configure(consumer: MiddlewareConsumer) {
		consumer
			.apply(TestMiddleware)
			.exclude({ path: '/middleware/excluded', method: RequestMethod.GET })
			.forRoutes('/middleware/included', '/middleware/excluded')
	}
}

export async function startApp(
	adapter = new HonoAdapter(),
	options: NestApplicationOptions = {},
	setup?: (app: TestNestApplication) => void | Promise<void>
) {
	const app = await NestFactory.create<TestNestApplication>(
		TestModule,
		adapter,
		{
			logger: false,
			...options,
		}
	)

	await setup?.(app)
	await app.listen(0)

	const server = adapter.getHttpServer() as Server
	const address = server.address()

	if (!address || typeof address === 'string')
		throw new Error('Could not resolve test server address')

	return {
		adapter,
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () => app.close(),
	}
}
