import type * as acp from "@agentclientprotocol/sdk"
import { RequestError } from "@agentclientprotocol/sdk"
import { type ApiConfiguration, type ApiProvider, modelSupportsInferenceSpeed, providerSupportsInferenceSpeed } from "@shared/api"
import { getExplicitDiracSettingsFromEnv, getProviderFromEnv, getSettingsFromEnv } from "@shared/storage/env-config"
import { getProviderModelIdKey, getProviderModelInfoKey } from "@shared/storage/provider-keys"
import {
	INFERENCE_SPEED_OPTIONS,
	isInferenceSpeed,
	isOpenaiReasoningEffort,
	OPENAI_REASONING_EFFORT_OPTIONS,
} from "@shared/storage/types"
import { validateApiConfiguration } from "@/core/api"
import type { Controller } from "@/core/controller"
import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger.js"
import type { Settings } from "@/shared/storage/state-keys"
import {
	copyTaskRuntimeSettings,
	setSessionRuntimeConfig,
	TASK_RUNTIME_SETTINGS_KEYS,
} from "../acp/acp-session-runtime-config.js"
import { isSelectedProviderConfigured } from "../utils/auth.js"
import { getDefaultModelId } from "../utils/model-metadata.js"
import { isValidCliProvider } from "../utils/providers.js"
import type { DiracAcpSession, DiracAgentOptions } from "./public-types.js"
import type { AcpModeId, SessionConfigManager } from "./sessionConfig.js"
import type { AcpSessionState } from "./types.js"

interface SessionRuntimeDeps {
	options: DiracAgentOptions
	sessions: Map<string, DiracAcpSession>
	sessionStates: Map<string, AcpSessionState>
	getTask(session: DiracAcpSession): NonNullable<Controller["task"]> | undefined
	getDataDir(): string
	sessionConfig: SessionConfigManager
	emitSessionUpdate(sessionId: string, update: acp.SessionUpdate): Promise<void>
}

/**
 * Owns per-session task-runtime configuration for ACP sessions: startup
 * overrides, committed/persisted overrides, serialized mutation barriers, and
 * the config-option/mode ACP surfaces that mutate them.
 */
export class SessionRuntimeManager {
	/** Authoritative committed, persisted runtime choices for each ACP session. */
	readonly acpSessionOverrides: Map<string, Partial<Settings>> = new Map()

	/** Session-owned mirror of the configuration currently committed to the active Task. */
	readonly activePromptOverrides: Map<string, Partial<Settings>> = new Map()

	/** Config mutations are serialized independently from prompt lifecycle state. */
	private readonly configuringSessions: Set<string> = new Set()

	/** Per-session barriers ensure runtime snapshots are read and committed in order. */
	private readonly sessionRuntimeMutationTails: Map<string, Promise<void>> = new Map()

	constructor(private readonly deps: SessionRuntimeDeps) {}

	/** Drop all runtime bookkeeping for a released session. */
	releaseSession(sessionId: string): void {
		this.acpSessionOverrides.delete(sessionId)
		this.activePromptOverrides.delete(sessionId)
		this.configuringSessions.delete(sessionId)
		this.sessionRuntimeMutationTails.delete(sessionId)
	}

	isConfiguring(sessionId: string): boolean {
		return this.configuringSessions.has(sessionId)
	}

