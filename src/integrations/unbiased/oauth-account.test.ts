import assert from "node:assert/strict"
import type { StateManager } from "@core/storage/StateManager"
import type { GlobalState } from "@shared/storage/state-keys"
import { describe, it } from "mocha"
import type { UnbiasedDeviceToken } from "./device-auth"
import { getUnbiasedOAuthWorkloadName, isUnbiasedOAuthApiKey, saveUnbiasedOAuthAccount } from "./oauth-account"

const token: UnbiasedDeviceToken = {
	accessToken: "private-oauth-key",
	organizationId: "organization",
	workloadId: "workload",
	workloadName: "Dirac workload",
	keyName: "Dirac key",
}

function accountStore(apiKey: string | undefined, persisted: Partial<GlobalState> = {}) {
	const globalState = { ...persisted }
	const apiConfiguration = { unbiasedApiKey: apiKey }
	const stateManager = {
		getApiConfiguration: () => apiConfiguration,
		getGlobalStateKey: (key: keyof GlobalState) => globalState[key],
		setGlobalStateBatch: (updates: Partial<GlobalState>) => Object.assign(globalState, updates),
	} as unknown as StateManager
	return { stateManager, globalState, apiConfiguration }
}

describe("Unbiased OAuth account identity", () => {
	it("persists the workload for a matching key and restores it from a fresh state cache", () => {
		const store = accountStore(token.accessToken)
		saveUnbiasedOAuthAccount(store.stateManager, token)
		assert.equal(getUnbiasedOAuthWorkloadName(store.stateManager), token.workloadName)
		assert.equal(JSON.stringify(store.globalState).includes(token.accessToken), false)
		assert.match(store.globalState.unbiasedOAuthApiKeyHash!, /^[a-f0-9]{64}$/)
		const reopened = accountStore(token.accessToken, store.globalState)
		assert.equal(getUnbiasedOAuthWorkloadName(reopened.stateManager), token.workloadName)
		assert.equal(isUnbiasedOAuthApiKey(token.accessToken, reopened.globalState.unbiasedOAuthApiKeyHash), true)
	})

	it("supports existing and manually configured keys without inventing an OAuth identity", () => {
		const store = accountStore("existing-private-key")
		assert.equal(getUnbiasedOAuthWorkloadName(store.stateManager), undefined)
	})

	it("does not attribute the old workload to a replacement or environment-overridden key", () => {
		const store = accountStore(token.accessToken)
		saveUnbiasedOAuthAccount(store.stateManager, token)
		store.apiConfiguration.unbiasedApiKey = "different-effective-key"
		assert.equal(getUnbiasedOAuthWorkloadName(store.stateManager), undefined)
		store.apiConfiguration.unbiasedApiKey = undefined
		assert.equal(getUnbiasedOAuthWorkloadName(store.stateManager), undefined)
	})

	it("replaces account identity on the next OAuth login", () => {
		const store = accountStore(token.accessToken)
		saveUnbiasedOAuthAccount(store.stateManager, token)
		const replacement = { ...token, accessToken: "new-private-key", workloadName: "New workload" }
		store.apiConfiguration.unbiasedApiKey = replacement.accessToken
		saveUnbiasedOAuthAccount(store.stateManager, replacement)
		assert.equal(getUnbiasedOAuthWorkloadName(store.stateManager), replacement.workloadName)
	})
})

describe("Unbiased OAuth key matching", () => {
	it("matches an explicit request key independently of the current default account", () => {
		const store = accountStore(token.accessToken)
		saveUnbiasedOAuthAccount(store.stateManager, token)
		store.apiConfiguration.unbiasedApiKey = "replacement-or-environment-key"
		const hash = store.globalState.unbiasedOAuthApiKeyHash
		assert.equal(isUnbiasedOAuthApiKey(token.accessToken, hash), true)
		assert.equal(isUnbiasedOAuthApiKey(store.apiConfiguration.unbiasedApiKey, hash), false)
		assert.equal(isUnbiasedOAuthApiKey(undefined, hash), false)
		assert.equal(isUnbiasedOAuthApiKey("", hash), false)
		assert.equal(isUnbiasedOAuthApiKey(token.accessToken, undefined), false)
	})

	it("does not depend on a nonempty workload display name", () => {
		const store = accountStore(token.accessToken)
		saveUnbiasedOAuthAccount(store.stateManager, { ...token, workloadName: "" })
		assert.equal(isUnbiasedOAuthApiKey(token.accessToken, store.globalState.unbiasedOAuthApiKeyHash), true)
		assert.equal(getUnbiasedOAuthWorkloadName(store.stateManager), "")
	})
})
