import { buildApiHandler } from "@core/api"
import type { ChatContent } from "@shared/ChatContent"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import type { Mode } from "@shared/storage/types"
import { DiracAskResponse } from "@shared/WebviewMessage"
import type { StateManager } from "@core/storage/StateManager"
import { telemetryService } from "@/services/telemetry"

export interface StateControllerDependencies {
	stateManager: StateManager
	get task(): import("@core/task").Task | undefined
	buildApiHandlerFn: typeof buildApiHandler
	postStateToWebviewFn: () => Promise<void>
	cancelTaskFn: () => Promise<void>
}

export class StateController {
	private readonly stateManager: StateManager
	private readonly getTask: () => import("@core/task").Task | undefined
	private readonly buildApiHandlerFn: typeof buildApiHandler
	private readonly postStateToWebviewFn: () => Promise<void>
	private readonly cancelTaskFn: () => Promise<void>

	constructor(deps: StateControllerDependencies) {
		this.stateManager = deps.stateManager
		this.getTask = () => deps.task
		this.buildApiHandlerFn = deps.buildApiHandlerFn
		this.postStateToWebviewFn = deps.postStateToWebviewFn
		this.cancelTaskFn = deps.cancelTaskFn
	}

	async updateTelemetrySetting(telemetrySetting: TelemetrySetting): Promise<void> {
		const previousSetting = this.stateManager.getGlobalSettingsKey("telemetrySetting")
		const wasOptedIn = previousSetting !== "disabled"
		const isOptedIn = telemetrySetting !== "disabled"

		if (wasOptedIn && !isOptedIn) {
			telemetryService.captureUserOptOut()
		}

		this.stateManager.setGlobalState("telemetrySetting", telemetrySetting)
		telemetryService.updateTelemetryState(isOptedIn)

		if (!wasOptedIn && isOptedIn) {
			telemetryService.captureUserOptIn()
		}

		await this.postStateToWebviewFn()
	}

	async toggleActModeForYoloMode(): Promise<boolean> {
		const modeToSwitchTo: Mode = "act"

		this.stateManager.setGlobalState("mode", modeToSwitchTo)
		this.stateManager.setSessionOverride("mode", modeToSwitchTo)

		const task = this.getTask()
		if (task) {
			const apiConfiguration = this.stateManager.getApiConfiguration()
			task.api = this.buildApiHandlerFn({ ...apiConfiguration, ulid: task.ulid }, modeToSwitchTo)
		}

		await this.postStateToWebviewFn()

		return !!this.getTask()
	}

	async togglePlanActMode(modeToSwitchTo: Mode, chatContent?: ChatContent): Promise<boolean> {
		const didSwitchToActMode = modeToSwitchTo === "act"

		this.stateManager.setGlobalState("mode", modeToSwitchTo)
		this.stateManager.setSessionOverride("mode", modeToSwitchTo)

		telemetryService.captureModeSwitch(this.getTask()?.ulid ?? "0", modeToSwitchTo)

		const task = this.getTask()
		if (task) {
			if (didSwitchToActMode) {
				task.taskState.didSwitchToActMode = true
			}
			const apiConfiguration = this.stateManager.getApiConfiguration()
			task.api = this.buildApiHandlerFn({ ...apiConfiguration, ulid: task.ulid }, modeToSwitchTo)
		}

		await this.postStateToWebviewFn()

		if (task) {
			if (task.taskState.isAwaitingPlanResponse && didSwitchToActMode) {
				task.taskState.didRespondToPlanAskBySwitchingMode = true
				const cardId = task.taskState.lastWaitingCardId
				if (cardId) {
					await task.submitCardResponse(
						cardId,
						DiracAskResponse.APPROVE,
						chatContent?.message || "PLAN_MODE_TOGGLE_RESPONSE",
						chatContent?.images || [],
						chatContent?.files || [],
					)
				}

				return true
			}
			await this.cancelTaskFn()
			return false
		}

		return false
	}

	async getTelemetrySetting(): Promise<TelemetrySetting> {
		return this.stateManager.getGlobalSettingsKey("telemetrySetting") || "default"
	}
}
