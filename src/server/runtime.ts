import type { HonoAdapterRuntime } from '../options'

/**
 * Resolves the server runtime. `auto` picks Bun only when the Bun global
 * exists, so the same build keeps using `@hono/node-server` on Node.js.
 */
export function resolveRuntime(runtime: HonoAdapterRuntime = 'auto') {
	const isBunAvailable = typeof Bun !== 'undefined'
	if (runtime === 'auto') return isBunAvailable ? 'bun' : 'node'
	if (runtime === 'bun' && !isBunAvailable)
		throw new Error(
			"HonoAdapter runtime 'bun' requires the Bun runtime. Use runtime 'node' or 'auto' on Node.js."
		)

	return runtime
}
