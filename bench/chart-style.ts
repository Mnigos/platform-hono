import { ADAPTERS, type Adapter } from './chart-data'
import { BALL_TRAVEL } from './chart-rows'

export const THEMES = ['light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

interface Palette {
	accent: string
	accentText: string
	balls: Record<Adapter, string>
	border: string
	glow: number
	muted: string
	ok: string
	panel: string
	surface: string
	text: string
	wall: string
}

const PALETTES = {
	light: {
		accent: '#eb6834',
		accentText: '#bc4c00',
		balls: {
			'platform-hono': '#eb6834',
			'platform-fastify': '#1baf7a',
			'platform-express': '#2a78d6',
			'platform-node': '#c13c8f',
		},
		border: '#d1d9e0',
		glow: 3,
		muted: '#59636e',
		ok: '#1a7f37',
		panel: '#ffffff',
		surface: '#f6f8fa',
		text: '#1f2328',
		wall: '#afb8c1',
	},
	dark: {
		accent: '#ff6b3d',
		accentText: '#ff8a63',
		balls: {
			'platform-hono': '#ff6b3d',
			'platform-fastify': '#26b57a',
			'platform-express': '#4c94ff',
			'platform-node': '#e879c6',
		},
		border: '#262830',
		glow: 5,
		muted: '#8a8b96',
		ok: '#39d98a',
		panel: '#0e1014',
		surface: '#15171c',
		text: '#e6e6ea',
		wall: '#3a3c46',
	},
} as const satisfies Record<Theme, Palette>

const FONT =
	'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace'

/** Stylesheet of the chart, including the ball animation, for one theme. */
export function renderStyle(theme: Theme) {
	const palette: Palette = PALETTES[theme]

	return [
		`text{font:13px ${FONT};fill:${palette.muted}}`,
		`.title{font-size:20px;font-weight:700;fill:${palette.text}}`,
		`.label,.value{font-size:14px;fill:${palette.text}}`,
		'.label{font-weight:600}',
		`.adapter{font-size:12px;font-weight:400;fill:${palette.muted}}`,
		`.hl .adapter{fill:${palette.accentText}}`,
		'.unit{font-size:11px}',
		'.value,.end,.ok{text-anchor:end}',
		'.head{font-size:11px;letter-spacing:1.5px}',
		'.note{font-size:12px}',
		`.panel{fill:${palette.panel};stroke:${palette.border}}`,
		`.name,.track{fill:${palette.surface};stroke:${palette.border}}`,
		`.hl .name{stroke:${palette.accent};stroke-width:2;filter:url(#glow)}`,
		`.wall{stroke:${palette.wall};stroke-width:2;stroke-linecap:round}`,
		'.logo{fill:#e0234e}',
		'.badge text{font-size:12px;font-weight:700}',
		'.bun>rect{fill:#fbf0df}',
		'.bun>use,.bun>text{fill:#14151a}',
		'.node>rect{fill:#417e38}',
		'.node>use,.node>text{fill:#ffffff}',
		`.dot{fill:${palette.accent};filter:url(#glow)}`,
		...ADAPTERS.map(
			adapter => `.ball.${adapter}{fill:${palette.balls[adapter]}}`
		),
		'.ball{filter:url(#glow);animation:trip var(--trip) linear infinite}',
		`.ok{font-size:10px;fill:${palette.ok};opacity:0;animation:ok var(--trip) linear infinite}`,
		`@keyframes trip{50%{transform:translateX(${BALL_TRAVEL}px)}}`,
		'@keyframes ok{0%,44%,61%,100%{opacity:0}45%,60%{opacity:1}}',
		'@media (prefers-reduced-motion:reduce){.ball,.ok{animation:none}}',
	].join('\n')
}

/** Soft glow of the balls and the highlighted rows. */
export const renderGlowFilter = (theme: Theme) =>
	`<filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="${PALETTES[theme].glow}"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
