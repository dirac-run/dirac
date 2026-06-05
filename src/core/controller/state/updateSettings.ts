import { buildApiHandler } from "@core/api"
import { Empty } from "@shared/proto/dirac/common"
import { PlanActMode, UpdateSettingsRequest } from "@shared/proto/dirac/state"
import { convertProtoToApiConfiguration } from "@shared/proto-conversions/models/api-configuration-conversion"
import { TelemetrySetting } from "@shared/TelemetrySetting"
import { DiracEnv } from "@/config"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { telemetryService } from "../../../services/telemetry"
import { BrowserSettings as SharedBrowserSettings } from "../../../shared/BrowserSettings"
import { Controller } from ".."
import { ToolRegistry } from "@core/task/tools/registry/ToolRegistry"

/**
 * Updates multiple extension settings in a single request
 * @param controller The controller instance
 * @param request The request containing the settings to update
 * @returns An empty response
 */
export async function updateSettings(controller: Controller, request: UpdateSettingsRequest): Promise<Empty> {
	try {
		if (request.diracEnv !== undefined) {
			DiracEnv.setEnvironment(request.diracEnv)
		}

		if (request.apiConfiguration) {
			const protoApiConfiguration = request.apiConfiguration

			const convertedApiConfigurationFromProto = convertProtoToApiConfiguration(protoApiConfiguration)
			controller.stateManager.setApiConfiguration(convertedApiConfigurationFromProto)

			if (controller.task) {
				const currentMode = controller.stateManager.getGlobalSettingsKey("mode")
				const apiConfigForHandler = {
					...convertedApiConfigurationFromProto,
					ulid: controller.task.ulid,
				}
				controller.task.api = buildApiHandler(apiConfigForHandler, currentMode)
			}
		}

		// Update telemetry setting
		if (request.telemetrySetting) {
			await controller.updateTelemetrySetting(request.telemetrySetting as TelemetrySetting)
		}

		// Update plan/act separate models setting
		if (request.planActSeparateModelsSetting !== undefined) {
			controller.stateManager.setGlobalState("planActSeparateModelsSetting", request.planActSeparateModelsSetting)
		}

		// Update checkpoints setting
		if (request.enableCheckpointsSetting !== undefined) {
			controller.stateManager.setGlobalState("enableCheckpointsSetting", request.enableCheckpointsSetting)
		}

		if (request.mode !== undefined) {
			const mode = request.mode === PlanActMode.PLAN ? "plan" : "act"
			controller.stateManager.setGlobalState("mode", mode)
			controller.stateManager.setSessionOverride("mode", mode)
		}

		if (request.preferredLanguage !== undefined) {
			controller.stateManager.setGlobalState("preferredLanguage", request.preferredLanguage)
		}

		// Update terminal timeout setting
		if (request.shellIntegrationTimeout !== undefined) {
			controller.stateManager.setGlobalState("shellIntegrationTimeout", Number(request.shellIntegrationTimeout))
		}

		// Update terminal reuse setting
		if (request.terminalReuseEnabled !== undefined) {
			controller.stateManager.setGlobalState("terminalReuseEnabled", request.terminalReuseEnabled)
		}

		// Update terminal output line limit
		if (request.terminalOutputLineLimit !== undefined) {
			controller.stateManager.setGlobalState("terminalOutputLineLimit", Number(request.terminalOutputLineLimit))
		}

		if (request.vscodeTerminalExecutionMode !== undefined && request.vscodeTerminalExecutionMode !== "") {
			controller.stateManager.setGlobalState(
				"vscodeTerminalExecutionMode",
				request.vscodeTerminalExecutionMode === "backgroundExec" ? "backgroundExec" : "vscodeTerminal",
			)
		}

		// Update max consecutive mistakes
		if (request.maxConsecutiveMistakes !== undefined) {
			controller.stateManager.setGlobalState("maxConsecutiveMistakes", Number(request.maxConsecutiveMistakes))
		}

		// Update strict plan mode setting
		if (request.strictPlanModeEnabled !== undefined) {
			controller.stateManager.setGlobalState("strictPlanModeEnabled", request.strictPlanModeEnabled)
		}

		if (request.hooksEnabled !== undefined) {
			const wasEnabled = controller.stateManager.getGlobalSettingsKey("hooksEnabled") ?? true
			const isEnabled = !!request.hooksEnabled
			controller.stateManager.setGlobalState("hooksEnabled", isEnabled)
			if (controller.task && wasEnabled !== isEnabled) {
				telemetryService.captureFeatureToggle(controller.task.ulid, "hooks", isEnabled, controller.task.api.getModel().id)
			}
		}
		// Update yolo mode setting
		if (request.yoloModeToggled !== undefined) {
			if (controller.task) {
				telemetryService.captureYoloModeToggle(controller.task.ulid, request.yoloModeToggled)
			}
			controller.stateManager.setGlobalState("yoloModeToggled", request.yoloModeToggled)
		}

		// Update dirac web tools setting
		if (request.diracWebToolsEnabled !== undefined) {
			if (controller.task) {
				telemetryService.captureDiracWebToolsToggle(controller.task.ulid, request.diracWebToolsEnabled)
			}
			controller.stateManager.setGlobalState("diracWebToolsEnabled", request.diracWebToolsEnabled)
		}

		// Update worktrees setting
		if (request.worktreesEnabled !== undefined) {
			controller.stateManager.setGlobalState("worktreesEnabled", request.worktreesEnabled)
		}

		// Update subagents setting
		if (request.subagentsEnabled !== undefined) {
			const wasEnabled = controller.stateManager.getGlobalSettingsKey("subagentsEnabled") ?? false
			const isEnabled = !!request.subagentsEnabled
			controller.stateManager.setGlobalState("subagentsEnabled", isEnabled)

			// Capture telemetry when setting changes
			if (wasEnabled !== isEnabled) {
				telemetryService.captureSubagentToggle(isEnabled)
			}
		}

		// Update auto-condense setting
		if (request.useAutoCondense !== undefined) {
			if (controller.task) {
				telemetryService.captureAutoCondenseToggle(
					controller.task.ulid,
					request.useAutoCondense,
					controller.task.api.getModel().id,
				)
			}
			controller.stateManager.setGlobalState("useAutoCondense", request.useAutoCondense)
		}

		// Update custom prompt choice
		if (request.customPrompt !== undefined) {
			const value = request.customPrompt === "compact" ? "compact" : undefined
			controller.stateManager.setGlobalState("customPrompt", value)
		}

		// Update browser settings
		if (request.browserSettings !== undefined) {
			// Get current browser settings to preserve fields not in the request
			const currentSettings = controller.stateManager.getGlobalSettingsKey("browserSettings")

			// Convert from protobuf format to shared format, merging with existing settings
			const newBrowserSettings: SharedBrowserSettings = {
				...currentSettings, // Start with existing settings (and defaults)
				viewport: {
					// Apply updates from request
					width: request.browserSettings.viewport?.width || currentSettings.viewport.width,
					height: request.browserSettings.viewport?.height || currentSettings.viewport.height,
				},
				// Explicitly handle optional boolean and string fields from the request
				remoteBrowserEnabled:
					request.browserSettings.remoteBrowserEnabled === undefined
						? currentSettings.remoteBrowserEnabled
						: request.browserSettings.remoteBrowserEnabled,
				remoteBrowserHost:
					request.browserSettings.remoteBrowserHost === undefined
						? currentSettings.remoteBrowserHost
						: request.browserSettings.remoteBrowserHost,
				chromeExecutablePath:
					// If chromeExecutablePath is explicitly in the request (even as ""), use it.
					// Otherwise, fall back to mergedWithDefaults.
					"chromeExecutablePath" in request.browserSettings
						? request.browserSettings.chromeExecutablePath
						: currentSettings.chromeExecutablePath,
				disableToolUse:
					request.browserSettings.disableToolUse === undefined
						? currentSettings.disableToolUse
						: request.browserSettings.disableToolUse,
				customArgs:
					"customArgs" in request.browserSettings ? request.browserSettings.customArgs : currentSettings.customArgs,
			}

			// Update global state with new settings
			controller.stateManager.setGlobalState("browserSettings", newBrowserSettings)
		}

		// Update default terminal profile
		if (request.defaultTerminalProfile !== undefined) {
			const profileId = request.defaultTerminalProfile

			// Update the terminal profile in the state
			controller.stateManager.setGlobalState("defaultTerminalProfile", profileId)

			let closedCount = 0
			let busyTerminalsCount = 0

			// Update the terminal manager of the current task if it exists
			if (controller.task) {
				// Call the updated setDefaultTerminalProfile method that returns closed terminal info
				// Use `as any` to handle type incompatibility between VSCode's TerminalInfo and standalone TerminalInfo
				const result = controller.task.terminalManager.setDefaultTerminalProfile(profileId) as any
				closedCount = result.closedCount
				busyTerminalsCount = result.busyTerminals?.length ?? 0

				// Show information message if terminals were closed
				if (closedCount > 0) {
					const message = `Closed ${closedCount} ${closedCount === 1 ? "terminal" : "terminals"} with different profile.`
					HostProvider.window.showMessage({
						type: ShowMessageType.INFORMATION,
						message,
					})
				}

				// Show warning if there are busy terminals that couldn't be closed
				if (busyTerminalsCount > 0) {
					const message =
						`${busyTerminalsCount} busy ${busyTerminalsCount === 1 ? "terminal has" : "terminals have"} a different profile. ` +
						`Close ${busyTerminalsCount === 1 ? "it" : "them"} to use the new profile for all commands.`
					HostProvider.window.showMessage({
						type: ShowMessageType.WARNING,
						message,
					})
				}
			}
		}

		if (request.backgroundEditEnabled !== undefined) {
			controller.stateManager.setGlobalState("backgroundEditEnabled", !!request.backgroundEditEnabled)
		}

		if (request.multiRootEnabled !== undefined) {
			controller.stateManager.setGlobalState("multiRootEnabled", !!request.multiRootEnabled)
		}

		if (request.enableParallelToolCalling !== undefined) {
			controller.stateManager.setGlobalState("enableParallelToolCalling", !!request.enableParallelToolCalling)
		}

		if (request.doubleCheckCompletionEnabled !== undefined) {
			controller.stateManager.setGlobalState("doubleCheckCompletionEnabled", request.doubleCheckCompletionEnabled)
		}
		if (request.writePromptMetadataEnabled !== undefined) {
			controller.stateManager.setGlobalState("writePromptMetadataEnabled", request.writePromptMetadataEnabled)
		}
		if (request.autoApproveAllToggled !== undefined) {
			controller.stateManager.setGlobalState("autoApproveAllToggled", request.autoApproveAllToggled)
		}

		if (request.writePromptMetadataDirectory !== undefined) {
			controller.stateManager.setGlobalState("writePromptMetadataDirectory", request.writePromptMetadataDirectory)
		}

		if (request.toolToggles !== undefined) {
			const toggles = JSON.parse(request.toolToggles) as Record<string, boolean>
			controller.stateManager.setGlobalState("toolToggles", toggles)
			ToolRegistry.getInstance().loadToggles(toggles)
			controller.task?.markToolsDirty("tool_toggles_changed")
		}

		// Post updated state to webview
		await controller.postStateToWebview()

		return Empty.create()
	} catch (error) {
		Logger.error("Failed to update settings:", error)
		throw error
	}
}