	applyStartupProviderInfrastructure(): void {
		const { provider, model, mode, thinkingBudgetTokens, reasoningEffort, inferenceSpeed } = this.deps.options

		if (mode && !["plan", "act"].includes(mode)) {
			throw RequestError.invalidParams(undefined, `Invalid startup mode: ${mode}`)
		}
		if (thinkingBudgetTokens !== undefined && (!Number.isFinite(thinkingBudgetTokens) || thinkingBudgetTokens < 0)) {
			throw RequestError.invalidParams(undefined, `Invalid --thinking value: ${thinkingBudgetTokens}`)
		}
		if (reasoningEffort !== undefined && !isOpenaiReasoningEffort(reasoningEffort)) {
			throw RequestError.invalidParams(
				undefined,
				`Invalid --reasoning-effort value: ${reasoningEffort}. Expected one of: ${OPENAI_REASONING_EFFORT_OPTIONS.join(", ")}`,
			)
		}
		if (inferenceSpeed !== undefined && !isInferenceSpeed(inferenceSpeed)) {
			throw RequestError.invalidParams(
				undefined,
				`Invalid --speed value: ${inferenceSpeed}. Expected one of: ${INFERENCE_SPEED_OPTIONS.join(", ")}`,
			)
		}
		if (provider && !model) {
			throw RequestError.invalidParams(undefined, "--provider requires --model to be specified")
		}
		if (provider && !provider.startsWith("http://") && !provider.startsWith("https://") && !isValidCliProvider(provider)) {
			throw RequestError.invalidParams(undefined, `Invalid provider: ${provider}`)
		}

		if (provider?.startsWith("http://") || provider?.startsWith("https://")) {
			StateManager.get().setApiConfiguration({ openAiBaseUrl: provider })
		}
	}

