// Writes assets/benchmark-{light,dark}.svg and the README benchmark blocks
// from bench/results.json. Usage: bun bench/chart.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { THEMES } from './chart-style'
import { getChartPath, renderChartSvg, renderReadme } from './render-chart'
import results from './results.json'

const rootUrl = new URL('../', import.meta.url)
const readmeUrl = new URL('README.md', rootUrl)

mkdirSync(new URL('assets/', rootUrl), { recursive: true })

for (const theme of THEMES)
	writeFileSync(
		new URL(getChartPath(theme), rootUrl),
		renderChartSvg(results, theme)
	)

writeFileSync(readmeUrl, renderReadme(readFileSync(readmeUrl, 'utf8'), results))
