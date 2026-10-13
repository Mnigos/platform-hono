import { resolveRuntime } from './runtime'

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('resolveRuntime', () => {
	test('selects Node.js in auto mode when the Bun global is missing', () => {
		vi.stubGlobal('Bun', undefined)

		expect(resolveRuntime()).toBe('node')
		expect(resolveRuntime('auto')).toBe('node')
		expect(resolveRuntime('node')).toBe('node')
	})

	test('selects Bun in auto mode when the Bun global exists', () => {
		vi.stubGlobal('Bun', {})

		expect(resolveRuntime()).toBe('bun')
		expect(resolveRuntime('bun')).toBe('bun')
	})

	test('keeps Node.js when it is forced on Bun', () => {
		vi.stubGlobal('Bun', {})

		expect(resolveRuntime('node')).toBe('node')
	})

	test('rejects a forced Bun runtime outside Bun', () => {
		vi.stubGlobal('Bun', undefined)

		expect(() => resolveRuntime('bun')).toThrow(
			"HonoAdapter runtime 'bun' requires the Bun runtime"
		)
	})
})