	createStartupSessionOverrides(): Partial<Settings> {
		const {
			provider,
			model,
			mode: startupMode,
			autoApprove,
			yolo,
			thinkingBudgetTokens,
			reasoningEffort,
			inferenceSpeed,
		} = this.deps.options
		const stateManager = StateManager.get()
		const environmentSettings = getSettingsFromEnv()
		const effectiveDefaults: Partial<Settings> = {}

		for (const key of TASK_RUNTIME_SETTINGS_KEYS) {
			const systemDefault = stateManager.getSystemDefaultSettingsKey(key)
			;(effectiveDefaults as Record<keyof Settings, unknown>)[key] = systemDefault ?? environmentSettings[key]
		}
		Object.assign(effectiveDefaults, getExplicitDiracSettingsFromEnv())
		const environmentProvider = getProviderFromEnv()
		if (environmentProvider && isValidCliProvider(environmentProvider)) {
			effectiveDefaults.actModeApiProvider ??= environmentProvider
			effectiveDefaults.planModeApiProvider ??= environmentProvider
		}

		const overrides = copyTaskRuntimeSettings(effectiveDefaults)
		overrides.mode ??= "act"
		overrides.autoApproveAllToggled ??= false
		overrides.yoloModeToggled ??= false
		overrides.planActSeparateModelsSetting ??= false

		if (startupMode) overrides.mode = startupMode
		if (autoApprove !== undefined) overrides.autoApproveAllToggled = autoApprove
		if (yolo !== undefined) overrides.yoloModeToggled = yolo

		for (const mode of ["plan", "act"] as const) {
			const providerKey = mode === "act" ? "actModeApiProvider" : "planModeApiProvider"
			const defaultProvider = overrides[providerKey] as ApiProvider | undefined
			if (!defaultProvider) throw new Error(`No default API provider is configured for ${mode} mode`)

			const modelKey = getProviderModelIdKey(defaultProvider, mode)
			if (defaultProvider === "openai") {
				const profileNameKey = mode === "act" ? "actModeOpenAiProfileName" : "planModeOpenAiProfileName"
				const profileName = overrides[profileNameKey]
				const profiles =
					stateManager.getSystemDefaultSettingsKey("openAiCompatibleProfiles") ??
					environmentSettings.openAiCompatibleProfiles
				const profile = profileName ? profiles?.find((candidate) => candidate.name === profileName) : undefined
				if (profile) {
					const runtimeValues = overrides as Record<string, unknown>
					runtimeValues[modelKey] ||= profile.modelId
					const modelInfoKey = getProviderModelInfoKey(defaultProvider, mode)!
					runtimeValues[modelInfoKey] ||= structuredClone(profile.modelInfo)
				}
			}
			;(overrides as Record<string, unknown>)[modelKey] =
				(overrides[modelKey] as string | undefined) || getDefaultModelId(defaultProvider)

			const thinkingKey = mode === "act" ? "actModeThinkingBudgetTokens" : "planModeThinkingBudgetTokens"
			const reasoningKey = mode === "act" ? "actModeReasoningEffort" : "planModeReasoningEffort"
			const inferenceSpeedKey = mode === "act" ? "actModeInferenceSpeed" : "planModeInferenceSpeed"
			;(overrides as Record<string, unknown>)[thinkingKey] ??= 0
			;(overrides as Record<string, unknown>)[reasoningKey] ??= "medium"
			;(overrides as Record<string, unknown>)[inferenceSpeedKey] ??= "default"
		}

		if (model) {
			let targetProvider: ApiProvider | undefined
			if (provider?.startsWith("http://") || provider?.startsWith("https://")) {
				targetProvider = "openai"
			} else if (provider) {
				if (!isValidCliProvider(provider)) throw new Error(`Invalid provider: ${provider}`)
				targetProvider = provider as ApiProvider
			} else {
				const currentMode = overrides.mode
				targetProvider = overrides[currentMode === "act" ? "actModeApiProvider" : "planModeApiProvider"] as
					| ApiProvider
					| undefined
			}
			if (!targetProvider) throw new Error("--model requires a configured provider or an explicit --provider")

			const modes = overrides.planActSeparateModelsSetting ? [overrides.mode] : (["plan", "act"] as const)
			for (const mode of modes) {
				;(overrides as Record<string, unknown>)[mode === "act" ? "actModeApiProvider" : "planModeApiProvider"] =
					targetProvider
				;(overrides as Record<string, unknown>)[getProviderModelIdKey(targetProvider, mode)] = model
				const modelInfoKey = getProviderModelInfoKey(targetProvider, mode)
				if (modelInfoKey) overrides[modelInfoKey] = undefined
				if (provider?.startsWith("http://") || provider?.startsWith("https://")) {
					overrides[mode === "act" ? "actModeOpenAiProfileName" : "planModeOpenAiProfileName"] = undefined
				}
			}
		}

		if (thinkingBudgetTokens !== undefined) {
			const modes = overrides.planActSeparateModelsSetting ? [overrides.mode] : (["plan", "act"] as const)
			for (const mode of modes) {
				overrides[mode === "act" ? "actModeThinkingBudgetTokens" : "planModeThinkingBudgetTokens"] = thinkingBudgetTokens
			}
		}
		if (reasoningEffort !== undefined) {
			const modes = overrides.planActSeparateModelsSetting ? [overrides.mode] : (["plan", "act"] as const)
			for (const mode of modes) {
				overrides[mode === "act" ? "actModeReasoningEffort" : "planModeReasoningEffort"] = reasoningEffort
			}
		}
		if (inferenceSpeed !== undefined) {
			const modes = overrides.planActSeparateModelsSetting ? [overrides.mode] : (["plan", "act"] as const)
			for (const mode of modes) {
				const provider = overrides[mode === "act" ? "actModeApiProvider" : "planModeApiProvider"] as ApiProvider
				const modelId = overrides[getProviderModelIdKey(provider, mode)] as string
				if (inferenceSpeed === "standard" && !providerSupportsInferenceSpeed(provider)) {
					throw new Error(`Provider ${provider} does not support inference speed controls`)
				}
				if (inferenceSpeed === "fast" && !modelSupportsInferenceSpeed(provider, modelId)) {
					throw new Error(`Model ${modelId} does not support Fast mode`)
				}
				overrides[mode === "act" ? "actModeInferenceSpeed" : "planModeInferenceSpeed"] = inferenceSpeed
			}
		}
		return overrides
	}

	isStartupProviderConfigured(overrides: Partial<Settings>): boolean {
		const mode = overrides.mode === "plan" ? "plan" : "act"
		const configuration = StateManager.get().captureEffectiveTaskConfiguration(overrides).apiConfiguration
		return isSelectedProviderConfigured(configuration as ApiConfiguration, mode)
	}

	initializeSessionOverrides(sessionId: string, persisted?: Partial<Settings>): Partial<Settings> {
		const overrides = copyTaskRuntimeSettings(persisted ?? this.createStartupSessionOverrides())
		this.acpSessionOverrides.set(sessionId, overrides)
		return overrides
	}

	persistSessionOverrides(sessionId: string): void {
		const overrides = this.acpSessionOverrides.get(sessionId)
		if (!overrides) throw new Error(`Session runtime configuration not found: ${sessionId}`)
		const session = this.deps.sessions.get(sessionId)
		if (!session) throw new Error(`Session not found: ${sessionId}`)
		this.writeSessionRuntimeConfig(session, overrides)
	}

