import { Empty, EmptyRequest } from "@shared/proto/dirac/common"
import { getExplicitDiracSecretsFromEnv } from "@shared/storage/env-config"
import type { StateManager } from "@core/storage/StateManager"
import type { Controller } from "../index"
import { commitWorkingConfigurationUpdate, type ApiConfigurationTransactionTask } from "./apiConfigurationTransaction"
import { invalidateUnbiasedSignIns } from "./authenticateUnbiased"

/** Remove a locally stored key without allowing a late device poll to restore it. */
export async function signOutUnbiasedKey(stateManager: StateManager, task?: ApiConfigurationTransactionTask): Promise<void> {
	if (process.env.UNBIASED_API_KEY) throw new Error("Remove UNBIASED_API_KEY from the environment to sign out.")
	if (getExplicitDiracSecretsFromEnv().unbiasedApiKey) {
		throw new Error("Remove DIRAC_API_KEY from the environment to sign out of Unbiased.")
	}

	invalidateUnbiasedSignIns(stateManager)
	const previousKey = stateManager.getSecretKey("unbiasedApiKey")
	const previousAccount = {
		unbiasedOAuthApiKeyHash: stateManager.getGlobalStateKey("unbiasedOAuthApiKeyHash"),
		unbiasedOAuthWorkloadName: stateManager.getGlobalStateKey("unbiasedOAuthWorkloadName"),
	}
	await commitWorkingConfigurationUpdate(
		{ stateManager, task },
		async () => {
			stateManager.setSecret("unbiasedApiKey", undefined)
			stateManager.setGlobalStateBatch({ unbiasedOAuthApiKeyHash: undefined, unbiasedOAuthWorkloadName: undefined })
			try {
				await stateManager.flushPendingState()
			} catch (error) {
				stateManager.setSecret("unbiasedApiKey", previousKey)
				stateManager.setGlobalStateBatch(previousAccount)
				try {
					await stateManager.flushPendingState()
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "Unbiased sign-out and rollback failed")
				}
				throw error
			}
		},
		{ apiConfiguration: { unbiasedApiKey: undefined } },
	)
}

export async function signOutUnbiased(controller: Controller, _request: EmptyRequest): Promise<Empty> {
	await signOutUnbiasedKey(controller.stateManager, controller.task)
	await controller.postStateToWebview()
	return Empty.create()
}
