import { meetsHostCapabilityRequirement } from "@hosts/host-capabilities"
import type { ApiProviderInfo } from "@core/api"
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
import { ensureRulesDirectoryExists, ensureTaskDirectoryExists } from "@core/storage/disk"
import type { TaskStorageAddress } from "@core/storage/taskDirectory"
import { HostProvider } from "@hosts/host-provider"
import { featureFlagsService } from "@services/feature-flags"
import { DiracClient } from "@shared/dirac"
import { DEFAULT_LANGUAGE_SETTINGS, getLanguageKey, type LanguageDisplay } from "@shared/Languages"
import * as path from "path"
import { filterSkillsByProviderCapabilities } from "@/shared/skills"
import { getAvailableCores } from "@/utils/os"
import { detectBestShell } from "@/utils/shell-detection"
import type { ContextManager } from "../context/context-management/ContextManager"
import { RuleContextBuilder } from "../context/instructions/user-instructions/RuleContextBuilder"
import { getOrDiscoverSkills } from "../context/instructions/user-instructions/skills"
import type { DiracIgnoreController } from "../ignore/DiracIgnoreController"
import type { SystemPromptContext } from "../prompts/system-prompt"
import { getSystemPrompt } from "../prompts/system-prompt"
import type { StateManager } from "../storage/StateManager"
import type { WorkspaceRootManager } from "../workspace/WorkspaceRootManager"
import type { ApiConversationManager } from "./ApiConversationManager"
import type { MessageStateHandler } from "./message-state"
import type { TaskMessenger } from "./TaskMessenger"
import type { TaskState } from "./TaskState"
import type { ToolExecutor } from "./ToolExecutor"
import type { TaskRequestRuntime } from "./runtime/TaskRequestRuntime"
import { bindToolSnapshotToRequestRuntime } from "./runtime/TaskRequestRuntime"
import type { TaskExecutionProfile } from "./TaskExecutionProfile"
import { isSkillAvailableToTaskProfile, taskProfileSystemInstructions } from "./TaskExecutionProfile"

export interface TaskRequestBuilderContext {
	taskId: string
	storageAddress?: TaskStorageAddress
	cwd: string
	terminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	stateManager: StateManager
	messageStateHandler: MessageStateHandler
	taskMessenger: TaskMessenger
	toolExecutor: ToolExecutor
	contextManager: ContextManager
	apiConversationManager: ApiConversationManager
	diracIgnoreController: DiracIgnoreController
	workspaceManager?: WorkspaceRootManager
	taskState: TaskState
	executionProfile: TaskExecutionProfile
	getPinnedContext: () => Promise<string | undefined>
	taskletConfiguration?: import("./TaskletConfiguration").TaskletConfiguration
	getTaskletSupervisionContext?: () => string | undefined
	writePromptMetadataArtifacts: (params: {
		systemPrompt: string
		providerInfo: ApiProviderInfo
		tools: any[]
		fullHistory: any[]
		deletedRange?: [number, number]
	}) => Promise<void>
}