	writeSessionRuntimeConfig(session: DiracAcpSession, overrides: Partial<Settings>): void {
		setSessionRuntimeConfig(this.deps.getDataDir(), session.sessionId, {
			settings: overrides,
			cwd: session.cwd,
			createdAt: session.createdAt,
		})
	}

	async runSessionRuntimeMutation<T>(sessionId: string, mutation: () => Promise<T>): Promise<T> {
		if (!this.deps.sessionStates.has(sessionId)) throw new Error(`Session not found: ${sessionId}`)

		const previousMutation = this.sessionRuntimeMutationTails.get(sessionId) ?? Promise.resolve()
		let releaseMutation!: () => void
		const mutationBarrier = new Promise<void>((resolve) => {
			releaseMutation = resolve
		})
		const mutationTail = previousMutation.then(() => mutationBarrier)
		this.sessionRuntimeMutationTails.set(sessionId, mutationTail)
		this.configuringSessions.add(sessionId)

		await previousMutation
		try {
			if (!this.deps.sessionStates.has(sessionId)) throw new Error(`Session not found: ${sessionId}`)
			return await mutation()
		} finally {
			releaseMutation()
			if (this.sessionRuntimeMutationTails.get(sessionId) === mutationTail) {
				this.sessionRuntimeMutationTails.delete(sessionId)
				this.configuringSessions.delete(sessionId)
			}
		}
	}

	resolveSessionTaskRuntime(overrides: Partial<Settings>, mode: "act" | "plan", task?: NonNullable<Controller["task"]>) {
		if (task) {
			// Existing tasks retain their captured credentials and unrelated defaults.
			// Task synchronizes API-handler setting keys from this exact session patch.
			return { settings: overrides }
		}

		const captured = StateManager.get().captureEffectiveTaskConfiguration(overrides)
		validateApiConfiguration(captured.apiConfiguration as ApiConfiguration, mode)
		return {
			settings: overrides,
			apiConfiguration: captured.apiConfiguration as ApiConfiguration,
		}
	}

	async refreshSessionProviderRuntime(session: DiracAcpSession): Promise<void> {
		const task = this.deps.getTask(session)
		if (!task) return
		const overrides = this.acpSessionOverrides.get(session.sessionId)
		if (!overrides) throw new Error(`Session runtime configuration not found: ${session.sessionId}`)
		const mode = overrides.mode
		if (mode !== "plan" && mode !== "act") throw new Error(`Invalid session mode: ${mode}`)
		const captured = StateManager.get().captureEffectiveTaskConfiguration(overrides)
		validateApiConfiguration(captured.apiConfiguration as ApiConfiguration, mode)
		await task.applyWorkingConfigurationUpdate({
			apiConfiguration: captured.apiConfiguration as ApiConfiguration,
		})
	}

	async commitClientSessionRuntime(session: DiracAcpSession, nextOverrides: Partial<Settings>): Promise<void> {
		const nextMode = nextOverrides.mode
		if (nextMode !== "plan" && nextMode !== "act") throw new Error(`Invalid session mode: ${nextMode}`)

		if (!this.activePromptOverrides.has(session.sessionId)) {
			await this.replaceSessionRuntimeConfig(session, nextOverrides, nextMode)
			return
		}

		await this.applyActivePromptRuntime(session, nextOverrides, nextMode, () =>
			this.writeSessionRuntimeConfig(session, nextOverrides),
		)
		this.acpSessionOverrides.set(session.sessionId, nextOverrides)
	}

	async refreshTaskRuntime(session: DiracAcpSession, overrides: Partial<Settings>): Promise<void> {
		const task = this.deps.getTask(session)
		if (!task) return
		const mode = overrides.mode
		if (mode !== "plan" && mode !== "act") throw new Error(`Invalid session mode: ${mode}`)
		await task.applyWorkingConfigurationUpdate(this.resolveSessionTaskRuntime(overrides, mode, task))
	}

