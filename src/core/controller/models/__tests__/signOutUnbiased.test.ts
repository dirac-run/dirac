import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import type { StateManager } from "@core/storage/StateManager"
import type { GlobalState } from "@shared/storage/state-keys"
import { getUnbiasedOAuthWorkloadName, createUnbiasedOAuthAccount } from "@/integrations/unbiased/oauth-account"
import { signOutUnbiasedKey } from "../signOutUnbiased"

function createAccountStore() {
	let apiKey: string | undefined = "private-oauth-key"
	const globalState: Partial<GlobalState> = {}
	const flush = sinon.stub().resolves()
	const stateManager = {
		getSecretKey: () => apiKey,
		getApiConfiguration: () => ({ unbiasedApiKey: apiKey }),
		getGlobalStateKey: (key: keyof GlobalState) => globalState[key],
		setSecret: (_key: string, value: string | undefined) => {
			apiKey = value
		},
		setGlobalStateBatch: (updates: Partial<GlobalState>) => Object.assign(globalState, updates),
		flushPendingState: flush,
	} as unknown as StateManager
	stateManager.setGlobalStateBatch(
		createUnbiasedOAuthAccount({
			accessToken: apiKey,
			organizationId: "organization",
			workloadId: "workload",
			workloadName: "Dirac workload",
			keyName: "Dirac key",
		}),
	)
	return { stateManager, globalState, flush }
}

describe("Unbiased account sign-out", () => {
	let previousUnbiasedKey: string | undefined
	let previousDiracKey: string | undefined
	beforeEach(() => {
		previousUnbiasedKey = process.env.UNBIASED_API_KEY
		previousDiracKey = process.env.DIRAC_API_KEY
		delete process.env.UNBIASED_API_KEY
		delete process.env.DIRAC_API_KEY
	})
	afterEach(() => {
		if (previousUnbiasedKey === undefined) delete process.env.UNBIASED_API_KEY
		else process.env.UNBIASED_API_KEY = previousUnbiasedKey
		if (previousDiracKey === undefined) delete process.env.DIRAC_API_KEY
		else process.env.DIRAC_API_KEY = previousDiracKey
	})

	it("clears the local key and persisted identity together", async () => {
		const store = createAccountStore()
		await signOutUnbiasedKey(store.stateManager)
		assert.equal(store.stateManager.getSecretKey("unbiasedApiKey"), undefined)
		assert.equal(store.globalState.unbiasedOAuthApiKeyHash, undefined)
		assert.equal(store.globalState.unbiasedOAuthWorkloadName, undefined)
		assert.equal(
			getUnbiasedOAuthWorkloadName(
				store.stateManager.getApiConfiguration().unbiasedApiKey,
				store.stateManager.getGlobalStateKey("unbiasedOAuthApiKeyHash"),
				store.stateManager.getGlobalStateKey("unbiasedOAuthWorkloadName"),
			),
			undefined,
		)
		assert.equal(store.flush.callCount, 1)
	})

	it("restores both the key and identity when persistence fails", async () => {
		const store = createAccountStore()
		const previousAccount = { ...store.globalState }
		store.flush.onFirstCall().rejects(new Error("disk write failed"))
		await assert.rejects(signOutUnbiasedKey(store.stateManager), /disk write failed/)
		assert.equal(store.stateManager.getSecretKey("unbiasedApiKey"), "private-oauth-key")
		assert.deepEqual(store.globalState, previousAccount)
		assert.equal(
			getUnbiasedOAuthWorkloadName(
				store.stateManager.getApiConfiguration().unbiasedApiKey,
				store.stateManager.getGlobalStateKey("unbiasedOAuthApiKeyHash"),
				store.stateManager.getGlobalStateKey("unbiasedOAuthWorkloadName"),
			),
			"Dirac workload",
		)
		assert.equal(store.flush.callCount, 2)
	})

	it("retains the account when an environment-backed key prevents local sign-out", async () => {
		const store = createAccountStore()
		process.env.UNBIASED_API_KEY = "environment-private-key"
		await assert.rejects(signOutUnbiasedKey(store.stateManager), /Remove UNBIASED_API_KEY/)
		assert.equal(store.stateManager.getSecretKey("unbiasedApiKey"), "private-oauth-key")
		assert.equal(
			getUnbiasedOAuthWorkloadName(
				store.stateManager.getApiConfiguration().unbiasedApiKey,
				store.stateManager.getGlobalStateKey("unbiasedOAuthApiKeyHash"),
				store.stateManager.getGlobalStateKey("unbiasedOAuthWorkloadName"),
			),
			"Dirac workload",
		)
		assert.equal(store.flush.callCount, 0)
	})
})
