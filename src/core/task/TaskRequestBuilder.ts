import { ApiHandler, ApiProviderInfo } from "@core/api"
import { ContextManager } from "@core/context/context-management/ContextManager"
import {
	getGlobalDiracRules,
	getLocalDiracRules,
	refreshDiracRulesToggles,
} from "@core/context/instructions/user-instructions/dirac-rules"
import {
	getLocalAgentsRules,
	getLocalCursorRules,
	getLocalWindsurfRules,
	refreshExternalRulesToggles,
} from "@core/context/instructions/user-instructions/external-rules"
import { formatResponse } from "@core/formatResponse"
import { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import { getSystemPrompt } from "@core/prompts/system-prompt"
import { ensureRulesDirectoryExists, ensureTaskDirectoryExists } from "@core/storage/disk"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { HostProvider } from "@hosts/host-provider"
import { featureFlagsService } from "@services/feature-flags"
import { DiracClient } from "@shared/dirac"
import { DEFAULT_LANGUAGE_SETTINGS, getLanguageKey, LanguageDisplay } from "@shared/Languages"
import * as path from "path"
import { getAvailableCores } from "@/utils/os"
import { detectBestShell } from "@/utils/shell-detection"
import { RuleContextBuilder } from "../context/instructions/user-instructions/RuleContextBuilder"
import { getOrDiscoverSkills } from "../context/instructions/user-instructions/skills"
import { StateManager } from "../storage/StateManager"
import { MessageStateHandler } from "./message-state"
import { TaskState } from "./TaskState"
import { ToolExecutor } from "./ToolExecutor"

// Builds the system prompt, tool snapshot, and context management metadata for an API request.
// Extracted from Task to reduce the 1956-line class.
export class TaskRequestBuilder {
	constructor(
		private stateManager: StateManager,
		private cwd: string,
		private taskState: TaskState,
		private messageStateHandler: MessageStateHandler,
		private api: ApiHandler,
		private contextManager: ContextManager,
		private workspaceManager: WorkspaceRootManager | undefined,
		private diracIgnoreController: DiracIgnoreController,
		private toolExecutor: ToolExecutor,
		private getCurrentProviderInfo: () => ApiProviderInfo,
		private writePromptMetadataArtifacts: (params: {
			systemPrompt: string
			providerInfo: ApiProviderInfo
			tools: any[]
			fullHistory: any[]
			deletedRange: any
		}) => Promise<void>,
		private taskId: string,
		private isParallelToolCallingEnabled: () => boolean,
		private upsertText: (text: string) => Promise<void>,
	) {}

	async buildApiRequestParams(params: { previousApiReqIndex: number; shouldCompact?: boolean }) {
		const providerInfo = this.getCurrentProviderInfo()
		const host = await HostProvider.env.getHostVersion({})
		const ide = host?.platform || "Unknown"
		const isCliEnvironment = host.diracType === DiracClient.Cli
		const browserSettings = this.stateManager.getGlobalSettingsKey("browserSettings")
		const disableBrowserTool = browserSettings.disableToolUse ?? false
		const modelSupportsBrowserUse = providerInfo.model.info.supportsImages ?? false
		const supportsBrowserUse = modelSupportsBrowserUse && !disableBrowserTool
		const preferredLanguageRaw = this.stateManager.getGlobalSettingsKey("preferredLanguage")
		const preferredLanguage = getLanguageKey(preferredLanguageRaw as LanguageDisplay)
		const preferredLanguageInstructions =
			preferredLanguage && preferredLanguage !== DEFAULT_LANGUAGE_SETTINGS
				? `# Preferred Language\n\nSpeak in ${preferredLanguage}.`
				: ""

		const { globalToggles, localToggles } = await refreshDiracRulesToggles(this.stateManager, this.cwd)
		const { windsurfLocalToggles, cursorLocalToggles, agentsLocalToggles } = await refreshExternalRulesToggles(
			this.stateManager,
			this.cwd,
		)
		const evaluationContext = await RuleContextBuilder.buildEvaluationContext({
			cwd: this.cwd,
			messageStateHandler: this.messageStateHandler,
			workspaceManager: this.workspaceManager,
		})

		const globalDiracRulesFilePath = await ensureRulesDirectoryExists()
		const globalRules = await getGlobalDiracRules(globalDiracRulesFilePath, globalToggles, { evaluationContext })
		const globalDiracRulesFileInstructions = globalRules.instructions
		const localRules = await getLocalDiracRules(this.cwd, localToggles, { evaluationContext })
		const localDiracRulesFileInstructions = localRules.instructions
		const [localCursorRulesFileInstructions, localCursorRulesDirInstructions] = await getLocalCursorRules(
			this.cwd,
			cursorLocalToggles,
		)
		const localWindsurfRulesFileInstructions = await getLocalWindsurfRules(this.cwd, windsurfLocalToggles)
		const localAgentsRulesFileInstructions = await getLocalAgentsRules(this.cwd, agentsLocalToggles)
		this.diracIgnoreController.yoloMode = !!this.stateManager.getGlobalSettingsKey("yoloModeToggled")
		const isYolo = !!this.stateManager.getGlobalSettingsKey("yoloModeToggled")
		const diracIgnoreContent = this.diracIgnoreController.diracIgnoreContent
		let diracIgnoreInstructions: string | undefined
		if (diracIgnoreContent && !isYolo) diracIgnoreInstructions = formatResponse.diracIgnoreInstructions(diracIgnoreContent)

		let workspaceRoots: Array<{ path: string; name: string; vcs?: string }> | undefined
		const multiRootEnabled = isMultiRootEnabled(this.stateManager)
		if (multiRootEnabled && this.workspaceManager) {
			workspaceRoots = this.workspaceManager
				.getRoots()
				.map((root) => ({
					path: root.path,
					name: root.name || path.basename(root.path),
					vcs: root.vcs as string | undefined,
				}))
		}

		const resolvedSkills = await getOrDiscoverSkills(this.cwd, this.taskState)
		const globalSkillsToggles = this.stateManager.getGlobalSettingsKey("globalSkillsToggles") ?? {}
		const localSkillsToggles = this.stateManager.getWorkspaceStateKey("localSkillsToggles") ?? {}
		const availableSkills = resolvedSkills.filter((skill) => {
			const toggles = skill.source === "global" ? globalSkillsToggles : localSkillsToggles
			return toggles[skill.path] !== false
		})
		this.taskState.availableSkills = availableSkills

		const openTabPaths = (await HostProvider.window.getOpenTabs({})).paths || []
		const visibleTabPaths = (await HostProvider.window.getVisibleTabs({})).paths || []
		const cap = 50
		const editorTabs = { open: openTabPaths.slice(0, cap), visible: visibleTabPaths.slice(0, cap) }
		const shellInfo = detectBestShell()

		const promptContext: SystemPromptContext = {
			cwd: this.cwd,
			ide,
			providerInfo,
			editorTabs,
			supportsBrowserUse,
			skills: availableSkills,
			globalDiracRulesFileInstructions,
			localDiracRulesFileInstructions,
			localCursorRulesFileInstructions,
			localCursorRulesDirInstructions,
			localWindsurfRulesFileInstructions,
			localAgentsRulesFileInstructions,
			diracIgnoreInstructions,
			preferredLanguageInstructions,
			browserSettings: this.stateManager.getGlobalSettingsKey("browserSettings"),
			yoloModeToggled: this.stateManager.getGlobalSettingsKey("yoloModeToggled"),
			subagentsEnabled: this.stateManager.getGlobalSettingsKey("subagentsEnabled"),
			diracWebToolsEnabled:
				this.stateManager.getGlobalSettingsKey("diracWebToolsEnabled") && featureFlagsService.getWebtoolsEnabled(),
			isMultiRootEnabled: multiRootEnabled,
			workspaceRoots,
			isSubagentRun: false,
			isCliEnvironment,
			enableParallelToolCalling: this.isParallelToolCallingEnabled(),
			terminalExecutionMode: undefined,
			activeShellType: shellInfo.type,
			activeShellPath: shellInfo.path,
			activeShellIsPosix: shellInfo.isPosix,
			availableCores: getAvailableCores(),
			shouldCompact: params.shouldCompact,
		}

		const activatedConditionalRules = [...globalRules.activatedConditionalRules, ...localRules.activatedConditionalRules]
		if (activatedConditionalRules.length > 0) {
			// Notify user if any conditional rules were applied for this request
			await this.upsertText(JSON.stringify({ rules: activatedConditionalRules }))
		}

		const toolSnapshot = await this.toolExecutor.getSnapshotForRequest(promptContext)
		const { systemPrompt } = await getSystemPrompt(promptContext, toolSnapshot)
		this.toolExecutor.activateSnapshot(toolSnapshot)
		this.taskState.useNativeToolCalls = toolSnapshot.nativeTools.length > 0

		const contextManagementMetadata = await this.contextManager.getNewContextMessagesAndMetadata(
			this.messageStateHandler.getApiConversationHistory(),
			this.messageStateHandler.getDiracMessages(),
			this.api,
			this.taskState.conversationHistoryDeletedRange,
			params.previousApiReqIndex,
			await ensureTaskDirectoryExists(this.taskId),
			this.stateManager.getGlobalSettingsKey("useAutoCondense"),
		)

		await this.writePromptMetadataArtifacts({
			systemPrompt,
			providerInfo,
			tools: toolSnapshot.nativeTools,
			fullHistory: this.messageStateHandler.getApiConversationHistory(),
			deletedRange: this.taskState.conversationHistoryDeletedRange,
		})

		if (contextManagementMetadata.updatedConversationHistoryDeletedRange) {
			this.taskState.conversationHistoryDeletedRange = contextManagementMetadata.conversationHistoryDeletedRange
			await this.messageStateHandler.saveDiracMessagesAndUpdateHistory()
		}

		const useAutoCondense = this.stateManager.getGlobalSettingsKey("useAutoCondense")
		if (!useAutoCondense) {
			const lastMessage =
				contextManagementMetadata.truncatedConversationHistory[
					contextManagementMetadata.truncatedConversationHistory.length - 1
				]
			if (lastMessage && lastMessage.role === "user") {
				const notice = formatResponse.contextTruncationNotice()
				if (typeof lastMessage.content === "string") lastMessage.content += `\n\n${notice}`
				else if (Array.isArray(lastMessage.content)) lastMessage.content.push({ type: "text", text: notice })
			}
		}

		return { systemPrompt, toolSnapshot, contextManagementMetadata, providerInfo }
	}
}
