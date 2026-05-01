import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		coverage: {
			exclude: [...configDefaults.exclude],
		},
		exclude: [
			...configDefaults.exclude,
			'tests/integration/**/*.integration.spec.ts',
		],
		globals: true,
		root: './',
	},
})
