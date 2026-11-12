import { buildApiHandler } from "@core/api"
import type { StateManager } from "@core/storage/StateManager"
import type { ChatContent } from "@shared/ChatContent"
import type { Mode } from "@shared/storage/types"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import { telemetryService } from "@/services/telemetry"
import { persistModeSelection } from "./persistModeSelection"

export interface StateControllerDependencies {
	stateManager: StateManager
	get task(): import("@core/task").Task | undefined
	buildApiHandlerFn: typeof buildApiHandler
	postStateToWebviewFn: () => Promise<void>
	captureModeSwitchFn: (taskId: string, mode: Mode) => void
}

export class StateController {
	private readonly stateManager: StateManager
	private readonly getTask: () => import("@core/task").Task | undefined
	private readonly buildApiHandlerFn: typeof buildApiHandler
	private readonly postStateToWebviewFn: () => Promise<void>
	private readonly captureModeSwitchFn: (taskId: string, mode: Mode) => void

	constructor(deps: StateControllerDependencies) {
		this.stateManager = deps.stateManager
		this.getTask = () => deps.task
		this.buildApiHandlerFn = deps.buildApiHandlerFn
		this.postStateToWebviewFn = deps.postStateToWebviewFn
		this.captureModeSwitchFn = deps.captureModeSwitchFn
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
		const task = this.getTask()
		const persistMode = () => persistModeSelection(this.stateManager, modeToSwitchTo)

		if (task) await task.applyWorkingConfigurationUpdate({ settings: { mode: modeToSwitchTo } }, persistMode)
		else persistMode()

		await this.postStateToWebviewFn()
		return !!task
	}

	async togglePlanActMode(modeToSwitchTo: Mode, chatContent?: ChatContent): Promise<boolean> {
		const task = this.getTask()
		const persistMode = () => persistModeSelection(this.stateManager, modeToSwitchTo)
		// Retain exact waiters so a concurrent answer cannot clear an unconsumed draft.
		const waiting = task ? [...task.stateView.pendingCardInteractions.values()].filter((pending) => !pending.response) : []
		if (task) await task.applyWorkingConfigurationUpdate({ settings: { mode: modeToSwitchTo } }, persistMode, chatContent)
		else persistMode()

		this.captureModeSwitchFn(task?.ulid ?? "0", modeToSwitchTo)
		await this.postStateToWebviewFn()
		return waiting.some((pending) => pending.response?.modeSwitch === modeToSwitchTo)
	}

	async getTelemetrySetting(): Promise<TelemetrySetting> {
		return this.stateManager.getGlobalSettingsKey("telemetrySetting") || "default"
	}
}
