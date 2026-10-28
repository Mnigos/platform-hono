export const ADAPTERS = [
	'platform-hono',
	'platform-fastify',
	'platform-express',
	'platform-node',
] as const
export type Adapter = (typeof ADAPTERS)[number]
export const HIGHLIGHTED_ADAPTER = 'platform-hono' satisfies Adapter

interface Setup {
	load: string
	machine: string
	methodology: string
	nest: string
	warmupSeconds: number
}

interface NestBuild {
	adapters: readonly string[]
	nest: string
	source: string
	sourceUrl: string
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
	nestBuilds?: NestBuild[]
	route: string
	runtimes: Runtime[]
	setup: Setup
	unreleased?: UnreleasedAdapter[]
}

export interface Measurement {
	adapter: Adapter
	runtime: string
	value: number
}

export const numberFormat = new Intl.NumberFormat('en-US')
const listFormat = new Intl.ListFormat('en-US')

/** Every measured adapter on every runtime in one ranking, fastest first. */
export const getRanking = (results: BenchmarkResults) =>
	results.runtimes
		.flatMap(runtime =>
			ADAPTERS.flatMap(adapter => {
				const value = runtime.requestsPerSecond[adapter]

				return value === undefined
					? []
					: [{ adapter, runtime: runtime.name, value } satisfies Measurement]
			})
		)
		.toSorted((first, second) => second.value - first.value)

/** Text alternative of the chart that lists every value. */
export function describeResults(results: BenchmarkResults) {
	const values = getRanking(results).map(
		({ adapter, runtime, value }) =>
			`${getAdapterLabel(results, adapter)} on ${runtime} ${numberFormat.format(value)}`
	)

	return `Race chart of NestJS requests per second for ${results.route}, fastest first, where a faster ball serves more requests per second: ${values.join(', ')}. ${getNotes(results).join('. ')}.`
}

/** Setup lines printed under the chart. */
export function getNotes(results: BenchmarkResults) {
	const { machine, nest, load, warmupSeconds } = results.setup

	return [
		`${machine} · ${load}, ${warmupSeconds} s warmup`,
		`${getDefaultNestAdapters(results).join(', ')}: NestJS ${nest}`,
		...(results.nestBuilds ?? []).map(
			build =>
				`${build.adapters.join(', ')}: NestJS ${build.nest} from ${build.source}`
		),
		...(results.unreleased ?? []).map(
			entry =>
				`${entry.adapter} (unreleased): NestJS ${entry.nest} from ${entry.source}, ${formatRuntimeScope(results, entry.adapter)}`
		),
	]
}

/** Adapters that run the NestJS version of `setup.nest`. */
export function getDefaultNestAdapters(results: BenchmarkResults) {
	const listed = [
		...(results.nestBuilds ?? []).flatMap(build => build.adapters),
		...(results.unreleased ?? []).map(entry => entry.adapter),
	]

	return ADAPTERS.filter(adapter => !listed.includes(adapter))
}

/** Adapter name, marked when the adapter is not released yet. */
export const getAdapterLabel = (results: BenchmarkResults, adapter: Adapter) =>
	results.unreleased?.some(entry => entry.adapter === adapter)
		? `${adapter} (unreleased)`
		: adapter

/** Lists adapters followed by the matching form of "run". */
export const formatRun = (adapters: readonly string[]) =>
	`${listFormat.format(adapters)} ${adapters.length === 1 ? 'runs' : 'run'}`

/** Names the runtimes an adapter was measured on. */
export function formatRuntimeScope(results: BenchmarkResults, adapter: string) {
	const names = results.runtimes
		.filter(runtime => Object.hasOwn(runtime.requestsPerSecond, adapter))
		.map(runtime => runtime.name)
	const scope = listFormat.format(names)

	return names.length < results.runtimes.length ? `${scope} only` : scope
}
