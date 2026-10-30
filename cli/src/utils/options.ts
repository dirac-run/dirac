import { isValidAutoCondenseContextLimit } from "@shared/context-management"
import { modelSupportsInferenceSpeed, providerSupportsInferenceSpeed, type ApiProvider } from "@shared/api"
import type { InferenceSpeed, OpenaiReasoningEffort } from "@/shared/storage/types"
import type { Controller } from "@/core/controller"
import type { TaskOptions } from "../types"
import { applyToolSelectionOptions } from "./tool-options"

export async function setModeScopedState(currentMode: "act" | "plan", setter: (mode: "act" | "plan") => void): Promise<void> {
	const { StateManager } = await import("@/core/storage/StateManager")
	const stateManager = StateManager.get()
	setter(currentMode)

	const separateModels = stateManager.getGlobalSettingsKey("planActSeparateModelsSetting") ?? false
	if (!separateModels) {
		const otherMode: "act" | "plan" = currentMode === "act" ? "plan" : "act"
		setter(otherMode)
	}
}

export async function normalizeReasoningEffort(value?: string): Promise<OpenaiReasoningEffort | undefined> {
	if (value === undefined) {
		return undefined
	}

	const { isOpenaiReasoningEffort } = await import("@/shared/storage/types")
	const normalized = value.toLowerCase()
	if (isOpenaiReasoningEffort(normalized)) {
		return normalized
	}
	const { OPENAI_REASONING_EFFORT_OPTIONS } = await import("@/shared/storage/types")
	throw new Error(`Invalid reasoning effort '${value}'. Valid values: ${OPENAI_REASONING_EFFORT_OPTIONS.join(", ")}.`)
}

export async function validateProvider(provider: string): Promise<void> {
	if (provider.startsWith("http://") || provider.startsWith("https://")) {
		return
	}

	const { ALL_PROVIDERS } = await import("@shared/api")
	if (!ALL_PROVIDERS.includes(provider as ApiProvider)) {
		throw new Error(`Invalid provider '${provider}'. Valid providers: ${[...ALL_PROVIDERS].sort().join(", ")}`)
	}
}

export async function normalizeMaxConsecutiveMistakes(value?: string | number): Promise<number | undefined> {
	if (value === undefined) {
		return undefined
	}

	const parsed = typeof value === "number" ? value : Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new Error(`Invalid maximum consecutive mistakes '${value}'. Expected an integer greater than zero.`)
	}

	return parsed
}

