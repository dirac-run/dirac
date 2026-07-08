import type { DiracToolSpec } from "@/shared/tools"
import { Logger } from "@/shared/services/Logger"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import type { IDiracTool } from "../interfaces/IDiracTool"
import type { TaskConfig } from "../types/TaskConfig"
import type { DiscoveredTool, ToolSource } from "../discovery/DiscoveredTool"
import { StateManager } from "@/core/storage/StateManager"

const SOURCE_PRIORITY: Record<ToolSource, number> = { builtin: 0, global: 1, workspace: 2, task: 3 }

export class ToolRegistry {
	private static instance: ToolRegistry | undefined
	private builtinTools: Map<string, DiscoveredTool> = new Map()
	private userTools: Map<string, DiscoveredTool> = new Map()
	private enabledOverrides: Map<string, boolean> = new Map()
	private _version = 0

	static getInstance(): ToolRegistry {
		if (!this.instance) {
			this.instance = new ToolRegistry()
		}
		return this.instance
	}

	/** Reset singleton (for testing) */
	static resetInstance(): void {
		this.instance = undefined
	}

	register(tool: DiscoveredTool): void {
		if (tool.source === "builtin") {
			this.registerBuiltin(tool)
			return
		}
		this.registerUserTool(tool)
	}

	getVersion(): number {
		return this._version
	}

	registerBuiltin(tool: DiscoveredTool): void {
		this.builtinTools.set(tool.id, tool)
	}

	registerUserTool(tool: DiscoveredTool): boolean {
		if (this.collidesWithBuiltin(tool)) {
			Logger.warn(`[ToolRegistry] User tool '${tool.id}' conflicts with built-in tool id/name. Skipping.`)
			return false
		}

		const existing = this.findUserToolByIdOrName(tool)
		if (!existing) {
			this.userTools.set(tool.id, tool)
			this._version++
			return true
		}

		if (existing.source === tool.source) {
			return false
		}
		// Priority: task > workspace > global > builtin
		const existingPri = SOURCE_PRIORITY[existing.source] ?? 0
		const newPri = SOURCE_PRIORITY[tool.source] ?? 0
		if (newPri > existingPri) {
			this.userTools.delete(existing.id)
			this.userTools.set(tool.id, tool)
			this._version++
			return true
		}

		Logger.warn(
			`[ToolRegistry] User tool '${tool.id}' conflicts with existing tool '${existing.id}' (source: ${existing.source}). Keeping existing.`,
		)
		return false
	}

	hasBuiltinTools(): boolean {
		return this.builtinTools.size > 0
	}

	enable(toolId: string): void {
		this.enabledOverrides.set(toolId, true)
	}

	disable(toolId: string): void {
		this.enabledOverrides.set(toolId, false)
	}

	isEnabled(toolId: string): boolean {
		const override = this.enabledOverrides.get(toolId)
		if (override !== undefined) {
			return override
		}
		const tool = this.getTool(toolId)
		return tool?.source === "builtin"
	}

	getEnabledTools(): DiscoveredTool[] {
		return this.getAllTools().filter((tool) => this.isEnabled(tool.id))
	}

	getEnabledSpecs(context: SystemPromptContext): DiracToolSpec[] {
		return this.getEnabledTools()
			.map((t) => t.spec)
			.filter((spec) => !spec.contextRequirements || spec.contextRequirements(context))
	}

	getEnabledSpecsForSubagent(context: SystemPromptContext, allowed: string[]): DiracToolSpec[] {
		return this.getEnabledTools()
			.filter((tool) => this.isDiscoveredToolAllowed(tool, allowed))
			.map((tool) => tool.spec)
			.filter((spec) => !spec.contextRequirements || spec.contextRequirements(context))
	}

	getAllTools(): DiscoveredTool[] {
		return [...this.builtinTools.values(), ...this.userTools.values()]
	}

	getToolsBySource(source: ToolSource): DiscoveredTool[] {
		return this.getAllTools().filter((t) => t.source === source)
	}

	createEnabledTools(config: TaskConfig): IDiracTool[] {
		return this.getEnabledTools().map((t) => t.factory(config))
	}

	createEnabledToolsForSubagent(config: TaskConfig, allowed: string[]): IDiracTool[] {
		return this.getEnabledTools()
			.filter((tool) => this.isDiscoveredToolAllowed(tool, allowed))
			.map((t) => t.factory(config))
	}

	isToolAllowed(toolName: string, allowed: string[]): boolean {
		const tool = this.findToolByIdOrName(toolName)
		if (!tool) {
			return allowed.includes(toolName)
		}
		return this.isEnabled(tool.id) && this.isDiscoveredToolAllowed(tool, allowed)
	}

	loadToggles(toggles: Record<string, boolean>): void {
		this.enabledOverrides = new Map(Object.entries(toggles))
	}

	getToggles(): Record<string, boolean> {
		const result: Record<string, boolean> = {}
		for (const [id, enabled] of this.enabledOverrides) {
			result[id] = enabled
		}
		return result
	}

	/**
	 * Remove non-task user tools from the registry.
	 * Task-scoped tools are runtime state and must survive workspace rescans.
	 * Built-ins are kept in a separate map and cannot be removed here.
	 */
	clearUserTools(): void {
		for (const [id, tool] of this.userTools) {
			if (tool.source !== "task") {
				this.userTools.delete(id)
			}
		}
	}

	/** Remove a single user tool from the registry by id. Returns true if the tool was found and removed. */
	removeUserTool(toolId: string): boolean {
		const tool = this.userTools.get(toolId)
		if (!tool) {
			return false
		}
		this.userTools.delete(toolId)
		this.enabledOverrides.delete(toolId)
		this._version++
		return true
	}

	/** Enable or disable a tool and persist the toggle state to settings. */
	toggleAndPersist(toolId: string, enabled: boolean): void {
		if (enabled) {
			this.enable(toolId)
		} else {
			this.disable(toolId)
		}
		StateManager.get().setGlobalState("toolToggles", this.getToggles())
	}

	private getTool(toolId: string): DiscoveredTool | undefined {
		return this.builtinTools.get(toolId) ?? this.userTools.get(toolId)
	}

	private findToolByIdOrName(toolName: string): DiscoveredTool | undefined {
		return this.getAllTools().find((tool) => tool.id === toolName || tool.name === toolName || tool.spec.name === toolName)
	}

	private collidesWithBuiltin(tool: DiscoveredTool): boolean {
		return Array.from(this.builtinTools.values()).some((builtin) => this.toolsCollide(builtin, tool))
	}

	private findUserToolByIdOrName(tool: DiscoveredTool): DiscoveredTool | undefined {
		return Array.from(this.userTools.values()).find((existing) => this.toolsCollide(existing, tool))
	}

	private toolIdentifiers(tool: DiscoveredTool): Set<string> {
		return new Set([tool.id, tool.name, tool.spec.name].filter(Boolean))
	}

	private toolsCollide(a: DiscoveredTool, b: DiscoveredTool): boolean {
		const aIds = this.toolIdentifiers(a)
		const bIds = this.toolIdentifiers(b)
		return [...aIds].some((id) => bIds.has(id))
	}

	private isDiscoveredToolAllowed(tool: DiscoveredTool, allowed: string[]): boolean {
		const allowedSet = new Set(allowed)
		return allowedSet.has(tool.id) || allowedSet.has(tool.name) || allowedSet.has(tool.spec.name)
	}
}
