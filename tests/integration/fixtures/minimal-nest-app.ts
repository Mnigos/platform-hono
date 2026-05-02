import 'reflect-metadata'
import type { Server } from 'node:http'
import {
	type ArgumentsHost,
	BadRequestException,
	Body,
	Catch,
	Controller,
	Delete,
	type ExceptionFilter,
	Get,
	Header,
	Headers,
	HttpCode,
	type INestApplication,
	Module,
	Options,
	Param,
	Patch,
	Post,
	Put,
	Query,
	Redirect,
	Req,
	UseFilters,
} from '@nestjs/common'
import type { NestApplicationOptions } from '@nestjs/common/interfaces'
import { NestFactory } from '@nestjs/core'
import type { Context } from 'hono'
import { HonoAdapter } from '../../../src'

interface CapturedRequest {
	baseUrl?: string
	body?: unknown
	headers?: Record<string, string>
	rawBody?: Buffer
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

	@Post('/echo/nested')
	echoNested(@Body() body: unknown) {
		return { body }
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

	@Get('/ip')
	ip(@Req() req: CapturedRequest & { ip?: string }) {
		return { ip: req.ip }
	}

	@Get('/headers')
	@Header('set-cookie', 'session=abc; Path=/; HttpOnly')
	headers() {
		return { ok: true }
	}

	@Get('/redirect')
	@Redirect('/hello/redirected?q=yes', 302)
	redirect() {
		return
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
	controllers: [TestController],
})
class TestModule {}

export async function startApp(
	adapter = new HonoAdapter(),
	options: NestApplicationOptions = {},
	setup?: (app: INestApplication) => void | Promise<void>
) {
	const app = await NestFactory.create(TestModule, adapter, {
		logger: false,
		...options,
	})

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
