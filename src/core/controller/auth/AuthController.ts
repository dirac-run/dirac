import { applyProviderSetupTransaction, type ApiConfigurationTransactionTask } from "@core/controller/models/apiConfigurationTransaction"
import type { StateManager } from "@core/storage/StateManager"
import { ShowMessageType } from "@shared/proto/host/window"
import axios from "axios"
import { HostProvider } from "@/hosts/host-provider"
import { githubCopilotAuthManager } from "@/integrations/github-copilot/auth"
import { getErrorMessage } from "@/shared/errors"
import { getAxiosSettings } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { openExternal } from "@/utils/env"

export interface AuthControllerDependencies {
	stateManager: StateManager
	postStateToWebview(): Promise<void>
	task?: ApiConfigurationTransactionTask
}

export class AuthController {
	constructor(private readonly deps: AuthControllerDependencies) { }

	async completeOpenRouterAuth(code: string) {
		let apiKey: string
		try {
			const response = await axios.post("https://openrouter.ai/api/v1/auth/keys", { code }, getAxiosSettings())
			if (response.data && response.data.key) {
				apiKey = response.data.key
			} else {
				throw new Error("Invalid response from OpenRouter API")
			}
		} catch (error) {
			Logger.error("Error exchanging code for API key:", error)
			throw error
		}

		await applyProviderSetupTransaction(this.deps, { openRouterApiKey: apiKey })
		await this.deps.postStateToWebview()
	}

	async completeGithubLogin() {
		try {
			const data = await githubCopilotAuthManager.initiateDeviceFlow()
			const openUrl = "Open GitHub"
			const response = await HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `GitHub Copilot: Enter code ${data.user_code} at ${data.verification_uri}`,
				options: { items: [openUrl] },
			})
			if (response.selectedOption !== openUrl) return

			await openExternal(data.verification_uri)

			githubCopilotAuthManager
				.pollForToken(data.device_code, data.interval)
				.then(async () => {
					await this.deps.postStateToWebview()
					HostProvider.window.showMessage({
						type: ShowMessageType.INFORMATION,
						message: "Successfully authenticated with GitHub Copilot!",
					})
				})
				.catch((error) => {
					Logger.error("GitHub Copilot auth polling failed:", error)
				})
		} catch (error) {
			Logger.error("GitHub Copilot login failed:", error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `GitHub Copilot login failed: ${getErrorMessage(error)}`,
			})
		}
	}

	async completeRequestyAuth(code: string) {
		await applyProviderSetupTransaction(this.deps, { requestyApiKey: code })
		await this.deps.postStateToWebview()
	}
}
