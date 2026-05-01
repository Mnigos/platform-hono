import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		fileParallelism: false,
		globals: true,
		include: ['tests/integration/**/*.integration.spec.ts'],
		maxWorkers: 1,
		root: './',
	},
})
