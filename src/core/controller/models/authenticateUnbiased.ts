import os from "node:os"
import { EmptyRequest } from "@shared/proto/dirac/common"
import { UnbiasedAuthEvent } from "@shared/proto/dirac/models"
import { applyApiConfigurationTransaction } from "./apiConfigurationTransaction"
import { persistApiConfigurationPatch } from "./apiConfigurationPersistence"
import { pollUnbiasedDeviceAuth, startUnbiasedDeviceAuth } from "@/integrations/unbiased/device-auth"
import { saveUnbiasedOAuthAccount } from "@/integrations/unbiased/oauth-account"
import { fetch } from "@/shared/net"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

const signOutGeneration = new WeakMap<object, number>()

export function invalidateUnbiasedSignIns(stateManager: object): void {
	signOutGeneration.set(stateManager, (signOutGeneration.get(stateManager) ?? 0) + 1)
}

export async function authenticateUnbiased(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<UnbiasedAuthEvent>,
	requestId?: string,
): Promise<void> {
	const abortController = new AbortController()
	const generation = signOutGeneration.get(controller.stateManager) ?? 0
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, () => abortController.abort(), { type: "unbiased_auth" }, responseStream)
	}
	try {
		const options = { fetcher: fetch, signal: abortController.signal }
		const grant = await startUnbiasedDeviceAuth(os.hostname(), options)
		await responseStream(
			UnbiasedAuthEvent.create({
				url: grant.verificationUri,
				userCode: grant.userCode,
				verificationUriComplete: grant.verificationUriComplete,
			}),
		)
		const token = await pollUnbiasedDeviceAuth(grant, options)
		if (generation !== (signOutGeneration.get(controller.stateManager) ?? 0)) return
		// Persist the one-time issued key before validating an active Task update.
		// Even if that update fails, the user can use their key without signing in again.
		const patch = { unbiasedApiKey: token.accessToken }
		const stateManager = controller.stateManager
		persistApiConfigurationPatch(stateManager, patch)
		saveUnbiasedOAuthAccount(stateManager, token)
		await stateManager.flushPendingState()
		try {
			if (!abortController.signal.aborted && generation === (signOutGeneration.get(stateManager) ?? 0)) {
				await applyApiConfigurationTransaction(controller, stateManager.getApiConfiguration(), () => {}, undefined, patch)
			}
		} finally {
			// Publish the saved key even if the user cancelled or the active Task update failed.
			await controller.postStateToWebview()
		}
		if (!abortController.signal.aborted && generation === (signOutGeneration.get(stateManager) ?? 0)) {
			await responseStream(UnbiasedAuthEvent.create({ completed: true, workloadName: token.workloadName }), true)
		}
	} catch (error) {
		if (!abortController.signal.aborted) throw error
	} finally {
		if (requestId) getRequestRegistry().cancelRequest(requestId)
	}
}