export async function buildApiRequestParams(
	ctx: TaskRequestBuilderContext,
	requestRuntime: TaskRequestRuntime,
	params: { previousApiReqIndex: number; shouldCompact?: boolean },
): Promise<{
	systemPrompt: string
	toolSnapshot: Awaited<ReturnType<ToolExecutor["getSnapshotForRequest"]>>
	contextManagementMetadata: Awaited<ReturnType<ContextManager["getNewContextMessagesAndMetadata"]>>
	providerInfo: ApiProviderInfo
}> {
	const { settings, workspaceConfiguration, executionOptions } = requestRuntime.workingConfiguration
	if (ctx.executionProfile === "standalone") ctx.taskState.pinnedContext = await ctx.getPinnedContext()
	const apiConfiguration = requestRuntime.workingConfiguration.apiConfiguration
	const mode = settings.mode
	const providerInfo: ApiProviderInfo = {
		model: requestRuntime.api.getModel(),
		providerId: (mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider) as string,
		customPrompt: settings.customPrompt,
		mode,
		supportsNativeWebSearch: requestRuntime.api.supportsNativeWebSearch?.() === true,
	}
	const host = await HostProvider.env.getHostVersion({})
	const ide = host?.platform || "Unknown"
	const isCliEnvironment = host.diracType === DiracClient.Cli
	const browserSettings = settings.browserSettings
	const disableBrowserTool = browserSettings?.disableToolUse ?? false
	const modelSupportsBrowserUse = providerInfo.model.info.supportsImages ?? false

	const supportsBrowserUse = modelSupportsBrowserUse && !disableBrowserTool
	const preferredLanguageRaw = settings.preferredLanguage
	const preferredLanguage = getLanguageKey(preferredLanguageRaw as LanguageDisplay)
	const preferredLanguageInstructions =
		preferredLanguage && preferredLanguage !== DEFAULT_LANGUAGE_SETTINGS
			? `# Preferred Language\n\nSpeak in ${preferredLanguage}.`
			: ""

	const { globalToggles, localToggles } = await refreshDiracRulesToggles(ctx.stateManager, ctx.cwd, {
		globalToggles: settings.globalDiracRulesToggles,
		localToggles: workspaceConfiguration.localDiracRulesToggles,
	})
	const { windsurfLocalToggles, cursorLocalToggles, agentsLocalToggles } = await refreshExternalRulesToggles(
		ctx.stateManager,
		ctx.cwd,
		{
			localWindsurfRulesToggles: workspaceConfiguration.localWindsurfRulesToggles,
			localCursorRulesToggles: workspaceConfiguration.localCursorRulesToggles,
			localAgentsRulesToggles: workspaceConfiguration.localAgentsRulesToggles,
		},
	)

	const evaluationContext = await new RuleContextBuilder().buildEvaluationContext({
		cwd: ctx.cwd,
		messageStateHandler: ctx.messageStateHandler,
		workspaceManager: ctx.workspaceManager,
	})

	const globalDiracRulesFilePath = await ensureRulesDirectoryExists()
	const globalRules = await getGlobalDiracRules(globalDiracRulesFilePath, globalToggles, { evaluationContext })
	const globalDiracRulesFileInstructions = globalRules.instructions
	const localRules = await getLocalDiracRules(ctx.cwd, localToggles, { evaluationContext })
	const localDiracRulesFileInstructions = localRules.instructions
	const [localCursorRulesFileInstructions, localCursorRulesDirInstructions] = await getLocalCursorRules(
		ctx.cwd,
		cursorLocalToggles,
	)
	const localWindsurfRulesFileInstructions = await getLocalWindsurfRules(ctx.cwd, windsurfLocalToggles)
	const localAgentsRulesFileInstructions = await getLocalAgentsRules(ctx.cwd, agentsLocalToggles)
	ctx.diracIgnoreController.yoloMode = !!settings.yoloModeToggled
	const isYolo = !!settings.yoloModeToggled
	const diracIgnoreContent = ctx.diracIgnoreController.diracIgnoreContent
	let diracIgnoreInstructions: string | undefined
	if (diracIgnoreContent && !isYolo) {
		diracIgnoreInstructions = formatResponse.diracIgnoreInstructions(diracIgnoreContent)
	}

	let workspaceRoots: Array<{ path: string; name: string; vcs?: string }> | undefined
	const multiRootEnabled = executionOptions.multiRootEnabled
	if (multiRootEnabled && ctx.workspaceManager) {
		workspaceRoots = ctx.workspaceManager.getRoots().map((root) => ({
			path: root.path,
			name: root.name || path.basename(root.path),
			vcs: root.vcs as string | undefined,
		}))
	}

	const resolvedSkills = await getOrDiscoverSkills(ctx.cwd, ctx.taskState)
	const providerSkills = filterSkillsByProviderCapabilities(resolvedSkills, {
		native_web_search: providerInfo.supportsNativeWebSearch === true,
	})
	const globalSkillsToggles = settings.globalSkillsToggles ?? {}
	const localSkillsToggles = workspaceConfiguration.localSkillsToggles ?? {}
	const availableSkills = providerSkills.filter(meetsHostCapabilityRequirement).filter((skill) => {
		if (!isSkillAvailableToTaskProfile(ctx.executionProfile, skill)) return false
		if (settings.yoloModeToggled && skill.interactiveOnly) return false
		if (skill.source === "builtin") return true
		const toggles = skill.source === "global" ? globalSkillsToggles : localSkillsToggles
		return toggles[skill.path] !== false
	})
	ctx.taskState.availableSkills = availableSkills

	const openTabPaths = (await HostProvider.window.getOpenTabs({})).paths || []
	const visibleTabPaths = (await HostProvider.window.getVisibleTabs({})).paths || []
	const cap = 50
	const editorTabs = {
		open: openTabPaths.slice(0, cap),
		visible: visibleTabPaths.slice(0, cap),
	}
	const shellInfo = detectBestShell()

	const promptContext: SystemPromptContext = {
		executionProfile: ctx.executionProfile,
		taskId: ctx.taskId,
		profileInstructions: taskProfileSystemInstructions(ctx.executionProfile, settings.subagentsEnabled),
		cwd: ctx.cwd,
		ide,
		providerInfo,
		editorTabs,
		supportsBrowserUse,
		subagentRoles: ctx.stateManager.getSystemDefaultSettingsKey("subagentRoles")
			.filter((role) => role.enabled && role.modelSelection)
			.map(({ name, description }) => ({ name, description })),
		skills: availableSkills,
		globalDiracRulesFileInstructions,
		localDiracRulesFileInstructions,
		localCursorRulesFileInstructions,
		localCursorRulesDirInstructions,
		localWindsurfRulesFileInstructions,
		localAgentsRulesFileInstructions,
		diracIgnoreInstructions,
		preferredLanguageInstructions,
		browserSettings,
		yoloModeToggled: settings.yoloModeToggled,
		lowVerbosityEnabled: settings.lowVerbosityEnabled,
		subagentsEnabled: settings.subagentsEnabled,
		diracWebToolsEnabled: settings.diracWebToolsEnabled && featureFlagsService.getWebtoolsEnabled(),
		isMultiRootEnabled: multiRootEnabled,
		workspaceRoots,
		isCliEnvironment,
		terminalExecutionMode: ctx.terminalExecutionMode,
		activeShellType: shellInfo.type,
		activeShellPath: shellInfo.path,
		activeShellIsPosix: shellInfo.isPosix,
		availableCores: getAvailableCores(),
		shouldCompact: params.shouldCompact,
	}

	const activatedConditionalRules = [...globalRules.activatedConditionalRules, ...localRules.activatedConditionalRules]
	if (activatedConditionalRules.length > 0) {
		await ctx.taskMessenger.upsertText(JSON.stringify({ rules: activatedConditionalRules }))
	}

	const ruleLoadErrors = [...(globalRules.errors ?? []), ...(localRules.errors ?? [])]
	if (ruleLoadErrors.length > 0) {
		await ctx.taskMessenger.upsertText(JSON.stringify({ ruleLoadErrors }))
	}

	const toolSnapshot = await ctx.toolExecutor.getSnapshotForRequest(promptContext, requestRuntime)
	const { systemPrompt: baseSystemPrompt } = await getSystemPrompt(promptContext, toolSnapshot)
	const pinnedContext = await ctx.getPinnedContext()
	const configuration = ctx.taskletConfiguration
	const supervisionContext = ctx.getTaskletSupervisionContext?.()
	const instructions = [
		baseSystemPrompt,
		configuration?.name && configuration.name !== "default" ? `# Subagent Role\n${configuration.name}` : undefined,
	].filter(Boolean).join("\n\n")
	const runtimeContext = [
		ctx.executionProfile !== "standalone" ? pinnedContext : undefined,
		supervisionContext ? `# Current Tasklet Supervision\n${supervisionContext}` : undefined,
	].filter(Boolean).join("\n\n")
	const systemPrompt = await ctx.apiConversationManager.prepareTranscriptInstructions(instructions, runtimeContext)
	const boundRequestRuntime = bindToolSnapshotToRequestRuntime(requestRuntime, toolSnapshot)
	ctx.toolExecutor.activateSnapshot(toolSnapshot, boundRequestRuntime)
	ctx.taskState.useNativeToolCalls = toolSnapshot.nativeTools.length > 0
	const contextManagementMetadata = await ctx.contextManager.getNewContextMessagesAndMetadata(
		ctx.messageStateHandler.getApiConversationHistory(),
		ctx.messageStateHandler.getDiracMessages(),
		requestRuntime.api,
		ctx.taskState.conversationHistoryDeletedRange,
		params.previousApiReqIndex,
		await ensureTaskDirectoryExists(ctx.storageAddress ?? ctx.taskId),
		settings.useAutoCondense,
	)

	if (contextManagementMetadata.updatedConversationHistoryDeletedRange) {
		const previousConversationHistoryDeletedRange = ctx.taskState.conversationHistoryDeletedRange
		const conversationHistoryDeletedRange = contextManagementMetadata.conversationHistoryDeletedRange
		if (!conversationHistoryDeletedRange) {
			throw new Error("Context management reported a truncation update without a deleted range.")
		}
		ctx.taskState.conversationHistoryDeletedRange = conversationHistoryDeletedRange
		await ctx.apiConversationManager.scheduleProviderConversationCompaction(
			previousConversationHistoryDeletedRange,
			conversationHistoryDeletedRange,
		)
		await ctx.messageStateHandler.saveDiracMessagesAndUpdateHistory()
	}


	await ctx.writePromptMetadataArtifacts({
		systemPrompt,
		providerInfo,
		tools: toolSnapshot.nativeTools,
		fullHistory: ctx.messageStateHandler.getApiConversationHistory(),
		deletedRange: ctx.taskState.conversationHistoryDeletedRange,
	})
	return { systemPrompt, toolSnapshot, contextManagementMetadata, providerInfo }
}
