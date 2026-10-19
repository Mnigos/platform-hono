import { readFileSync } from 'node:fs'
import type { BenchmarkResults } from './chart-data'
import { BALL_TRAVEL, getTripSeconds } from './chart-rows'
import { THEMES } from './chart-style'
import { getChartPath, renderChartSvg, renderReadme } from './render-chart'
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

const ADAPTER_PATTERN = /<tspan class="adapter">([^<]+)<\/tspan>/
const BADGE_PATTERN = /<g class="badge (\w+)">[\s\S]*?>([^<>]+)<\/text>/
const BALL_X_PATTERN = /<circle class="ball[^"]*" cx="([\d.]+)"/
const TRIP_PATTERN = /--trip:([\d.]+)s/

const getRows = (svg: string) =>
	svg
		.split('<g class="row')
		.slice(1)
		.map(row => ({
			adapter: row.match(ADAPTER_PATTERN)?.[1],
			badge: row.match(BADGE_PATTERN),
			ballX: row.match(BALL_X_PATTERN)?.[1],
			highlighted: row.startsWith(' hl"'),
			tripSeconds: Number(row.match(TRIP_PATTERN)?.[1]),
		}))

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

		expect(svg.match(/>platform-node \(unreleased\)<\/tspan>/g)).toHaveLength(1)
		expect(svg).toContain(
			'platform-node (unreleased): NestJS 12.1.2 from nestjs/nest#18063, Node.js only'
		)
	})

	test('ranks every adapter on every runtime in one list, fastest first', () => {
		const rows = getRows(renderChartSvg(unreleasedResults, 'light'))

		expect(rows.map(row => `${row.badge?.[2]} ${row.adapter}`)).toEqual([
			'Bun platform-hono',
			'Node.js platform-node (unreleased)',
			'Bun platform-fastify',
			'Node.js platform-fastify',
			'Node.js platform-hono',
			'Bun platform-express',
			'Node.js platform-express',
		])
		expect(renderReadme(README_BLOCKS, unreleasedResults)).toContain(
			'fastest first, where a faster ball serves more requests per second: platform-hono on Bun 120,000, platform-node (unreleased) on Node.js 110,000, platform-fastify on Bun 100,000, platform-fastify on Node.js 100,000, platform-hono on Node.js 90,000, platform-express on Bun 80,000, platform-express on Node.js 60,000.'
		)
	})

	test('draws the badge of its runtime on every row', () => {
		const rows = getRows(renderChartSvg(unreleasedResults, 'dark'))

		expect(rows.map(row => `${row.badge?.[1]}: ${row.badge?.[2]}`)).toEqual([
			'bun: Bun',
			'node: Node.js',
			'bun: Bun',
			'node: Node.js',
			'node: Node.js',
			'bun: Bun',
			'node: Node.js',
		])
	})

	test('throws for a runtime without a badge', () => {
		const denoResults = {
			...unreleasedResults,
			runtimes: [
				{ name: 'Deno', requestsPerSecond: { 'platform-hono': 100_000 } },
			],
		} as const satisfies BenchmarkResults

		expect(() => renderChartSvg(denoResults, 'light')).toThrow(
			'No runtime badge for Deno'
		)
	})

	test('outlines the platform-hono row of every runtime', () => {
		const rows = getRows(renderChartSvg(unreleasedResults, 'light'))

		expect(rows.filter(row => row.highlighted).map(row => row.adapter)).toEqual(
			['platform-hono', 'platform-hono']
		)
		expect(
			rows.filter(row => !row.highlighted).map(row => row.adapter)
		).not.toContain('platform-hono')
	})

	test('moves each ball at a speed proportional to its requests per second', () => {
		const rows = getRows(renderChartSvg(unreleasedResults, 'light'))

		expect(getTripSeconds(120_000)).toBe(1)
		expect(getTripSeconds(60_000)).toBe(2 * getTripSeconds(120_000))
		expect(rows.map(row => row.tripSeconds)).toEqual([
			1, 1.091, 1.2, 1.2, 1.333, 1.5, 2,
		])
	})

	test.each(
		THEMES
	)('%s chart starts every ball at the client and animates without scripts', theme => {
		const svg = renderChartSvg(unreleasedResults, theme)

		expect(new Set(getRows(svg).map(row => row.ballX)).size).toBe(1)
		expect(svg).toContain(
			`@keyframes trip{50%{transform:translateX(${BALL_TRAVEL}px)}}`
		)
		expect(svg).toContain(
			'@media (prefers-reduced-motion:reduce){.ball,.ok{animation:none}}'
		)
		expect(svg).not.toContain('<script')
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