export async function applyTaskOptions(options: TaskOptions, workspaceRoot: string, controller: Controller): Promise<void> {
	const { StateManager } = await import("@/core/storage/StateManager")
	const { telemetryService } = await import("@/services/telemetry")
	const { getProviderModelIdKey } = await import("@/shared/storage")
	const { printWarning, printError, printInfo } = await import("./display")
	const { exit } = await import("node:process")

	const stateManager = StateManager.get()

	try {
		const toolSelectionPolicy = await applyToolSelectionOptions(options, workspaceRoot)
		if (toolSelectionPolicy) controller.setTaskInitializationDefaults({ toolSelectionPolicy })
	} catch (error) {
		printError(`Error: ${error instanceof Error ? error.message : String(error)}`)
		exit(1)
	}

	if (process.env.OPENAI_COMPATIBLE_CUSTOM_KEY) {
		if (!options.provider && !process.env.OPENAI_API_BASE && !stateManager.getGlobalSettingsKey("openAiBaseUrl")) {
			printError("Error: OPENAI_COMPATIBLE_CUSTOM_KEY requires --provider (base URL) or OPENAI_API_BASE to be specified.")
			exit(1)
		}
		if (
			!options.model &&
			!stateManager.getGlobalSettingsKey("actModeOpenAiModelId") &&
			!stateManager.getGlobalSettingsKey("planModeOpenAiModelId")
		) {
			printError("Error: OPENAI_COMPATIBLE_CUSTOM_KEY requires --model to be specified.")
			exit(1)
		}
	}

	// Apply mode flag first so currentMode is correct for overrides
	if (options.plan) {
		stateManager.setSessionOverride("mode", "plan")
		telemetryService.captureHostEvent("mode_flag", "plan")
	} else if (options.act) {
		stateManager.setSessionOverride("mode", "act")
		telemetryService.captureHostEvent("mode_flag", "act")
	}

	// Validate provider/model combination
	if (options.provider && !options.model) {
		printError("Error: --provider requires --model to be specified.")
		exit(1)
	}

	// Apply model override if specified
	if (options.model) {
		const currentMode = (stateManager.getGlobalSettingsKey("mode") || "act") as "act" | "plan"

		if (options.provider) {
			await validateProvider(options.provider)
		}

		// Determine the target provider based on current mode or explicit flag
		let targetProvider: ApiProvider
		if (options.provider && (options.provider.startsWith("http://") || options.provider.startsWith("https://"))) {
			targetProvider = "openai"
			stateManager.setSessionOverride("openAiBaseUrl", options.provider)
		} else {
			const providerKey = currentMode === "act" ? "actModeApiProvider" : "planModeApiProvider"
			targetProvider = (options.provider as ApiProvider) || (stateManager.getGlobalSettingsKey(providerKey) as ApiProvider)
		}

		await setModeScopedState(currentMode, (mode) => {
			const pKey = mode === "act" ? "actModeApiProvider" : "planModeApiProvider"

			// Ensure the provider is synced if setModeScopedState calls us for multiple modes
			stateManager.setSessionOverride(pKey, targetProvider)

			const modelKey = getProviderModelIdKey(targetProvider, mode)
			if (modelKey) {
				stateManager.setSessionOverride(modelKey, options.model!)
				const speedKey = mode === "act" ? "actModeInferenceSpeed" : "planModeInferenceSpeed"
				const inferenceSpeed = stateManager.getGlobalSettingsKey(speedKey)
				if (
					(inferenceSpeed === "fast" && !modelSupportsInferenceSpeed(targetProvider, options.model!)) ||
					(inferenceSpeed === "standard" && !providerSupportsInferenceSpeed(targetProvider))
				) {
					stateManager.setSessionOverride(speedKey, "default")
				}
			}
		})
		telemetryService.captureHostEvent("model_flag", options.model)
		if (options.provider) {
			telemetryService.captureHostEvent("provider_flag", options.provider)
		}
	}

	const currentMode = (stateManager.getGlobalSettingsKey("mode") || "act") as "act" | "plan"

	// Set thinking budget based on --thinking flag (boolean or number)
	if (options.thinking !== undefined) {
		let thinkingBudget = 1024
		if (typeof options.thinking === "string" || typeof options.thinking === "number") {
			const parsed = typeof options.thinking === "number" ? options.thinking : Number(options.thinking)
			if (!Number.isInteger(parsed) || parsed < 0) {
				printWarning(`Invalid --thinking value '${options.thinking}'. Using default 1024.`)
			} else {
				thinkingBudget = parsed
			}
		}

		await setModeScopedState(currentMode, (mode) => {
			const thinkingKey = mode === "act" ? "actModeThinkingBudgetTokens" : "planModeThinkingBudgetTokens"
			stateManager.setSessionOverride(thinkingKey, thinkingBudget)
		})
		telemetryService.captureHostEvent("thinking_flag", "true")
	}

	const reasoningEffort = await normalizeReasoningEffort(options.reasoningEffort)
	if (reasoningEffort !== undefined) {
		await setModeScopedState(currentMode, (mode) => {
			const reasoningKey = mode === "act" ? "actModeReasoningEffort" : "planModeReasoningEffort"
			stateManager.setSessionOverride(reasoningKey, reasoningEffort)
		})
		telemetryService.captureHostEvent("reasoning_effort_flag", reasoningEffort)
	}

	if (options.speed !== undefined) {
		const { isInferenceSpeed, INFERENCE_SPEED_OPTIONS } = await import("@/shared/storage/types")
		if (!isInferenceSpeed(options.speed)) {
			throw new Error(`Invalid inference speed '${options.speed}'. Valid values: ${INFERENCE_SPEED_OPTIONS.join(", ")}.`)
		}
		const modes = stateManager.getGlobalSettingsKey("planActSeparateModelsSetting")
			? [currentMode]
			: (["plan", "act"] as const)
		for (const mode of modes) {
			const providerKey = mode === "act" ? "actModeApiProvider" : "planModeApiProvider"
			const provider = stateManager.getGlobalSettingsKey(providerKey) as ApiProvider | undefined
			const modelKey = provider ? getProviderModelIdKey(provider, mode) : undefined
			const modelId = modelKey ? (stateManager.getGlobalSettingsKey(modelKey) as string | undefined) : undefined
			if (options.speed === "standard" && (!provider || !providerSupportsInferenceSpeed(provider))) {
				throw new Error(`Provider ${provider || "(unconfigured)"} does not support inference speed controls`)
			}
			if (options.speed === "fast" && (!provider || !modelId || !modelSupportsInferenceSpeed(provider, modelId))) {
				throw new Error(`Model ${modelId || "(unconfigured)"} does not support Fast mode`)
			}
		}
		await setModeScopedState(currentMode, (mode) => {
			const speedKey = mode === "act" ? "actModeInferenceSpeed" : "planModeInferenceSpeed"
			stateManager.setSessionOverride(speedKey, options.speed as InferenceSpeed)
		})
		telemetryService.captureHostEvent("inference_speed_flag", options.speed)
	}

	const maxConsecutiveMistakes = await normalizeMaxConsecutiveMistakes(options.maxConsecutiveMistakes)
	if (maxConsecutiveMistakes !== undefined) {
		stateManager.setSessionOverride("maxConsecutiveMistakes", maxConsecutiveMistakes)
		telemetryService.captureHostEvent("max_consecutive_mistakes_flag", String(maxConsecutiveMistakes))
	}

	// Set yolo mode as a session-scoped override so AutoApprove picks it up,
	// but it is never persisted to disk (setSessionOverride never touches pendingGlobalState).
	if (options.yolo) {
		stateManager.setSessionOverride("yoloModeToggled", true)
		telemetryService.captureHostEvent("yolo_flag", "true")
	}

	// Set auto-approve-all as a session-scoped override so CLI flag does not
	// persist user settings to disk.
	if (options.autoApproveAll) {
		stateManager.setSessionOverride("autoApproveAllToggled", true)
		telemetryService.captureHostEvent("auto_approve_all_flag", "true")
	}


	if (options.subagents) {
		stateManager.setSessionOverride("subagentsEnabled", true)
	}

	if (options.autoCondense) {
		stateManager.setSessionOverride("useAutoCondense", true)
	}

	if (options.autoCondenseAt !== undefined) {
		const limit = await normalizeMaxConsecutiveMistakes(options.autoCondenseAt)
		if (!isValidAutoCondenseContextLimit(limit)) {
			throw new Error("Auto-condense context limit must be between 1 and 2,000,000,000 tokens")
		}
		const providerKey = currentMode === "act" ? "actModeApiProvider" : "planModeApiProvider"
		const providerId = stateManager.getGlobalSettingsKey(providerKey)
		stateManager.setSessionOverride("autoCondenseContextLimits", {
			...stateManager.getGlobalSettingsKey("autoCondenseContextLimits"),
			[providerId]: limit!,
		})
	}

	if (options.noEmoji || process.env.DIRAC_NO_EMOJI) {
		const { setIconMode } = await import("./icon-mapping")
		setIconMode("unicode")
	}

	const headersString = options.headers || process.env.CUSTOM_HEADERS
	if (headersString) {
		const { parseHeaders } = await import("./parser")
		const parsedHeaders = parseHeaders(headersString)
		stateManager.setSessionOverride("openAiHeaders", parsedHeaders)
	}
}
