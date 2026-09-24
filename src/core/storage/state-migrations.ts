import fs from "fs/promises"
import path from "path"
import { HistoryItem } from "@/shared/HistoryItem"
import { Logger } from "@/shared/services/Logger"
import { ensureRulesDirectoryExists, readTaskHistoryFromState } from "./disk"
import { commitTaskHistoryMutations } from "./taskHistory"

/** Minimal state surface migrations need — satisfied by vscode.Memento and DiracMemento. */
interface MigrationStateStore {
	get<T>(key: string): T | undefined
	update(key: string, value: unknown): PromiseLike<void>
}

/** Minimal secret surface migrations need — satisfied by vscode.SecretStorage and DiracFileStorage<string>. */
interface MigrationSecrets {
	get(key: string): PromiseLike<string | undefined>
	delete(key: string): PromiseLike<void>
}

/**
 * Host-agnostic replacement for the slices of vscode.ExtensionContext these
 * migrations use. The VS Code extension passes its real context; other hosts
 * pass their file-backed equivalents.
 */
export interface StateMigrationContext {
	globalState: MigrationStateStore
	workspaceState: MigrationStateStore
	secrets: MigrationSecrets
}

export async function migrateWorkspaceToGlobalStorage(context: StateMigrationContext) {
	// Keys to migrate from workspace storage back to global storage
	const keysToMigrate = [
		// Core settings
		"apiProvider",
		"apiModelId",
		"thinkingBudgetTokens",
		"reasoningEffort",
		"vsCodeLmModelSelector",

		// Provider-specific model keys
		"awsBedrockCustomSelected",
		"awsBedrockCustomModelBaseId",
		"openRouterModelId",
		"openRouterModelInfo",
		"openAiModelId",
		"openAiModelInfo",
		"lmStudioModelId",
		"liteLlmModelId",
		"liteLlmModelInfo",
		"requestyModelId",
		"requestyModelInfo",
		"togetherModelId",
		"fireworksModelId",
		"groqModelId",
		"groqModelInfo",
		"huggingFaceModelId",
		"huggingFaceModelInfo",

		// Previous mode settings
		"previousModeApiProvider",
		"previousModeModelId",
		"previousModeModelInfo",
		"previousModeVsCodeLmModelSelector",
		"previousModeThinkingBudgetTokens",
		"previousModeReasoningEffort",
		"previousModeAwsBedrockCustomSelected",
		"previousModeAwsBedrockCustomModelBaseId",
	]

	for (const key of keysToMigrate) {
		// Use raw workspace state since these keys shouldn't be in workspace storage
		const workspaceValue = await context.workspaceState.get(key)
		const globalValue = await context.globalState.get(key)

		if (workspaceValue !== undefined && globalValue === undefined) {
			Logger.log(`[Storage Migration] migrating key: ${key} to global storage. Current value: ${workspaceValue}`)

			// Move to global storage using raw VSCode method to avoid type errors
			await context.globalState.update(key, workspaceValue)
			// Remove from workspace storage
			await context.workspaceState.update(key, undefined)
			const newWorkspaceValue = await context.workspaceState.get(key)

			Logger.log(`[Storage Migration] migrated key: ${key} to global storage. Current value: ${newWorkspaceValue}`)
		}
	}
}

export async function migrateTaskHistoryToFile(context: StateMigrationContext) {
	try {
		// Get data from old location
		const vscodeGlobalStateTaskHistory = context.globalState.get<HistoryItem[] | undefined>("taskHistory")

		// Normalize old location data to array (empty array if undefined/null/not-array)
		const oldLocationData = Array.isArray(vscodeGlobalStateTaskHistory) ? vscodeGlobalStateTaskHistory : []

		// Early return if no migration needed
		if (oldLocationData.length === 0) {
			Logger.log("[Storage Migration] No task history to migrate")
			return
		}

		const newLocationData = await readTaskHistoryFromState()
		const migrationAction =
			newLocationData.length === 0
				? "Migrated task history from old location to new location"
				: "Merged task history from old and new locations"
		const successfullyWrittenData = await commitTaskHistoryMutations([
			{ kind: "insertMissing", items: oldLocationData },
		])
		const writtenIds = new Set(successfullyWrittenData.map((item) => item.id))
		if (oldLocationData.some((item) => !writtenIds.has(item.id))) {
			Logger.error(
				"[Storage Migration] Failed to write taskHistory to file: Not every legacy run was committed",
			)
			return
		}

		await context.globalState.update("taskHistory", undefined)

		Logger.log(`[Storage Migration] ${migrationAction}`)
	} catch (error) {
		Logger.error("[Storage Migration] Failed to migrate task history to file:", error)
	}
}

