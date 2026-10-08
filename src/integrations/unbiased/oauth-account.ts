import { createHash } from "node:crypto"
import type { StateManager } from "@core/storage/StateManager"
import type { UnbiasedDeviceToken } from "./device-auth"

function hashApiKey(apiKey: string): string {
	return createHash("sha256").update(apiKey).digest("hex")
}

/** Bind the OAuth workload name to its key without storing another copy of the key. */
export function saveUnbiasedOAuthAccount(stateManager: StateManager, token: UnbiasedDeviceToken): void {
	stateManager.setGlobalStateBatch({
		unbiasedOAuthApiKeyHash: hashApiKey(token.accessToken),
		unbiasedOAuthWorkloadName: token.workloadName,
	})
}

/** Only show OAuth identity when it belongs to the effective key, including environment overrides. */
export function getUnbiasedOAuthWorkloadName(stateManager: StateManager): string | undefined {
	const apiKey = stateManager.getApiConfiguration().unbiasedApiKey
	if (!apiKey) return undefined
	if (stateManager.getGlobalStateKey("unbiasedOAuthApiKeyHash") !== hashApiKey(apiKey)) return undefined
	return stateManager.getGlobalStateKey("unbiasedOAuthWorkloadName")
}
