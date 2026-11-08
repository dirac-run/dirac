/**
 * Enhanced type definitions for better type safety and developer experience
 */

import { ApiProviderInfo } from "@/core/api"
import type { BrowserSettings } from "@/shared/BrowserSettings"
import type { SkillMetadata } from "@/shared/skills"
import { DiracDefaultTool } from "@/shared/tools"
import { ShellType } from "@/utils/shell-detection"
import { SystemPromptSection } from "./templates/placeholders"
import type { TaskExecutionProfile } from "@core/task/TaskExecutionProfile"

/**
 * Enhanced system prompt context with better typing
 */
export interface SystemPromptContext {
	readonly executionProfile?: TaskExecutionProfile
	readonly profileInstructions?: string
	readonly providerInfo: ApiProviderInfo
	readonly cwd?: string
	readonly ide: string
	readonly editorTabs?: {
		readonly open?: readonly string[]
		readonly visible?: readonly string[]
	}
	readonly supportsBrowserUse?: boolean
	readonly skills?: SkillMetadata[]
	readonly globalDiracRulesFileInstructions?: string
	readonly localDiracRulesFileInstructions?: string
	readonly localCursorRulesFileInstructions?: string
	readonly localCursorRulesDirInstructions?: string
	readonly localWindsurfRulesFileInstructions?: string
	readonly localAgentsRulesFileInstructions?: string
	readonly diracIgnoreInstructions?: string
	readonly preferredLanguageInstructions?: string
	readonly userInstructions?: string
	readonly diracRules?: string
	readonly browserSettings?: BrowserSettings
	readonly isTesting?: boolean
	readonly runtimePlaceholders?: Readonly<Record<string, unknown>>
	readonly yoloModeToggled?: boolean
	readonly lowVerbosityEnabled?: boolean
	readonly subagentsEnabled?: boolean
	readonly subagentRoles?: readonly { name: string; description: string }[]
	readonly diracWebToolsEnabled?: boolean
	readonly isMultiRootEnabled?: boolean
	readonly workspaceRoots?: Array<{ path: string; name: string; vcs?: string }>
	readonly isSubagentsEnabledAndCliInstalled?: boolean
	readonly isCliSubagent?: boolean
	readonly isCliEnvironment?: boolean
	readonly terminalExecutionMode?: "vscodeTerminal" | "backgroundExec"
	readonly activeShellType?: ShellType
	readonly activeShellPath?: string
	readonly activeShellIsPosix?: boolean
	readonly availableCores?: number
	readonly shouldCompact?: boolean
}

/**
 * Utility functions for validating prompt components
 */
export function isValidSystemPromptSection(section: string): section is SystemPromptSection {
	return Object.values(SystemPromptSection).includes(section as SystemPromptSection)
}

export function isValidDiracDefaultTool(tool: string): tool is DiracDefaultTool {
	return Object.values(DiracDefaultTool).includes(tool as DiracDefaultTool)
}
