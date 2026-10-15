import { readFileSync } from 'node:fs'
import {
	getChartPath,
	renderChartSvg,
	renderReadme,
	THEMES,
} from './render-chart'
import results from './results.json'

const OUTDATED_MESSAGE = 'run `bun bench/chart.ts` after editing results.json'

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

	test('throws when the README lacks a benchmark block', () => {
		expect(() => renderReadme('# README', results)).toThrow(
			'README.md needs a <!-- benchmark-chart:start --> ... <!-- benchmark-chart:end --> block'
		)
	})
})
