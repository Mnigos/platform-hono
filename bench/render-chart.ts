export const THEMES = ['light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

const ADAPTERS = [
	'platform-hono',
	'platform-fastify',
	'platform-express',
	'platform-node',
] as const
type Adapter = (typeof ADAPTERS)[number]
const HIGHLIGHTED_ADAPTER = 'platform-hono' satisfies Adapter

interface Setup {
	load: string
	machine: string
	methodology: string
	nest: string
	warmupSeconds: number
}

interface UnreleasedAdapter {
	adapter: string
	nest: string
	source: string
	sourceUrl: string
}

interface Runtime {
	name: string
	requestsPerSecond: Partial<Record<Adapter, number>>
}

export interface BenchmarkResults {
	route: string
	runtimes: Runtime[]
	setup: Setup
	unreleased: UnreleasedAdapter[]
}

interface Measurement {
	adapter: Adapter
	value: number
}

interface RuntimeLayout {
	measurements: Measurement[]
	runtime: Runtime
	top: number
}

interface Palette {
	accent: string
	axis: string
	context: string
	muted: string
	text: string
}

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
const BAR_START = 224
const LABEL_GAP = 12
const BAR_HEIGHT = 22
const BAR_RADIUS = 4
const ROW_HEIGHT = 32
const VALUE_GAP = 8
const VALUE_ROOM = 56
const BAR_ROOM = WIDTH - BAR_START - VALUE_GAP - VALUE_ROOM
const TEXT_CENTER_OFFSET = 5.5
const GROUP_TOP = 36
const GROUP_HEADER_HEIGHT = 36
const GROUP_GAP = 16
const NOTE_TOP = 40
const NOTE_LINE_HEIGHT = 18
const BOTTOM_PADDING = 10
const RUNTIME_DELAY_MS = 150
const VALUE_DELAY_MS = 900

const numberFormat = new Intl.NumberFormat('en-US')
const listFormat = new Intl.ListFormat('en-US')
const round = (value: number) => Math.round(value * 10) / 10

/** Repository-relative path of the chart SVG for a theme. */
export const getChartPath = (theme: Theme) => `assets/benchmark-${theme}.svg`

/** Renders the animated benchmark bar chart for one color theme. */
export function renderChartSvg(results: BenchmarkResults, theme: Theme) {
	const layouts = layOutRuntimes(results)
	const maxValue = Math.max(
		...layouts.flatMap(layout =>
			layout.measurements.map(measurement => measurement.value)
		)
	)
	const notes = getNotes(results)
	const firstNoteY = Math.max(...layouts.map(getLastBarBottom)) + NOTE_TOP
	const height =
		firstNoteY + (notes.length - 1) * NOTE_LINE_HEIGHT + BOTTOM_PADDING

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="title desc">`,
		`<title id="title">NestJS requests per second for ${results.route}</title>`,
		`<desc id="desc">${describeResults(results)}</desc>`,
		`<style>${renderStyle(PALETTES[theme])}</style>`,
		`<text class="strong" x="0" y="18">Requests per second, ${results.route}<tspan class="muted"> · higher is better</tspan></text>`,
		...layouts.map((layout, index) =>
			renderRuntime(results, layout, index, maxValue)
		),
		...notes.map(
			(note, index) =>
				`<text class="note" x="0" y="${firstNoteY + index * NOTE_LINE_HEIGHT}">${note}</text>`
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

function renderStyle(palette: Palette) {
	return [
		`text{font:16px -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;fill:${palette.muted}}`,
		`.strong,text.hl{fill:${palette.text};font-weight:600}`,
		'.muted{font-weight:400}',
		`.muted,.note{fill:${palette.muted}}`,
		'.note{font-size:13px}',
		'.label{text-anchor:end}',
		`.axis{stroke:${palette.axis}}`,
		`.bar{fill:${palette.context};transform-box:fill-box;transform-origin:0 50%;animation:grow 1.2s cubic-bezier(.33,1,.68,1) var(--bar-delay) both}`,
		`.bar.hl{fill:${palette.accent}}`,
		'.value{animation:show .3s ease-out var(--value-delay) both}',
		'@keyframes grow{from{transform:scaleX(0)}}',
		'@keyframes show{from{opacity:0}}',
		'@media (prefers-reduced-motion:reduce){.bar,.value{animation:none}}',
	].join('\n')
}

function layOutRuntimes(results: BenchmarkResults) {
	let top = GROUP_TOP

	return results.runtimes.map(runtime => {
		const layout: RuntimeLayout = {
			measurements: getMeasurements(runtime),
			runtime,
			top,
		}
		top = getLastBarBottom(layout) + GROUP_GAP

		return layout
	})
}

function getMeasurements(runtime: Runtime) {
	return ADAPTERS.flatMap(adapter => {
		const value = runtime.requestsPerSecond[adapter]

		return value === undefined ? [] : [{ adapter, value }]
	})
}

const getLastBarBottom = (layout: RuntimeLayout) =>
	layout.top +
	GROUP_HEADER_HEIGHT +
	(layout.measurements.length - 1) * ROW_HEIGHT +
	BAR_HEIGHT

function renderRuntime(
	results: BenchmarkResults,
	layout: RuntimeLayout,
	index: number,
	maxValue: number
) {
	const firstBarTop = layout.top + GROUP_HEADER_HEIGHT
	const barDelay = index * RUNTIME_DELAY_MS

	return [
		`<g style="--bar-delay:${barDelay}ms;--value-delay:${barDelay + VALUE_DELAY_MS}ms">`,
		`<text class="strong" x="0" y="${layout.top + 24}">${layout.runtime.name}</text>`,
		`<path class="axis" d="M${BAR_START - 0.5} ${firstBarTop - 4}V${getLastBarBottom(layout) + 4}"/>`,
		...layout.measurements.map((measurement, row) =>
			renderBar(results, measurement, firstBarTop + row * ROW_HEIGHT, maxValue)
		),
		'</g>',
	].join('\n')
}

function renderBar(
	results: BenchmarkResults,
	{ adapter, value }: Measurement,
	top: number,
	maxValue: number
) {
	const end = round(BAR_START + (value / maxValue) * BAR_ROOM)
	const textY = top + BAR_HEIGHT / 2 + TEXT_CENTER_OFFSET
	const highlight = adapter === HIGHLIGHTED_ADAPTER ? ' hl' : ''
	const radius = BAR_RADIUS

	return [
		`<text class="label${highlight}" x="${BAR_START - LABEL_GAP}" y="${textY}">${getAdapterLabel(results, adapter)}</text>`,
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
	const released = ADAPTERS.filter(adapter => !findUnreleased(results, adapter))
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
	const unreleasedSentences = results.unreleased.map(
		entry =>
			` The unreleased ${entry.adapter} runs NestJS ${entry.nest} from [${entry.source}](${entry.sourceUrl}), measured on ${formatRuntimeScope(results, entry.adapter)}.`
	)

	return [
		`| Runtime | ${HIGHLIGHTED_ADAPTER} | ${others.map(adapter => `vs ${getAdapterLabel(results, adapter)}`).join(' | ')} |`,
		`| --- | ---: | ${others.map(() => '---:').join(' | ')} |`,
		...rows,
		'',
		`Requests per second for \`${results.route}\` on ${machine} with \`${load}\` after a ${warmupSeconds} s warmup, following the [NestJS benchmark methodology](${methodology}). ${listFormat.format(released)} run NestJS ${nest}.${unreleasedSentences.join('')} To measure the adapter on your machine, see [bench/README.md](bench/README.md).`,
	].join('\n')
}

