// Three-route Nest app for throughput checks against the built adapter (dist/).
// Usage: node bench/app.mjs | bun bench/app.mjs   (PORT=3000, RUNTIME=auto|bun|node)
import 'reflect-metadata'
import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { HonoAdapter } from '../dist/index.js'

class AppController {
	hello() {
		return 'Hello world!'
	}

	user(id) {
		return {
			id,
			name: 'John Doe',
			email: 'john@example.com',
			roles: ['admin', 'user'],
		}
	}

	echo(body) {
		return body
	}
}

function route(decorator, name, parameterDecorator) {
	const prototype = AppController.prototype
	decorator(prototype, name, Object.getOwnPropertyDescriptor(prototype, name))
	parameterDecorator?.(prototype, name, 0)
	Reflect.defineMetadata('design:paramtypes', [Object], prototype, name)
}

route(Get(), 'hello')
route(Get('users/:id'), 'user', Param('id'))
route(Post('echo'), 'echo', Body())
Controller()(AppController)

class AppModule {}
Module({ controllers: [AppController] })(AppModule)

const adapter = new HonoAdapter({ runtime: process.env.RUNTIME ?? 'auto' })
const app = await NestFactory.create(AppModule, adapter, { logger: false })
await app.listen(Number(process.env.PORT ?? 3000))
