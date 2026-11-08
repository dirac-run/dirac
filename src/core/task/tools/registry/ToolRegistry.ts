import type { DiracToolSpec } from "@/shared/tools"
import { Logger } from "@/shared/services/Logger"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import * as path from "path"
import type { SkillMetadata } from "@shared/skills"
import type { IDiracTool } from "../interfaces/IDiracTool"
import type { TaskConfig } from "../types/TaskConfig"
import type { DiscoveredTool, ToolSource } from "../discovery/DiscoveredTool"
import { StateManager } from "@/core/storage/StateManager"
import { LEGACY_RESPONSE_TOOLS, RESPOND_TOOL_NAME } from "@shared/responseTool"
import Mutex from "p-mutex"

const SOURCE_PRIORITY: Record<ToolSource, number> = { builtin: 0, global: 1, workspace: 2, task: 3 }






export interface UserToolReplacementResult {
	replaced: boolean
	enabledNewTool: boolean
	previousTool?: DiscoveredTool
}





export class ToolRegistry {
	private static readonly accessMutex = new Mutex()
	private static instance: ToolRegistry | undefined
	private builtinTools: Map<string, DiscoveredTool> = new Map()
	private userTools: Map<string, DiscoveredTool> = new Map()
	private workspaceToolsByRoot: Map<string, Map<string, DiscoveredTool>> = new Map()
	private taskToolsByOwner: Map<string, Map<string, DiscoveredTool>> = new Map()
	private defaultWorkspaceKey = ""
	private enabledOverrides: Map<string, boolean> = new Map()
	private _version = 0

	static getInstance(): ToolRegistry {
		if (!this.instance) {
			this.instance = new ToolRegistry()
		}
		return this.instance
	}

