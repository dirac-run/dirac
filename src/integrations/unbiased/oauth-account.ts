import { createHash } from "node:crypto"
import type { UnbiasedDeviceToken } from "./device-auth"

function hashApiKey(apiKey: string): string {
	return createHash("sha256").update(apiKey).digest("hex")
}

/** Match the actual request key, not the current default key or a display name. */
export function isUnbiasedOAuthApiKey(apiKey: string | undefined, oauthApiKeyHash: string | undefined): boolean {
	return !!apiKey && oauthApiKeyHash === hashApiKey(apiKey)
}

/** Bind the OAuth workload name to its key without storing another copy of the key. */
export function createUnbiasedOAuthAccount(token: UnbiasedDeviceToken) {
	return {
		unbiasedOAuthApiKeyHash: hashApiKey(token.accessToken),
		unbiasedOAuthWorkloadName: token.workloadName,
	}
}

/** Only show OAuth identity when it belongs to the effective key, including environment overrides. */
export function getUnbiasedOAuthWorkloadName(
	apiKey: string | undefined,
	oauthApiKeyHash: string | undefined,
	workloadName: string | undefined,
): string | undefined {
	if (!isUnbiasedOAuthApiKey(apiKey, oauthApiKeyHash)) return undefined
	return workloadName
}
