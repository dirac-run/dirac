import fs from "node:fs"
import path from "node:path"
import { ApiHandlerSettingsKeys, type Settings, type SettingsKey } from "@shared/storage/state-keys"
import { buildLegacyModelIdStateUpdates } from "@shared/storage/legacy-model-id-migration"
import { normalizeInferenceSpeed } from "@shared/storage/types"
import { ApiConfigurationError, ApiConfigurationErrorCode } from "@core/api"

const LEGACY_RUNTIME_CONFIG_FILE = "acp-session-runtime-config.json"
const RUNTIME_CONFIG_DIRECTORY = "acp-session-runtime-configs"

const GLOBAL_MODEL_RUNTIME_KEYS = [
	"liteLlmUsePromptCache",
	"openRouterProviderSorting",
	"awsBedrockUsePromptCache",
	"lmStudioMaxTokens",
	"requestTimeoutMs",
	"geminiSearchEnabled",
	"fireworksModelMaxCompletionTokens",
	"fireworksModelMaxTokens",
	"enableParallelToolCalling",
] as const satisfies readonly SettingsKey[]

const SESSION_MODE_RUNTIME_KEYS = [
	"mode",
	"autoApproveAllToggled",
	"yoloModeToggled",
	"lowVerbosityEnabled",
	"planActSeparateModelsSetting",
] as const satisfies readonly SettingsKey[]

function isModeScopedApiHandlerKey(key: SettingsKey): boolean {
	return (
		key.startsWith("planMode") ||
		key.startsWith("actMode") ||
		key.startsWith("geminiPlanMode") ||
		key.startsWith("geminiActMode")
	)
}

/**
 * Settings whose values belong to an ACP task rather than provider infrastructure.
 *
 * Mode-scoped API settings contain provider/model selection and model controls.
 * The explicit global keys affect model requests without containing credentials,
 * endpoints, headers, authentication, or provider protocol configuration.
 */
export const TASK_RUNTIME_SETTINGS_KEYS = [
	...ApiHandlerSettingsKeys.filter(isModeScopedApiHandlerKey),
	...GLOBAL_MODEL_RUNTIME_KEYS,
	...SESSION_MODE_RUNTIME_KEYS,
] as const satisfies readonly SettingsKey[]

export type SessionRuntimeConfig = {
	settings: Partial<Settings>
	cwd?: string
	createdAt?: number
	/** Backing task ID, absent only before the first prompt or in legacy records. */
	taskId?: string
}

type PersistedSessionRuntimeConfigV1 = {
	version: 1
	settings: Partial<Settings>
	cwd?: string
	createdAt?: number
	taskId?: string
}

type PersistedSessionRuntimeConfigMap = Record<string, PersistedSessionRuntimeConfigV1>

function legacyRuntimeConfigPath(dataDir: string): string {
	return path.join(dataDir, LEGACY_RUNTIME_CONFIG_FILE)
}

function sessionRuntimeConfigPath(dataDir: string, sessionId: string): string {
	return path.join(dataDir, RUNTIME_CONFIG_DIRECTORY, `${encodeURIComponent(sessionId)}.json`)
}

function readLegacyRuntimeConfig(dataDir: string, sessionId: string): PersistedSessionRuntimeConfigV1 | undefined {
	const filePath = legacyRuntimeConfigPath(dataDir)
	if (!fs.existsSync(filePath)) return undefined
	const configs = JSON.parse(fs.readFileSync(filePath, "utf8")) as PersistedSessionRuntimeConfigMap
	return configs[sessionId]
}

function readPersistedRuntimeConfig(dataDir: string, sessionId: string): PersistedSessionRuntimeConfigV1 | undefined {
	const filePath = sessionRuntimeConfigPath(dataDir, sessionId)
	try {
		if (!fs.existsSync(filePath)) return readLegacyRuntimeConfig(dataDir, sessionId)
		return (JSON.parse(fs.readFileSync(filePath, "utf8")) as PersistedSessionRuntimeConfigV1 | null) ?? undefined
	} catch (error) {
		throw new ApiConfigurationError(
			ApiConfigurationErrorCode.SessionRuntimeMalformed,
			`ACP session runtime configuration is malformed: ${sessionId}`,
			"Start a new session or repair/remove the corrupted runtime record before retrying.",
			{ cause: error },
		)
	}
}

function writePersistedRuntimeConfig(dataDir: string, sessionId: string, config: PersistedSessionRuntimeConfigV1 | null): void {
	const filePath = sessionRuntimeConfigPath(dataDir, sessionId)
	fs.mkdirSync(path.dirname(filePath), { recursive: true })
	const temporaryPath = `${filePath}.${process.pid}.tmp`
	fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2))
	fs.renameSync(temporaryPath, filePath)
}

export function copyTaskRuntimeSettings(settings: Partial<Settings>): Partial<Settings> {
	const legacyUpdates = buildLegacyModelIdStateUpdates(settings)
	const normalizedSettings: Partial<Settings> = { ...settings, ...legacyUpdates }
	normalizedSettings.planModeInferenceSpeed = normalizeInferenceSpeed(normalizedSettings.planModeInferenceSpeed)
	normalizedSettings.actModeInferenceSpeed = normalizeInferenceSpeed(normalizedSettings.actModeInferenceSpeed)

	const copy: Partial<Settings> = {}
	for (const key of TASK_RUNTIME_SETTINGS_KEYS) {
		const value = normalizedSettings[key]
			; (copy as Record<SettingsKey, unknown>)[key] = value === undefined ? undefined : structuredClone(value)
	}
	return copy
}

export function getSessionRuntimeConfig(dataDir: string, sessionId: string): SessionRuntimeConfig | undefined {
	const persisted = readPersistedRuntimeConfig(dataDir, sessionId)
	if (!persisted) return undefined
	if (persisted.version !== 1) {
		throw new ApiConfigurationError(
			ApiConfigurationErrorCode.SessionRuntimeVersionUnsupported,
			`Unsupported ACP session runtime configuration version: ${persisted.version}`,
			"Upgrade Dirac or start a new session before retrying.",
		)
	}
	if (!persisted.settings || typeof persisted.settings !== "object" || Array.isArray(persisted.settings)) {
		throw new ApiConfigurationError(
			ApiConfigurationErrorCode.SessionRuntimeMalformed,
			`ACP session runtime configuration has invalid settings: ${sessionId}`,
			"Start a new session or repair/remove the corrupted runtime record before retrying.",
		)
	}
	return {
		settings: copyTaskRuntimeSettings(persisted.settings),
		cwd: persisted.cwd,
		createdAt: persisted.createdAt,
		taskId: persisted.taskId,
	}
}

export function setSessionRuntimeConfig(dataDir: string, sessionId: string, runtimeConfig: SessionRuntimeConfig): void {
	writePersistedRuntimeConfig(dataDir, sessionId, {
		version: 1,
		settings: copyTaskRuntimeSettings(runtimeConfig.settings),
		cwd: runtimeConfig.cwd,
		createdAt: runtimeConfig.createdAt,
		taskId: runtimeConfig.taskId,
	})
}

export function deleteSessionRuntimeConfig(dataDir: string, sessionId: string): void {
	writePersistedRuntimeConfig(dataDir, sessionId, null)
}
