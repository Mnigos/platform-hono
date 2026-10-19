import {
	ADAPTERS,
	type BenchmarkResults,
	describeResults,
	formatRun,
	formatRuntimeScope,
	getAdapterLabel,
	getDefaultNestAdapters,
	getNotes,
	getRanking,
	HIGHLIGHTED_ADAPTER,
	numberFormat,
} from './chart-data'
import { renderIconSymbols } from './chart-icons'
import {
	getRowsBottom,
	PADDING,
	renderRow,
	renderTrackHeader,
	WIDTH,
} from './chart-rows'
import { renderGlowFilter, renderStyle, type Theme } from './chart-style'

const PANEL_RADIUS = 16
const TITLE_Y = 50
const SUBTITLE_Y = 75
const DOT_RADIUS = 4
const NOTE_TOP = 36
const NOTE_LINE_HEIGHT = 18
const BOTTOM_PADDING = 26

/** Repository-relative path of the chart SVG for a theme. */
export const getChartPath = (theme: Theme) => `assets/benchmark-${theme}.svg`

/** Renders the animated benchmark race chart for one color theme. */
export function renderChartSvg(results: BenchmarkResults, theme: Theme) {
	const ranking = getRanking(results)
	const notes = getNotes(results)
	const firstNoteY = getRowsBottom(ranking.length) + NOTE_TOP
	const height =
		firstNoteY + (notes.length - 1) * NOTE_LINE_HEIGHT + BOTTOM_PADDING

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="title desc">`,
		`<title id="title">NestJS requests per second for ${results.route}</title>`,
		`<desc id="desc">${describeResults(results)}</desc>`,
		`<style>${renderStyle(theme)}</style>`,
		'<defs>',
		...renderIconSymbols(),
		renderGlowFilter(theme),
		'</defs>',
		`<rect class="panel" x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="${PANEL_RADIUS}"/>`,
		`<text class="title" x="${PADDING}" y="${TITLE_Y}">NestJS, ${results.route} requests per second</text>`,
		`<circle class="dot" cx="${PADDING + DOT_RADIUS}" cy="${SUBTITLE_Y - DOT_RADIUS}" r="${DOT_RADIUS}"/>`,
		`<text x="${PADDING + 4 * DOT_RADIUS}" y="${SUBTITLE_Y}">one request: client → server → client · a faster ball serves more requests per second</text>`,
		...renderTrackHeader(),
		...ranking.flatMap((measurement, index) =>
			renderRow(results, measurement, index)
		),
		...notes.map(
			(note, index) =>
				`<text class="note" x="${PADDING}" y="${firstNoteY + index * NOTE_LINE_HEIGHT}">${note}</text>`
		),
		'</svg>',
		'',
	].join('\n')
}

/** Replaces the generated chart and table blocks in the README. */
export function renderReadme(readme: string, results: BenchmarkResults) {
	return replaceBlock(
		replaceBlock(readme, 'benchmark-chart', renderPicture(results)),
		'benchmark-table',
		renderTable(results)
	)
}

function renderPicture(results: BenchmarkResults) {
	return [
		'<picture>',
		`\t<source media="(prefers-color-scheme: dark)" srcset="${getChartPath('dark')}">`,
		`\t<img alt="${describeResults(results)}" src="${getChartPath('light')}" width="${WIDTH}">`,
		'</picture>',
	].join('\n')
}

function renderTable(results: BenchmarkResults) {
	const others = ADAPTERS.filter(adapter => adapter !== HIGHLIGHTED_ADAPTER)
	const { machine, nest, load, warmupSeconds, methodology } = results.setup
	const rows = results.runtimes.map(runtime => {
		const highlighted = runtime.requestsPerSecond[HIGHLIGHTED_ADAPTER]
		const changes = others.map(adapter =>
			formatChange(highlighted, runtime.requestsPerSecond[adapter])
		)
		const highlightedCell =
			highlighted === undefined
				? '–'
				: `${numberFormat.format(highlighted)} req/s`

		return `| ${runtime.name} | ${highlightedCell} | ${changes.join(' | ')} |`
	})
	const nestSentences = [
		`${formatRun(getDefaultNestAdapters(results))} NestJS ${nest}.`,
		...results.nestBuilds.map(
			build =>
				`${formatRun(build.adapters)} NestJS ${build.nest} from [${build.source}](${build.sourceUrl}).`
		),
		...results.unreleased.map(
			entry =>
				`The unreleased ${entry.adapter} runs NestJS ${entry.nest} from [${entry.source}](${entry.sourceUrl}), measured on ${formatRuntimeScope(results, entry.adapter)}.`
		),
	]

	return [
		`| Runtime | ${HIGHLIGHTED_ADAPTER} | ${others.map(adapter => `vs ${getAdapterLabel(results, adapter)}`).join(' | ')} |`,
		`| --- | ---: | ${others.map(() => '---:').join(' | ')} |`,
		...rows,
		'',
		`Requests per second for \`${results.route}\` on ${machine} with \`${load}\` after a ${warmupSeconds} s warmup, following the [NestJS benchmark methodology](${methodology}). ${nestSentences.join(' ')} To measure the adapter on your machine, see [bench/README.md](bench/README.md).`,
	].join('\n')
}

function formatChange(value?: number, baseline?: number) {
	if (value === undefined || baseline === undefined) return '–'

	const percent = Math.round((value / baseline - 1) * 100)

	if (percent < 0) return `−${-percent}%`

	return `+${percent}%`
}

function replaceBlock(readme: string, name: string, content: string) {
	const start = `<!-- ${name}:start -->`
	const end = `<!-- ${name}:end -->`
	const startIndex = readme.indexOf(start)
	const endIndex = readme.indexOf(end)

	if (startIndex === -1 || endIndex < startIndex)
		throw new Error(`README.md needs a ${start} ... ${end} block`)

	return `${readme.slice(0, startIndex + start.length)}\n\n${content}\n\n${readme.slice(endIndex)}`
}