	/** Serialize every production mutation and Task inventory capture of the process-global registry. */
	static async withExclusiveAccess<T>(operation: (registry: ToolRegistry) => T | Promise<T>): Promise<T> {
		return this.accessMutex.withLock(async () => operation(this.getInstance()))
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

	registerUserTool(tool: DiscoveredTool, workspaceRoot?: string): boolean {
		if (tool.source === "task") {
			if (!tool.ownerTaskId) throw new Error(`Task tool '${tool.id}' is missing its owner Task id.`)
			return this.registerTaskTool(tool.ownerTaskId, tool)
		}
		if (tool.source === "workspace") {
			const tools = workspaceRoot === undefined ? this.workspaceToolsForModule(tool.modulePath) : this.workspaceToolsForRoot(workspaceRoot)
			return this.registerSharedUserTool(tools, tool)
		}
		return this.registerSharedUserTool(this.userTools, tool)
	}

	/**
	 * Atomically adds or replaces the effective user tool. Existing toggle state
	 * is preserved on replacement; enableIfNew applies only when no tool exists.
	 */
	replaceUserTool(tool: DiscoveredTool, enableIfNew = false, workspaceRoot?: string): boolean {
		return this.replaceUserToolWithResult(tool, enableIfNew, workspaceRoot).replaced
	}

	/** Replace a user tool and report whether this operation enabled a newly inserted shared tool. */
	replaceUserToolWithResult(
		tool: DiscoveredTool,
		enableIfNew = false,
		workspaceRoot?: string,
	): UserToolReplacementResult {
		if (tool.source === "task") {
			if (!tool.ownerTaskId) throw new Error(`Task tool '${tool.id}' is missing its owner Task id.`)
			const ownerTools = this.taskToolsByOwner.get(tool.ownerTaskId)
			const previousTool = ownerTools ? this.findToolByCollision(ownerTools.values(), tool) : undefined
			return {
				replaced: this.replaceTaskTool(tool.ownerTaskId, tool),
				enabledNewTool: false,
				previousTool,
			}
		}
		const tools =
			tool.source === "workspace"
				? workspaceRoot === undefined
					? this.workspaceToolsForModule(tool.modulePath)
					: this.workspaceToolsForRoot(workspaceRoot)
				: this.userTools
		// Check the effective shared inventory before writing to a lower-priority storage layer.
		const sharedTools = workspaceRoot === undefined ? this.getAllTools() : this.getAllTools(undefined, workspaceRoot)
		const higherPriorityTool = sharedTools.find(
			(existing) =>
				this.toolsCollide(existing, tool) && (SOURCE_PRIORITY[tool.source] ?? 0) < (SOURCE_PRIORITY[existing.source] ?? 0),
		)
		if (higherPriorityTool) {
			Logger.warn(
				`[ToolRegistry] User tool '${tool.id}' conflicts with existing tool '${higherPriorityTool.id}' (source: ${higherPriorityTool.source}). Keeping existing.`,
			)
			return { replaced: false, enabledNewTool: false }
		}
		return this.replaceSharedUserTool(tools, tool, enableIfNew)
	}

	/** Reconcile global and one workspace's tools without replacing another workspace's inventory. */
	reconcileWorkspaceUserTools(
		discoveredTools: DiscoveredTool[],
		forceVersionBump = false,
		workspaceRoot?: string,
	): boolean {
		const nextGlobalTools = new Map<string, DiscoveredTool>()
		const nextWorkspaceTools = new Map<string, DiscoveredTool>()
		for (const tool of discoveredTools) {
			this.registerUserToolInto(tool.source === "workspace" ? nextWorkspaceTools : nextGlobalTools, tool)
		}

		const workspaceKey = this.workspaceKey(workspaceRoot)
		this.defaultWorkspaceKey = workspaceKey
		const currentWorkspaceTools = this.workspaceToolsByRoot.get(workspaceKey) ?? new Map<string, DiscoveredTool>()
		const changed =
			!this.sameToolInventory(this.userTools, nextGlobalTools) ||
			!this.sameToolInventory(currentWorkspaceTools, nextWorkspaceTools)
		if (!changed) {
			if (forceVersionBump) this._version++
			return forceVersionBump
		}

		this.userTools = nextGlobalTools
		if (nextWorkspaceTools.size === 0) this.workspaceToolsByRoot.delete(workspaceKey)
		else this.workspaceToolsByRoot.set(workspaceKey, nextWorkspaceTools)
		this._version++
		return true
	}

	reconcileTaskTools(ownerTaskId: string, discoveredTools: DiscoveredTool[]): string[] {
		const nextTools = new Map<string, DiscoveredTool>()
		for (const tool of discoveredTools) {
			if (tool.ownerTaskId !== ownerTaskId) throw new Error(`Task tool '${tool.id}' has the wrong owner Task id.`)
			if (this.collidesWithBuiltin(tool)) continue
			if (this.findToolByCollision(nextTools.values(), tool)) continue
			nextTools.set(tool.id, tool)
		}
		const currentTools = this.taskToolsByOwner.get(ownerTaskId) ?? new Map<string, DiscoveredTool>()
		if (!this.sameToolInventory(currentTools, nextTools)) {
			if (nextTools.size === 0) this.taskToolsByOwner.delete(ownerTaskId)
			else this.taskToolsByOwner.set(ownerTaskId, nextTools)
			this._version++
		}
		return [...nextTools.keys()]
	}

	hasBuiltinTools(): boolean {
		return this.builtinTools.size > 0
	}

	enable(toolId: string): void {
		this.assertConfigurable(toolId)
		this.enabledOverrides.set(toolId, true)
	}

	disable(toolId: string): void {
		this.assertConfigurable(toolId)
		this.enabledOverrides.set(toolId, false)
	}

	isEnabled(toolId: string): boolean {
		const tool = this.getTool(toolId)
		if (!tool || tool.executable === false || tool.exposure.kind === "skill_only") return false

		const override = this.enabledOverrides.get(toolId)
		if (override !== undefined) {
			return override
		}
		return tool.source === "builtin"
	}

	getEnabledTools(ownerTaskId?: string, workspaceRoot?: string): DiscoveredTool[] {
		const tools = arguments.length >= 2 ? this.getAllTools(ownerTaskId, workspaceRoot) : this.getAllTools(ownerTaskId)
		return tools.filter((tool) => this.isEnabledTool(tool))
	}

	getEnabledSpecs(context: SystemPromptContext): DiracToolSpec[] {
		return this.getEnabledTools()
			.map((t) => t.spec)
			.filter((spec) => !spec.contextRequirements || spec.contextRequirements(context))
	}



	getAllTools(ownerTaskId?: string, workspaceRoot?: string): DiscoveredTool[] {
		const globalTools = [...this.builtinTools.values(), ...this.userTools.values()]
		const workspaceKey = arguments.length >= 2 ? this.workspaceKey(workspaceRoot) : this.defaultWorkspaceKey
		const workspaceTools = this.workspaceToolsByRoot.get(workspaceKey)?.values() ?? []
		const sharedTools = this.overlayTaskTools(globalTools, workspaceTools)
		if (!ownerTaskId) return sharedTools
		return this.overlayTaskTools(sharedTools, this.taskToolsByOwner.get(ownerTaskId)?.values() ?? [])
	}

	getKnownUserToolIds(): string[] {
		const ids = new Set(this.userTools.keys())
		for (const tools of this.workspaceToolsByRoot.values()) {
			for (const id of tools.keys()) ids.add(id)
		}
		for (const tools of this.taskToolsByOwner.values()) {
			for (const id of tools.keys()) ids.add(id)
		}
		return [...ids]
	}

	getConfigurableTools(ownerTaskId?: string, workspaceRoot?: string): DiscoveredTool[] {
		const tools =
			arguments.length >= 2 ? this.getAllTools(ownerTaskId, workspaceRoot) : this.getAllTools(ownerTaskId)
		return tools.filter((tool) => tool.exposure.kind === "configurable")
	}

	resolveSkillDependencyTools(
		activeSkills: readonly SkillMetadata[],
		ownerTaskId?: string,
		workspaceRoot?: string,
	): DiscoveredTool[] {
		const resolved = new Map<string, DiscoveredTool>()
		const scopedTools = this.getAllTools(ownerTaskId, workspaceRoot)

		for (const skill of activeSkills) {
			if (skill.source !== "builtin") continue
			for (const toolId of skill.toolDependencies ?? []) {
				const tool = scopedTools.find(
					(candidate) =>
						candidate.id === toolId || candidate.name === toolId || candidate.spec.name === toolId,
				)
				if (!tool) throw new Error(`Built-in skill '${skill.name}' depends on missing tool '${toolId}'.`)
				if (tool.exposure.kind !== "skill_only") {
					throw new Error(`Built-in skill '${skill.name}' declares non-skill-only dependency '${toolId}'.`)
				}
				if (!tool.exposure.authorizedSkillIds.includes(skill.name)) {
					throw new Error(`Skill '${skill.name}' is not authorized to activate tool '${toolId}'.`)
				}
				resolved.set(tool.id, tool)
			}
		}

		return [...resolved.values()]
	}

	getToolsBySource(source: ToolSource): DiscoveredTool[] {
		return this.getAllTools().filter((t) => t.source === source)
	}

	createEnabledTools(config: TaskConfig): IDiracTool[] {
		return this.getEnabledTools().map((t) => t.factory(config))
	}



	/** Restore the registry entry replaced by an upsert, or remove a newly inserted entry. */
	rollbackUserToolReplacement(
		tool: DiscoveredTool,
		previousTool: DiscoveredTool | undefined,
		disableNewTool: boolean,
		workspaceRoot?: string,
	): void {
		if (previousTool) {
			this.replaceUserTool(previousTool, false, workspaceRoot)
			return
		}
		if (tool.source === "task") {
			if (!tool.ownerTaskId) throw new Error(`Task tool '${tool.id}' is missing its owner Task id.`)
			const ownerTools = this.taskToolsByOwner.get(tool.ownerTaskId)
			if (!ownerTools?.delete(tool.id)) return
			if (ownerTools.size === 0) this.taskToolsByOwner.delete(tool.ownerTaskId)
			this._version++
			return
		}
		const tools = tool.source === "workspace" ? this.workspaceToolsForRoot(workspaceRoot) : this.userTools
		if (!tools.delete(tool.id)) return
		if (disableNewTool) this.enabledOverrides.delete(tool.id)
		this._version++
	}





	loadToggles(toggles: Record<string, boolean>): void {
		const migrated = { ...toggles }
		const legacyNames = Object.keys(LEGACY_RESPONSE_TOOLS)
		if (!(RESPOND_TOOL_NAME in migrated) && legacyNames.some((name) => name in migrated)) {
			migrated[RESPOND_TOOL_NAME] = legacyNames.every((name) => migrated[name] ?? true)
		}
		for (const name of legacyNames) delete migrated[name]
		this.enabledOverrides = new Map(
			Object.entries(migrated).filter(([toolId]) => this.getTool(toolId)?.exposure.kind === "configurable"),
		)
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
		this.userTools.clear()
		this.workspaceToolsByRoot.clear()
	}

	/** Remove a single shared user tool by id. Task tools are removed by owner. */
	removeUserTool(toolId: string): boolean {
		let removed = this.userTools.delete(toolId)
		for (const [workspaceKey, tools] of this.workspaceToolsByRoot) {
			if (tools.delete(toolId)) removed = true
			if (tools.size === 0) this.workspaceToolsByRoot.delete(workspaceKey)
		}
		if (!removed) return false
		this.enabledOverrides.delete(toolId)
		this._version++
		return true
	}

	removeTaskTools(ownerTaskId: string): boolean {
		if (!this.taskToolsByOwner.delete(ownerTaskId)) return false
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

	private registerSharedUserTool(tools: Map<string, DiscoveredTool>, tool: DiscoveredTool): boolean {
		if (this.collidesWithBuiltin(tool)) {
			Logger.warn(`[ToolRegistry] User tool '${tool.id}' conflicts with built-in tool id/name. Skipping.`)
			return false
		}
		const existing = this.findToolByCollision(tools.values(), tool)
		if (!existing) {
			tools.set(tool.id, tool)
			this._version++
			return true
		}
		if (existing.source === tool.source) return false
		if ((SOURCE_PRIORITY[tool.source] ?? 0) <= (SOURCE_PRIORITY[existing.source] ?? 0)) {
			Logger.warn(
				`[ToolRegistry] User tool '${tool.id}' conflicts with existing tool '${existing.id}' (source: ${existing.source}). Keeping existing.`,
			)
			return false
		}
		tools.delete(existing.id)
		tools.set(tool.id, tool)
		this._version++
		return true
	}

	private replaceSharedUserTool(
		tools: Map<string, DiscoveredTool>,
		tool: DiscoveredTool,
		enableIfNew: boolean,
	): UserToolReplacementResult {
		if (this.collidesWithBuiltin(tool)) {
			Logger.warn(`[ToolRegistry] User tool '${tool.id}' conflicts with built-in tool id/name. Skipping.`)
			return { replaced: false, enabledNewTool: false }
		}
		const existing = this.findToolByCollision(tools.values(), tool)
		if (!existing) {
			tools.set(tool.id, tool)
			if (enableIfNew) this.enabledOverrides.set(tool.id, true)
			this._version++
			return { replaced: true, enabledNewTool: enableIfNew }
		}
		if (existing.source !== tool.source && (SOURCE_PRIORITY[tool.source] ?? 0) <= (SOURCE_PRIORITY[existing.source] ?? 0)) {
			Logger.warn(
				`[ToolRegistry] User tool '${tool.id}' conflicts with existing tool '${existing.id}' (source: ${existing.source}). Keeping existing.`,
			)
			return { replaced: false, enabledNewTool: false }
		}
		const enabledOverride = this.enabledOverrides.get(existing.id)
		tools.delete(existing.id)
		tools.set(tool.id, tool)
		if (existing.id !== tool.id) this.enabledOverrides.delete(existing.id)
		if (enabledOverride !== undefined) this.enabledOverrides.set(tool.id, enabledOverride)
		this._version++
		return { replaced: true, enabledNewTool: false, previousTool: existing }
	}

	private workspaceToolsForRoot(workspaceRoot?: string): Map<string, DiscoveredTool> {
		const key = this.workspaceKey(workspaceRoot)
		this.defaultWorkspaceKey = key
		const tools = this.workspaceToolsByRoot.get(key) ?? new Map<string, DiscoveredTool>()
		this.workspaceToolsByRoot.set(key, tools)
		return tools
	}

	private workspaceToolsForModule(modulePath: string): Map<string, DiscoveredTool> {
		const normalized = path.resolve(modulePath)
		const marker = `${path.sep}.dirac${path.sep}tools${path.sep}`
		const markerIndex = normalized.lastIndexOf(marker)
		const workspaceRoot = markerIndex >= 0 ? normalized.slice(0, markerIndex) : undefined
		return this.workspaceToolsForRoot(workspaceRoot)
	}

	private workspaceKey(workspaceRoot?: string): string {
		return workspaceRoot ? path.resolve(workspaceRoot) : ""
	}

	private registerTaskTool(ownerTaskId: string, tool: DiscoveredTool): boolean {
		if (this.collidesWithBuiltin(tool)) {
			Logger.warn(`[ToolRegistry] Task tool '${tool.id}' conflicts with built-in tool id/name. Skipping.`)
			return false
		}
		const ownerTools = this.taskToolsByOwner.get(ownerTaskId) ?? new Map<string, DiscoveredTool>()
		if (this.findToolByCollision(ownerTools.values(), tool)) return false
		ownerTools.set(tool.id, tool)
		this.taskToolsByOwner.set(ownerTaskId, ownerTools)
		this._version++
		return true
	}

	private replaceTaskTool(ownerTaskId: string, tool: DiscoveredTool): boolean {
		if (this.collidesWithBuiltin(tool)) {
			Logger.warn(`[ToolRegistry] Task tool '${tool.id}' conflicts with built-in tool id/name. Skipping.`)
			return false
		}
		const ownerTools = this.taskToolsByOwner.get(ownerTaskId) ?? new Map<string, DiscoveredTool>()
		const existing = this.findToolByCollision(ownerTools.values(), tool)
		if (existing) ownerTools.delete(existing.id)
		ownerTools.set(tool.id, tool)
		this.taskToolsByOwner.set(ownerTaskId, ownerTools)
		this._version++
		return true
	}

	private overlayTaskTools(sharedTools: DiscoveredTool[], taskTools: Iterable<DiscoveredTool>): DiscoveredTool[] {
		const tools = new Map(sharedTools.map((tool) => [tool.id, tool]))
		for (const taskTool of taskTools) {
			const existing = this.findToolByCollision(tools.values(), taskTool)
			if (existing) tools.delete(existing.id)
			tools.set(taskTool.id, taskTool)
		}
		return [...tools.values()]
	}

	private isEnabledTool(tool: DiscoveredTool): boolean {
		if (tool.exposure.kind === "skill_only") return false
		if (tool.executable === false) return false
		if (tool.exposure.kind === "profile_only") return tool.source === "builtin"
		if (tool.source === "task") return true
		const override = this.enabledOverrides.get(tool.id)
		return override ?? tool.source === "builtin"
	}

	private findToolByCollision(tools: Iterable<DiscoveredTool>, tool: DiscoveredTool): DiscoveredTool | undefined {
		return Array.from(tools).find((candidate) => this.toolsCollide(candidate, tool))
	}

	private registerUserToolInto(tools: Map<string, DiscoveredTool>, tool: DiscoveredTool): boolean {
		if (this.collidesWithBuiltin(tool)) {
			return false
		}

		const existing = Array.from(tools.values()).find((candidate) => this.toolsCollide(candidate, tool))
		if (!existing) {
			tools.set(tool.id, tool)
			return true
		}

		if (existing.source === tool.source) {
			return false
		}

		const existingPriority = SOURCE_PRIORITY[existing.source] ?? 0
		const newPriority = SOURCE_PRIORITY[tool.source] ?? 0
		if (newPriority <= existingPriority) {
			return false
		}

		tools.delete(existing.id)
		tools.set(tool.id, tool)
		return true
	}


	private sameToolInventory(currentTools: Map<string, DiscoveredTool>, nextTools: Map<string, DiscoveredTool>): boolean {
		if (currentTools.size !== nextTools.size) return false
		for (const [id, currentTool] of currentTools) {
			const nextTool = nextTools.get(id)
			if (!nextTool || !this.sameDiscoveredTool(currentTool, nextTool)) return false
		}
		return true
	}

	private sameDiscoveredTool(current: DiscoveredTool, next: DiscoveredTool): boolean {
		if (
			current.id !== next.id ||
			current.name !== next.name ||
			current.source !== next.source ||
			current.modulePath !== next.modulePath ||
			JSON.stringify(current.exposure) !== JSON.stringify(next.exposure) ||
			current.executable !== next.executable
		) {
			return false
		}

		if (current.sourceHash !== undefined || next.sourceHash !== undefined) {
			return current.sourceHash === next.sourceHash
		}

		return current.factory === next.factory && current.spec === next.spec
	}

	private getTool(toolId: string): DiscoveredTool | undefined {
		const defaultWorkspaceTool = this.workspaceToolsByRoot.get(this.defaultWorkspaceKey)?.get(toolId)
		if (defaultWorkspaceTool) return defaultWorkspaceTool
		const globalTool = this.builtinTools.get(toolId) ?? this.userTools.get(toolId)
		if (globalTool) return globalTool
		for (const tools of this.workspaceToolsByRoot.values()) {
			const tool = tools.get(toolId)
			if (tool) return tool
		}
		return undefined
	}

	private assertConfigurable(toolId: string): void {
		const tool = this.getTool(toolId)
		if (!tool || tool.exposure.kind === "configurable") return
		throw new Error(
			`Tool '${toolId}' (${tool.exposure.kind}) cannot be enabled or disabled directly.`,
		)
	}

	private findToolByIdOrName(toolName: string): DiscoveredTool | undefined {
		return this.getAllTools().find((tool) => tool.id === toolName || tool.name === toolName || tool.spec.name === toolName)
	}

	private collidesWithBuiltin(tool: DiscoveredTool): boolean {
		return (
			[...this.toolIdentifiers(tool)].some((id) => id in LEGACY_RESPONSE_TOOLS) ||
			Array.from(this.builtinTools.values()).some((builtin) => this.toolsCollide(builtin, tool))
		)
	}


	private toolIdentifiers(tool: DiscoveredTool): Set<string> {
		return new Set([tool.id, tool.name, tool.spec.name].filter(Boolean))
	}

	private toolsCollide(a: DiscoveredTool, b: DiscoveredTool): boolean {
		const aIds = this.toolIdentifiers(a)
		const bIds = this.toolIdentifiers(b)
		return [...aIds].some((id) => bIds.has(id))
	}

}
