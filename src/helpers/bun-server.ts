import type { Context } from 'hono'

interface BunServerBindings {
	requestIP: (request: Request) => { address: string } | null
	timeout: (request: Request, seconds: number) => void
}

/**
 * Returns the `Bun.serve` server Hono receives as `env` when the adapter runs
 * on Bun, or `undefined` on the `@hono/node-server` path.
 */
export function getBunServer(ctx: Context) {
	const env = ctx.env as Partial<BunServerBindings> | undefined
	if (typeof env?.requestIP !== 'function') return
	return env as BunServerBindings
}