	async getNormalizedConfigOptions(session: DiracAcpSession): Promise<acp.SessionConfigOption[]> {
		const currentOverrides = this.acpSessionOverrides.get(session.sessionId)
		if (!currentOverrides) throw new Error(`Session runtime configuration not found: ${session.sessionId}`)
		const nextOverrides = copyTaskRuntimeSettings(currentOverrides)
		const configOptions = await this.deps.sessionConfig.getSessionConfigOptions(session, nextOverrides)
		await this.commitClientSessionRuntime(session, nextOverrides)
		return configOptions
	}

	async emitConfigOptionsUpdate(sessionId: string, refreshProviderRuntime = false): Promise<void> {
		if (!this.deps.sessionStates.has(sessionId)) return
		await this.runSessionRuntimeMutation(sessionId, async () => {
			const session = this.deps.sessions.get(sessionId)
			if (!session) throw new Error(`Session not found: ${sessionId}`)
			const configOptions = await this.getNormalizedConfigOptions(session)
			if (refreshProviderRuntime) await this.refreshSessionProviderRuntime(session)
			await this.deps.emitSessionUpdate(sessionId, { sessionUpdate: "config_option_update", configOptions })
		})
	}

	async emitCurrentModeUpdate(sessionId: string): Promise<void> {
		const session = this.deps.sessions.get(sessionId)
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`)
		}
		const sessionOverrides = this.acpSessionOverrides.get(sessionId)
		if (!sessionOverrides) throw new Error(`Session runtime configuration not found: ${sessionId}`)

		await this.deps.emitSessionUpdate(sessionId, {
			sessionUpdate: "current_mode_update",
			currentModeId: this.deps.sessionConfig.computeCurrentAcpModeId(session.mode, sessionOverrides),
		})
	}

	async applySessionMode(sessionId: string, modeId: string): Promise<acp.SessionConfigOption[]> {
		const session = this.deps.sessions.get(sessionId)
		if (!session) throw new Error(`Session not found: ${sessionId}`)
		const validModes: AcpModeId[] = ["plan", "act"]
		if (!validModes.includes(modeId as AcpModeId)) {
			throw new Error(`Invalid mode: ${modeId}. Valid modes are: ${validModes.join(", ")}`)
		}

		return this.runSessionRuntimeMutation(sessionId, async () => {
			const currentOverrides = this.acpSessionOverrides.get(sessionId)
			if (!currentOverrides) throw new Error(`Session runtime configuration not found: ${sessionId}`)
			const nextOverrides = copyTaskRuntimeSettings(currentOverrides)
			nextOverrides.mode = modeId as AcpModeId

			const configOptions = await this.deps.sessionConfig.getSessionConfigOptions(session, nextOverrides)
			await this.commitClientSessionRuntime(session, nextOverrides)
			session.lastActivityAt = Date.now()
			await this.emitCurrentModeUpdate(sessionId)
			await this.deps.emitSessionUpdate(sessionId, { sessionUpdate: "config_option_update", configOptions })
			return configOptions
		})
	}

	async switchSessionToActMode(sessionId: string): Promise<boolean> {
		return this.runSessionRuntimeMutation(sessionId, async () => {
			const session = this.deps.sessions.get(sessionId)
			if (!session) throw new Error(`Session not found: ${sessionId}`)
			const currentOverrides = this.acpSessionOverrides.get(sessionId)
			if (!currentOverrides) throw new Error(`Session runtime configuration not found: ${sessionId}`)
			const activeOverrides = this.activePromptOverrides.get(sessionId)
			if ((activeOverrides?.mode ?? session.mode) === "act") {
				return this.deps.getTask(session) !== undefined
			}

			const nextOverrides = copyTaskRuntimeSettings(currentOverrides)
			nextOverrides.mode = "act"
			const configOptions = await this.deps.sessionConfig.getSessionConfigOptions(session, nextOverrides)
			await this.commitClientSessionRuntime(session, nextOverrides)

			session.lastActivityAt = Date.now()
			await this.emitCurrentModeUpdate(sessionId)
			await this.deps.emitSessionUpdate(sessionId, { sessionUpdate: "config_option_update", configOptions })
			return this.deps.getTask(session) !== undefined
		})
	}

	async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
		const session = this.deps.sessions.get(params.sessionId)
		if (!session) throw new Error(`Session not found: ${params.sessionId}`)

		Logger.debug("[DiracAgent] setSessionConfigOption called:", {
			sessionId: params.sessionId,
			configId: params.configId,
			value: params.value,
		})

		if (params.configId === "mode") {
			if (typeof params.value !== "string") throw new Error("Mode must be a select value")
			return { configOptions: await this.applySessionMode(params.sessionId, params.value) }
		}

		return this.runSessionRuntimeMutation(params.sessionId, async () => {
			const currentOverrides = this.acpSessionOverrides.get(params.sessionId)
			if (!currentOverrides) throw new Error(`Session runtime configuration not found: ${params.sessionId}`)
			const nextOverrides = copyTaskRuntimeSettings(currentOverrides)
			let configOptions: acp.SessionConfigOption[] | undefined

			switch (params.configId) {
				case "auto_approve":
					if (typeof params.value !== "boolean") throw new Error("Auto-approve must be a boolean value")
					nextOverrides.autoApproveAllToggled = params.value
					break
				case "yolo":
					if (typeof params.value !== "boolean") throw new Error("YOLO must be a boolean value")
					nextOverrides.yoloModeToggled = params.value
					break
				case "provider":
					if (typeof params.value !== "string") throw new Error("Provider must be a select value")
					configOptions = await this.deps.sessionConfig.applyProviderConfigOption(session, params.value, nextOverrides)
					break
				case "model":
					if (typeof params.value !== "string") throw new Error("Model must be a select value")
					configOptions = await this.deps.sessionConfig.applyModelConfigOption(session, params.value, nextOverrides)
					break
				case "reasoning_effort":
					if (typeof params.value !== "string") throw new Error("Reasoning effort must be a select value")
					this.deps.sessionConfig.applyReasoningEffortConfigOption(session, params.value, nextOverrides)
					break
				case "inference_speed":
					if (typeof params.value !== "string") throw new Error("Inference speed must be a select value")
					this.deps.sessionConfig.applyInferenceSpeedConfigOption(session, params.value, nextOverrides)
					break
				case "thinking_budget":
					if (typeof params.value !== "string") throw new Error("Thinking budget must be a select value")
					this.deps.sessionConfig.applyThinkingBudgetConfigOption(session, params.value, nextOverrides)
					break
				default:
					throw new Error(`Unknown session config option: ${params.configId}`)
			}

			configOptions ??= await this.deps.sessionConfig.getSessionConfigOptions(session, nextOverrides)
			await this.commitClientSessionRuntime(session, nextOverrides)
			session.lastActivityAt = Date.now()
			await this.deps.emitSessionUpdate(params.sessionId, { sessionUpdate: "config_option_update", configOptions })
			return { configOptions }
		})
	}

	private async applyActivePromptRuntime(
		session: DiracAcpSession,
		nextOverrides: Partial<Settings>,
		nextMode: "act" | "plan",
		beforeCommit: () => void | Promise<void>,
	): Promise<void> {
		const task = this.deps.getTask(session)
		const runtime = this.resolveSessionTaskRuntime(nextOverrides, nextMode, task)
		if (task) await task.applyWorkingConfigurationUpdate(runtime, beforeCommit)
		else await beforeCommit()
		this.activePromptOverrides.set(session.sessionId, nextOverrides)
		session.mode = nextMode
	}

	private async replaceSessionRuntimeConfig(
		session: DiracAcpSession,
		nextOverrides: Partial<Settings>,
		nextMode: "act" | "plan",
	): Promise<void> {
		if (!this.acpSessionOverrides.has(session.sessionId)) {
			throw new Error(`Session runtime configuration not found: ${session.sessionId}`)
		}

		const task = this.deps.getTask(session)
		const runtime = this.resolveSessionTaskRuntime(nextOverrides, nextMode, task)
		const persist = () => this.writeSessionRuntimeConfig(session, nextOverrides)

		if (task) await task.applyWorkingConfigurationUpdate(runtime, persist)
		else persist()

		this.acpSessionOverrides.set(session.sessionId, nextOverrides)
		session.mode = nextMode
	}
}