export async function migrateCustomInstructionsToGlobalRules(context: StateMigrationContext) {
	try {
		const customInstructions = (await context.globalState.get("customInstructions")) as string | undefined

		if (customInstructions?.trim()) {
			Logger.log("Migrating custom instructions to global Dirac rules...")

			// Create global .diracrules directory if it doesn't exist
			const globalRulesDir = await ensureRulesDirectoryExists()

			// Use a fixed filename for custom instructions
			const migrationFileName = "custom_instructions.md"
			const migrationFilePath = path.join(globalRulesDir, migrationFileName)

			try {
				// Check if file already exists to determine if we should append
				let existingContent = ""
				try {
					existingContent = await fs.readFile(migrationFilePath, "utf8")
				} catch (_readError) {
					// File doesn't exist, which is fine
				}

				// Append or create the file with custom instructions
				const contentToWrite = existingContent
					? `${existingContent}\n\n---\n\n${customInstructions.trim()}`
					: customInstructions.trim()

				await fs.writeFile(migrationFilePath, contentToWrite)
				Logger.log(`Successfully ${existingContent ? "appended to" : "created"} migration file: ${migrationFilePath}`)
			} catch (fileError) {
				Logger.error("Failed to write migration file:", fileError)
				return
			}

			// Remove customInstructions from global state only after successful file creation
			await context.globalState.update("customInstructions", undefined)
			Logger.log("Successfully migrated custom instructions to global Dirac rules")
		}
	} catch (error) {
		Logger.error("Failed to migrate custom instructions to global rules:", error)
		// Continue execution - migration failure shouldn't break extension startup
	}
}

export async function migrateWelcomeViewCompleted(context: StateMigrationContext) {
	try {
		// Check if welcomeViewCompleted is already set
		const welcomeViewCompleted = context.globalState.get("welcomeViewCompleted")

		if (welcomeViewCompleted === undefined) {
			Logger.log("Migrating welcomeViewCompleted setting...")

			// Fetch API keys directly from secrets
			const apiKey = await context.secrets.get("apiKey")
			const openRouterApiKey = await context.secrets.get("openRouterApiKey")
			const diracAccountId = await context.secrets.get("diracAccountId")
			const openAiApiKey = await context.secrets.get("openAiApiKey")
			const liteLlmApiKey = await context.secrets.get("liteLlmApiKey")
			const geminiApiKey = await context.secrets.get("geminiApiKey")
			const openAiNativeApiKey = await context.secrets.get("openAiNativeApiKey")
			const deepSeekApiKey = await context.secrets.get("deepSeekApiKey")
			const requestyApiKey = await context.secrets.get("requestyApiKey")
			const togetherApiKey = await context.secrets.get("togetherApiKey")
			const qwenApiKey = await context.secrets.get("qwenApiKey")
			const doubaoApiKey = await context.secrets.get("doubaoApiKey")
			const mistralApiKey = await context.secrets.get("mistralApiKey")
			const xaiApiKey = await context.secrets.get("xaiApiKey")
			const sambanovaApiKey = await context.secrets.get("sambanovaApiKey")
			const difyApiKey = await context.secrets.get("difyApiKey")
			// OpenAI Codex OAuth credentials
			const openAiCodexCredentials = await context.secrets.get("openai-codex-oauth-credentials")

			// Fetch configuration values from global state
			const awsRegion = context.globalState.get("awsRegion")
			const vertexProjectId = context.globalState.get("vertexProjectId")
			const planModeLmStudioModelId = context.globalState.get("planModeLmStudioModelId")
			const actModeLmStudioModelId = context.globalState.get("actModeLmStudioModelId")
			const planModeVsCodeLmModelSelector = context.globalState.get("planModeVsCodeLmModelSelector")
			const actModeVsCodeLmModelSelector = context.globalState.get("actModeVsCodeLmModelSelector")

			// This is the original logic used for checking if the welcome view should be shown
			// It was located in the ExtensionStateContextProvider
			const hasKey = [
				apiKey,
				openRouterApiKey,
				awsRegion,
				vertexProjectId,
				openAiApiKey,
				planModeLmStudioModelId,
				actModeLmStudioModelId,
				liteLlmApiKey,
				geminiApiKey,
				openAiNativeApiKey,
				deepSeekApiKey,
				requestyApiKey,
				togetherApiKey,
				qwenApiKey,
				doubaoApiKey,
				mistralApiKey,
				planModeVsCodeLmModelSelector,
				actModeVsCodeLmModelSelector,
				diracAccountId,
				xaiApiKey,
				sambanovaApiKey,
				difyApiKey,
				openAiCodexCredentials,
			].some((key) => key !== undefined)

			// Set welcomeViewCompleted based on whether user has keys
			await context.globalState.update("welcomeViewCompleted", hasKey)

			Logger.log(`Migration: Set welcomeViewCompleted to ${hasKey} based on existing API keys`)
		}
	} catch (error) {
		Logger.error("Failed to migrate welcomeViewCompleted:", error)
		// Continue execution - migration failure shouldn't break extension startup
	}
}

export async function cleanupOldApiKey(context: StateMigrationContext) {
	try {
		// Old API Keys were introduced in March 2025 and later replaced with tokens
		// Now that we have new API keys that are prefixed with `sk_`,
		// we need to clean up the old ones to free the secret storage
		await context.secrets.delete("diracApiKey")
	} catch (error) {
		Logger.error("Failed to cleanup old diracApiKey", error)
	}
}
