import { readFileSync } from 'node:fs'
import {
	type BenchmarkResults,
	getChartPath,
	renderChartSvg,
	renderReadme,
	THEMES,
} from './render-chart'
import results from './results.json'

const OUTDATED_MESSAGE = 'run `bun bench/chart.ts` after editing results.json'

const README_BLOCKS = [
	'<!-- benchmark-chart:start --><!-- benchmark-chart:end -->',
	'<!-- benchmark-table:start --><!-- benchmark-table:end -->',
].join('\n')

const unreleasedResults = {
	route: 'GET /',
	setup: { ...results.setup, nest: '11.2.7' },
	nestBuilds: [],
	unreleased: [
		{
			adapter: 'platform-node',
			nest: '12.1.2',
			source: 'nestjs/nest#18063',
			sourceUrl: 'https://github.com/nestjs/nest/pull/18063',
		},
	],
	runtimes: [
		{
			name: 'Bun',
			requestsPerSecond: {
				'platform-hono': 120_000,
				'platform-fastify': 100_000,
				'platform-express': 80_000,
			},
		},
		{
			name: 'Node.js',
			requestsPerSecond: {
				'platform-hono': 90_000,
				'platform-fastify': 100_000,
				'platform-express': 60_000,
				'platform-node': 110_000,
			},
		},
	],
} as const satisfies BenchmarkResults

const readRepositoryFile = (path: string) =>
	readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('benchmark chart', () => {
	test.each(THEMES)('%s chart matches bench/results.json', theme => {
		expect(readRepositoryFile(getChartPath(theme)), OUTDATED_MESSAGE).toBe(
			renderChartSvg(results, theme)
		)
	})

	test('README benchmark blocks match bench/results.json', () => {
		const readme = readRepositoryFile('README.md')

		expect(renderReadme(readme, results), OUTDATED_MESSAGE).toBe(readme)
	})

	test('labels an unreleased adapter and only draws it where it was measured', () => {
		const svg = renderChartSvg(unreleasedResults, 'light')

		expect(svg.match(/>platform-node \(unreleased\)<\/text>/g)).toHaveLength(1)
		expect(svg).toContain(
			'platform-node (unreleased): NestJS 12.1.2 from nestjs/nest#18063, Node.js only'
		)
	})

	test('orders the bars of each runtime from fastest to slowest', () => {
		const svg = renderChartSvg(unreleasedResults, 'light')
		const labels = Array.from(
			svg.matchAll(/<text class="(label(?: hl)?)"[^>]*>([^<]+)<\/text>/g),
			([, className, label]) => `${className}: ${label}`
		)

		expect(labels).toEqual([
			'label hl: platform-hono',
			'label: platform-fastify',
			'label: platform-express',
			'label: platform-node (unreleased)',
			'label: platform-fastify',
			'label hl: platform-hono',
			'label: platform-express',
		])
		expect(svg).toContain(
			'Node.js: platform-node (unreleased) 110,000, platform-fastify 100,000, platform-hono 90,000, platform-express 60,000.'
		)
	})

	test('compares against an unreleased adapter only where it was measured', () => {
		const readme = renderReadme(README_BLOCKS, unreleasedResults)

		expect(readme).toContain(
			'| Runtime | platform-hono | vs platform-fastify | vs platform-express | vs platform-node (unreleased) |'
		)
		expect(readme).toContain('| Bun | 120,000 req/s | +20% | +50% | – |')
		expect(readme).toContain('| Node.js | 90,000 req/s | −10% | +50% | −18% |')
		expect(readme).toContain(
			'platform-hono, platform-fastify, and platform-express run NestJS 11.2.7. The unreleased platform-node runs NestJS 12.1.2 from [nestjs/nest#18063](https://github.com/nestjs/nest/pull/18063), measured on Node.js only.'
		)
	})

	test('names the NestJS build of adapters that run another NestJS version', () => {
		const nestBuildResults = {
			...unreleasedResults,
			setup: { ...results.setup, nest: '12.1.3' },
			nestBuilds: [
				{
					adapters: ['platform-fastify', 'platform-express'],
					nest: '12.1.2',
					source: 'nestjs/nest#18063',
					sourceUrl: 'https://github.com/nestjs/nest/pull/18063',
				},
			],
		} as const satisfies BenchmarkResults

		expect(renderReadme(README_BLOCKS, nestBuildResults)).toContain(
			'platform-hono runs NestJS 12.1.3. platform-fastify and platform-express run NestJS 12.1.2 from [nestjs/nest#18063](https://github.com/nestjs/nest/pull/18063). The unreleased platform-node runs NestJS 12.1.2'
		)
		const svg = renderChartSvg(nestBuildResults, 'light')

		expect(svg).toContain('>platform-hono: NestJS 12.1.3</text>')
		expect(svg).toContain(
			'>platform-fastify, platform-express: NestJS 12.1.2 from nestjs/nest#18063</text>'
		)
	})

	test('throws when the README lacks a benchmark block', () => {
		expect(() => renderReadme('# README', results)).toThrow(
			'README.md needs a <!-- benchmark-chart:start --> ... <!-- benchmark-chart:end --> block'
		)
	})
})
