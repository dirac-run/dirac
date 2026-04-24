import { ApiHandler } from "@core/api"

/**
 * Gets context window information for the given API handler
 *
 * @param api The API handler to get context window information for
 * @returns An object containing the raw context window size and the effective max allowed size
 */
export function getContextWindowInfo(api: ApiHandler) {
	const HARD_LIMIT = 250_000

	let contextWindow = api.getModel().info.contextWindow || 128_000

	const maxAllowedSize = Math.min(HARD_LIMIT, Math.max(contextWindow - 40_000, contextWindow * 0.8))

	return { contextWindow, maxAllowedSize }
}
