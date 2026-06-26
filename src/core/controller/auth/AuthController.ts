import type { ApiProvider } from "@shared/api"
import axios from "axios"
import open from "open"
import { buildApiHandler } from "@core/api"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@shared/proto/host/window"
import { getAxiosSettings } from "@/shared/net"
import { githubCopilotAuthManager } from "@/integrations/github-copilot/auth"
import { Logger } from "@/shared/services/Logger"
import type { StateManager } from "@core/storage/StateManager"

export interface AuthControllerDependencies {
	stateManager: StateManager
	postStateToWebview(): Promise<void>
	task?: {
		api: any
		ulid: string
	}
}

export class AuthController {
	constructor(private readonly deps: AuthControllerDependencies) {}

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

		const openrouter: ApiProvider = "openrouter"
		const currentMode = this.deps.stateManager.getGlobalSettingsKey("mode")

		const currentApiConfiguration = this.deps.stateManager.getApiConfiguration()
		const updatedConfig = {
			...currentApiConfiguration,
			planModeApiProvider: openrouter,
			actModeApiProvider: openrouter,
			openRouterApiKey: apiKey,
		}
		this.deps.stateManager.setApiConfiguration(updatedConfig)

		await this.deps.postStateToWebview()
		if (this.deps.task) {
			this.deps.task.api = buildApiHandler({ ...updatedConfig, ulid: this.deps.task.ulid }, currentMode)
		}
	}

	async completeGithubLogin() {
		try {
			const data = await githubCopilotAuthManager.initiateDeviceFlow()
			const openUrl = "Open GitHub"
			const response = await HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `GitHub Copilot: Enter code ${data.user_code} at ${data.verification_uri}`,
			})

			await open(data.verification_uri)

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
				message: `GitHub Copilot login failed: ${error instanceof Error ? error.message : String(error)}`,
			})
		}
	}

	async completeRequestyAuth(code: string) {
		const requesty: ApiProvider = "requesty"
		const currentMode = this.deps.stateManager.getGlobalSettingsKey("mode")
		const currentApiConfiguration = this.deps.stateManager.getApiConfiguration()
		const updatedConfig = {
			...currentApiConfiguration,
			planModeApiProvider: requesty,
			actModeApiProvider: requesty,
			requestyApiKey: code,
		}
		this.deps.stateManager.setApiConfiguration(updatedConfig)
		await this.deps.postStateToWebview()
		if (this.deps.task) {
			this.deps.task.api = buildApiHandler({ ...updatedConfig, ulid: this.deps.task.ulid }, currentMode)
		}
	}
}