function describeResults(results: BenchmarkResults) {
	const runtimes = results.runtimes.map(runtime => {
		const values = getMeasurements(runtime).map(
			({ adapter, value }) =>
				`${getAdapterLabel(results, adapter)} ${numberFormat.format(value)}`
		)

		return `${runtime.name}: ${values.join(', ')}.`
	})

	return `Bar chart of NestJS requests per second for ${results.route}, higher is better. ${runtimes.join(' ')} ${getNotes(results).join('. ')}.`
}

function getNotes(results: BenchmarkResults) {
	const { machine, nest, load, warmupSeconds } = results.setup

	return [
		`${machine} · ${load}, ${warmupSeconds} s warmup · NestJS ${nest}`,
		...results.unreleased.map(
			entry =>
				`${entry.adapter} (unreleased): NestJS ${entry.nest} from ${entry.source}, ${formatRuntimeScope(results, entry.adapter)}`
		),
	]
}

const findUnreleased = (results: BenchmarkResults, adapter: string) =>
	results.unreleased.find(entry => entry.adapter === adapter)

const getAdapterLabel = (results: BenchmarkResults, adapter: Adapter) =>
	findUnreleased(results, adapter) ? `${adapter} (unreleased)` : adapter

function formatRuntimeScope(results: BenchmarkResults, adapter: string) {
	const names = results.runtimes
		.filter(runtime => Object.hasOwn(runtime.requestsPerSecond, adapter))
		.map(runtime => runtime.name)
	const scope = listFormat.format(names)

	return names.length < results.runtimes.length ? `${scope} only` : scope
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
