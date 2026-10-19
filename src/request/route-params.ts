import { getNestHonoRequest } from '../helpers/request'
import type { RequestState } from './request-state-core'

interface OptionalParameterSuffixLike {
	name: string
	suffix: string
}

/**
 * Sets `req.params` for the current route layer, stripping literal suffixes
 * from optional parameters such as `/:file{.json}`. Unless this is the last
 * layer that sets them, it keeps a copy, so the next layer can tell the edits
 * an earlier layer (such as Nest middleware) made.
 */
export function setRouteParams(
	state: RequestState,
	optionalParameterSuffixes: readonly OptionalParameterSuffixLike[],
	isLastLayer = false
) {
	const { ctx } = state
	const params = ctx.req.param()
	for (let index = optionalParameterSuffixes.length - 1; index >= 0; index--) {
		const suffixEntry = optionalParameterSuffixes[index]
		if (!suffixEntry) continue
		const { name, suffix } = suffixEntry
		const value = params[name]
		if (value && value.length > suffix.length && value.endsWith(suffix))
			params[name] = value.slice(0, -suffix.length)
	}
	const req = getNestHonoRequest(ctx.req)
	const previousParams = state.routeParams
	if (!isLastLayer) state.routeParams = { ...params }
	if (previousParams && req.params)
		keepParameterEdits(params, previousParams, req.params)
	req.params = params
}

/**
 * Carries edits an earlier layer (such as Nest middleware) made to
 * `req.params` into the next layer's params, as long as the route matched the
 * same value for that parameter.
 */
function keepParameterEdits(
	params: Record<string, string>,
	previousParams: Record<string, string>,
	editedParams: Record<string, string>
) {
	for (const [name, value] of Object.entries(editedParams)) {
		if (previousParams[name] === value) continue
		if (!(name in params) || previousParams[name] === params[name])
			params[name] = value
	}
	for (const name of Object.keys(previousParams))
		if (!(name in editedParams) && previousParams[name] === params[name])
			delete params[name]
}
