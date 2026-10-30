import type { Controller } from "@/core/controller"
import type { InferenceSpeed, OpenaiReasoningEffort } from "@/shared/storage/types"

export enum CliPanelType {
	SETTINGS = "settings",
	HISTORY = "history",
	HELP = "help",
	SKILLS = "skills",
	USAGE = "usage",
	AGENTS = "agents",
}

/**
 * Common options shared between runTask and resumeTask
 */
export interface TaskOptions {
	act?: boolean
	plan?: boolean
	provider?: string
	kanban?: boolean
	model?: string
	images?: string[]
	verbose?: boolean
	cwd?: string
	continue?: boolean
	config?: string
	thinking?: boolean | string | number
	reasoningEffort?: OpenaiReasoningEffort
	speed?: InferenceSpeed
	maxConsecutiveMistakes?: string | number
	yolo?: boolean
	autoApproveAll?: boolean
	autoCondense?: boolean
	autoCondenseAt?: string | number
	timeout?: string | number
	json?: boolean
	stdinWasPiped?: boolean
	hooksDir?: string
	subagents?: boolean
	headers?: string
	enableTool?: string[]
	disableTool?: string[]
	onlyTools?: string[]
	index?: boolean

	noEmoji?: boolean
	format?: "json" | "ansi" | "plain"
}

export interface CliContext {
	extensionContext: any
	dataDir: string
	extensionDir: string
	workspacePath: string
	controller: Controller
}

export interface InitOptions {
	config?: string
	cwd?: string
	hooksDir?: string
	verbose?: boolean
	enableAuth?: boolean
	index?: boolean
}
