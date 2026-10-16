import type { Logger } from '@nestjs/common'
import type { Hono } from 'hono'
import { createBodyLimit, parseBodyLimit } from '../helpers/body-parser'
import type { HonoAdapterOptions } from '../options'
import { createParserMiddleware } from './body-parser-middleware'

type BodyParserOptions = number | { limit?: number | string }

type UseBodyParser = (type: string, rawBody: boolean) => void

const DEFAULT_PARSER_TYPES = [
	'urlencoded',
	'json',
	'text',
	'multipart/form-data',
] as const

/**
 * Registers the adapter's body parsers: Nest's `useBodyParser()` calls and
 * the default parsers for the types still missing, which share one Hono
 * middleware unless a type has its own body limit.
 */
export class ParserRegistry {
	private readonly registeredTypes = new Set<string>()
	private batchedTypes?: string[]
	private readonly adapterOptions: HonoAdapterOptions
	private readonly hono: Hono
	private readonly logger: Logger

	constructor(hono: Hono, adapterOptions: HonoAdapterOptions, logger: Logger) {
		this.hono = hono
		this.adapterOptions = adapterOptions
		this.logger = logger
	}

	get isRegistered() {
		return this.registeredTypes.size > 0
	}

	register(type: string, rawBody: boolean, options?: BodyParserOptions) {
		const configuredLimit = parseBodyLimit(
			typeof options === 'number' ? options : options?.limit
		)
		this.logger.log(
			`Registering body parser middleware for type: ${type}${configuredLimit === undefined ? '' : ` | bodyLimit: ${configuredLimit}`}`
		)
		this.registeredTypes.add(type)
		if (configuredLimit === undefined && this.batchedTypes) {
			this.batchedTypes.push(type)
			return
		}
		const parse = createParserMiddleware({
			adapterOptions: this.adapterOptions,
			parserTypes: [type],
			rawBody,
		})
		const bodyLimit =
			configuredLimit === undefined
				? undefined
				: createBodyLimit(configuredLimit, type)
		this.hono.use(
			bodyLimit ? (ctx, next) => bodyLimit(ctx, () => parse(ctx, next)) : parse
		)
	}

	/**
	 * Registers the missing default parser types through `useBodyParser`
	 * (the adapter's method, so overrides and spies see every type) and
	 * returns the shared middleware for those without their own limit.
	 */
	createDefaultParser(rawBody: boolean, useBodyParser: UseBodyParser) {
		const missingTypes = DEFAULT_PARSER_TYPES.filter(
			type => !this.registeredTypes.has(type)
		)
		if (missingTypes.length === 0) return
		this.logger.log('Registering parser middleware')
		const parserTypes: string[] = []
		this.batchedTypes = parserTypes
		try {
			for (const type of missingTypes) useBodyParser(type, rawBody)
		} finally {
			this.batchedTypes = undefined
		}
		if (parserTypes.length === 0) return
		return createParserMiddleware({
			adapterOptions: this.adapterOptions,
			parserTypes,
			rawBody,
		})
	}
}
