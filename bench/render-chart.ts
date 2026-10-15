import type benchmarkResults from './results.json'

export type BenchmarkResults = typeof benchmarkResults
type Runtime = BenchmarkResults['runtimes'][number]
type Adapter = keyof Runtime['requestsPerSecond']

interface Palette {
	accent: string
	axis: string
	context: string
	muted: string
	text: string
}

export const THEMES = ['light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

const ADAPTERS = [
	'platform-hono',
	'platform-fastify',
	'platform-express',
] as const satisfies readonly Adapter[]
const HIGHLIGHTED_ADAPTER = 'platform-hono' satisfies Adapter

const PALETTES = {
	light: {
		accent: '#eb6834',
		axis: '#d1d9e0',
		context: '#afb8c1',
		muted: '#59636e',
		text: '#1f2328',
	},
	dark: {
		accent: '#d95926',
		axis: '#3d444d',
		context: '#484f58',
		muted: '#9198a1',
		text: '#f0f6fc',
	},
} as const satisfies Record<Theme, Palette>

const WIDTH = 640
const BAR_START = 164
const BAR_HEIGHT = 22
const BAR_RADIUS = 4
const ROW_HEIGHT = 32
const VALUE_GAP = 8
const VALUE_ROOM = 56
const BAR_ROOM = WIDTH - BAR_START - VALUE_GAP - VALUE_ROOM
const TEXT_CENTER_OFFSET = 5.5
const GROUP_TOP = 36
const GROUP_HEIGHT = 138
const GROUP_HEADER_HEIGHT = 36
const FOOTER_HEIGHT = 38
const RUNTIME_DELAY_MS = 150
const VALUE_DELAY_MS = 900

const numberFormat = new Intl.NumberFormat('en-US')
const round = (value: number) => Math.round(value * 10) / 10

/** Repository-relative path of the chart SVG for a theme. */
export const getChartPath = (theme: Theme) => `assets/benchmark-${theme}.svg`

/** Renders the animated benchmark bar chart for one color theme. */
export function renderChartSvg(results: BenchmarkResults, theme: Theme) {
	const maxValue = Math.max(
		...results.runtimes.flatMap(runtime =>
			ADAPTERS.map(adapter => runtime.requestsPerSecond[adapter])
		)
	)
	const height =
		GROUP_TOP + results.runtimes.length * GROUP_HEIGHT + FOOTER_HEIGHT
	const { machine, nest, load, warmupSeconds } = results.setup

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="title desc">`,
		`<title id="title">NestJS requests per second for ${results.route}</title>`,
		`<desc id="desc">${describeResults(results)}</desc>`,
		`<style>${renderStyle(PALETTES[theme])}</style>`,
		`<text class="strong" x="0" y="18">Requests per second, ${results.route}<tspan class="muted"> · higher is better</tspan></text>`,
		...results.runtimes.map((runtime, index) =>
			renderRuntime(runtime, index, maxValue)
		),
		`<text class="note" x="0" y="${height - 10}">${machine} · NestJS ${nest} · ${load}, ${warmupSeconds} s warmup</text>`,
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

function renderStyle(palette: Palette) {
	return [
		`text{font:16px -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;fill:${palette.muted}}`,
		`.strong,text.hl{fill:${palette.text};font-weight:600}`,
		'.muted{font-weight:400}',
		`.muted,.note{fill:${palette.muted}}`,
		'.note{font-size:13px}',
		`.axis{stroke:${palette.axis}}`,
		`.bar{fill:${palette.context};transform-box:fill-box;transform-origin:0 50%;animation:grow 1.2s cubic-bezier(.33,1,.68,1) var(--bar-delay) both}`,
		`.bar.hl{fill:${palette.accent}}`,
		'.value{animation:show .3s ease-out var(--value-delay) both}',
		'@keyframes grow{from{transform:scaleX(0)}}',
		'@keyframes show{from{opacity:0}}',
		'@media (prefers-reduced-motion:reduce){.bar,.value{animation:none}}',
	].join('\n')
}

function renderRuntime(runtime: Runtime, index: number, maxValue: number) {
	const top = GROUP_TOP + index * GROUP_HEIGHT
	const firstBarTop = top + GROUP_HEADER_HEIGHT
	const lastBarBottom =
		firstBarTop + (ADAPTERS.length - 1) * ROW_HEIGHT + BAR_HEIGHT
	const barDelay = index * RUNTIME_DELAY_MS

	return [
		`<g style="--bar-delay:${barDelay}ms;--value-delay:${barDelay + VALUE_DELAY_MS}ms">`,
		`<text class="strong" x="0" y="${top + 24}">${runtime.name}</text>`,
		`<path class="axis" d="M${BAR_START - 0.5} ${firstBarTop - 4}V${lastBarBottom + 4}"/>`,
		...ADAPTERS.map((adapter, row) =>
			renderBar(
				adapter,
				runtime.requestsPerSecond[adapter],
				firstBarTop + row * ROW_HEIGHT,
				maxValue
			)
		),
		'</g>',
	].join('\n')
}

function renderBar(
	adapter: Adapter,
	value: number,
	top: number,
	maxValue: number
) {
	const end = round(BAR_START + (value / maxValue) * BAR_ROOM)
	const textY = top + BAR_HEIGHT / 2 + TEXT_CENTER_OFFSET
	const highlight = adapter === HIGHLIGHTED_ADAPTER ? ' hl' : ''
	const radius = BAR_RADIUS

	return [
		`<text class="label${highlight}" x="0" y="${textY}">${adapter}</text>`,
		`<path class="bar${highlight}" d="M${BAR_START} ${top}H${round(end - radius)}a${radius} ${radius} 0 0 1 ${radius} ${radius}v${BAR_HEIGHT - 2 * radius}a${radius} ${radius} 0 0 1 -${radius} ${radius}H${BAR_START}Z"/>`,
		`<text class="value${highlight}" x="${round(end + VALUE_GAP)}" y="${textY}">${(value / 1000).toFixed(1)}k</text>`,
	].join('\n')
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

		return `| ${runtime.name} | ${numberFormat.format(highlighted)} req/s | ${changes.join(' | ')} |`
	})

	return [
		`| Runtime | ${HIGHLIGHTED_ADAPTER} | ${others.map(adapter => `vs ${adapter}`).join(' | ')} |`,
		`| --- | ---: | ${others.map(() => '---:').join(' | ')} |`,
		...rows,
		'',
		`Requests per second for \`${results.route}\` on ${machine} with NestJS ${nest} and \`${load}\` after a ${warmupSeconds} s warmup, following the [NestJS benchmark methodology](${methodology}). To measure the adapter on your machine, see [bench/README.md](bench/README.md).`,
	].join('\n')
}

function describeResults(results: BenchmarkResults) {
	const runtimes = results.runtimes.map(runtime => {
		const values = ADAPTERS.map(
			adapter =>
				`${adapter} ${numberFormat.format(runtime.requestsPerSecond[adapter])}`
		)

		return `${runtime.name}: ${values.join(', ')}.`
	})

	return `Bar chart of NestJS requests per second for ${results.route}, higher is better. ${runtimes.join(' ')}`
}

function formatChange(value: number, baseline: number) {
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
