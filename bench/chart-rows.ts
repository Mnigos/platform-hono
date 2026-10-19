import {
	type BenchmarkResults,
	getAdapterLabel,
	HIGHLIGHTED_ADAPTER,
	type Measurement,
	numberFormat,
} from './chart-data'
import { getRuntimeIcon } from './chart-icons'

export const WIDTH = 880
export const PADDING = 28
const COLUMN_GAP = 10
const ROWS_TOP = 116
const ROW_HEIGHT = 36
const ROW_GAP = 10
const TILE_SIZE = 32
const BADGE_X = PADDING + TILE_SIZE + COLUMN_GAP
const BADGE_WIDTH = 84
const BADGE_HEIGHT = 22
const BADGE_FONT_SIZE = 12
const BADGE_ICON_SIZE = 14
const BADGE_ICON_GAP = 5
const NAME_X = BADGE_X + BADGE_WIDTH + COLUMN_GAP
const NAME_WIDTH = 384
const NAME_PADDING = 14
const NAME_RADIUS = 9
const TRACK_X = NAME_X + NAME_WIDTH + 12
const TRACK_WIDTH = WIDTH - PADDING - TRACK_X
const TRACK_INSET = 3
const WALL_INSET = 10
const WALL_MARGIN = 9
const BALL_RADIUS = 10
const BALL_START = TRACK_X + 6 + BALL_RADIUS
const BALL_END = TRACK_X + TRACK_WIDTH - WALL_INSET - 3 - BALL_RADIUS
// Advance of one monospace character per pixel of font size.
const MONO_ADVANCE = 0.6
// One trip per second of a ball stands for this many requests per second, as
// in the race animation of the release posts.
const REQUESTS_PER_TRIP = 120_000

/** Distance a ball travels from the client to the server. */
export const BALL_TRAVEL = BALL_END - BALL_START

const round = (value: number) => Math.round(value * 10) / 10

/**
 * Seconds a ball takes from the client to the server and back, so a row
 * completes `requestsPerSecond / REQUESTS_PER_TRIP` trips per second.
 */
export const getTripSeconds = (requestsPerSecond: number) =>
	Number((REQUESTS_PER_TRIP / requestsPerSecond).toFixed(3))

/** Bottom edge of the last of `count` rows. */
export const getRowsBottom = (count: number) =>
	ROWS_TOP + count * ROW_HEIGHT + (count - 1) * ROW_GAP

/** Client and server labels above the tracks. */
export function renderTrackHeader() {
	const y = ROWS_TOP - 12

	return [
		`<text class="head" x="${TRACK_X + 14}" y="${y}">CLIENT</text>`,
		`<text class="head end" x="${TRACK_X + TRACK_WIDTH - 4}" y="${y}">SERVER</text>`,
	]
}

/** One ranked row: Nest logo, runtime badge, name and value, ball track. */
export function renderRow(
	results: BenchmarkResults,
	{ adapter, runtime, value }: Measurement,
	index: number
) {
	const top = ROWS_TOP + index * (ROW_HEIGHT + ROW_GAP)
	const middle = top + ROW_HEIGHT / 2
	const baseline = middle + 5
	const trackHeight = ROW_HEIGHT - 2 * TRACK_INSET
	const wallX = TRACK_X + TRACK_WIDTH - WALL_INSET
	const highlight = adapter === HIGHLIGHTED_ADAPTER ? ' hl' : ''

	return [
		`<g class="row${highlight}" style="--trip:${getTripSeconds(value)}s">`,
		`<use class="logo" href="#nest" x="${PADDING}" y="${middle - TILE_SIZE / 2}" width="${TILE_SIZE}" height="${TILE_SIZE}"/>`,
		...renderBadge(runtime, middle),
		`<rect class="name" x="${NAME_X}" y="${top}" width="${NAME_WIDTH}" height="${ROW_HEIGHT}" rx="${NAME_RADIUS}"/>`,
		`<text class="label" x="${NAME_X + NAME_PADDING}" y="${baseline}">nest <tspan class="adapter">${getAdapterLabel(results, adapter)}</tspan></text>`,
		`<text class="value" x="${NAME_X + NAME_WIDTH - NAME_PADDING}" y="${baseline}">${numberFormat.format(value)}<tspan class="unit"> req/s</tspan></text>`,
		`<rect class="track" x="${TRACK_X}" y="${top + TRACK_INSET}" width="${TRACK_WIDTH}" height="${trackHeight}" rx="${trackHeight / 2}"/>`,
		`<path class="wall" d="M${wallX} ${top + WALL_MARGIN}V${top + ROW_HEIGHT - WALL_MARGIN}"/>`,
		`<text class="ok" x="${wallX + 1}" y="${top + 1}">200</text>`,
		`<circle class="ball ${adapter}" cx="${BALL_START}" cy="${middle}" r="${BALL_RADIUS}"/>`,
		'</g>',
	]
}

function renderBadge(runtime: string, middle: number) {
	const icon = getRuntimeIcon(runtime)
	const contentWidth =
		BADGE_ICON_SIZE +
		BADGE_ICON_GAP +
		runtime.length * BADGE_FONT_SIZE * MONO_ADVANCE
	const left = round(BADGE_X + (BADGE_WIDTH - contentWidth) / 2)

	return [
		`<g class="badge ${icon}">`,
		`<rect x="${BADGE_X}" y="${middle - BADGE_HEIGHT / 2}" width="${BADGE_WIDTH}" height="${BADGE_HEIGHT}" rx="${BADGE_HEIGHT / 2}"/>`,
		`<use href="#${icon}" x="${left}" y="${middle - BADGE_ICON_SIZE / 2}" width="${BADGE_ICON_SIZE}" height="${BADGE_ICON_SIZE}"/>`,
		`<text x="${round(left + BADGE_ICON_SIZE + BADGE_ICON_GAP)}" y="${middle + 4}">${runtime}</text>`,
		'</g>',
	]
}
