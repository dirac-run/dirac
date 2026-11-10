import { CardStatus } from "@shared/ExtensionMessage"
import * as fs from "fs/promises"
import * as path from "path"
import { diracHomeDir } from "@/shared/config/environment"
import { getErrorMessage } from "@/shared/errors"
import { Logger } from "@/shared/services/Logger"
import { DiracToolSpec } from "@/shared/tools"
import { getTaskScopedStateKey } from "@shared/taskletId"
import { UserToolLoader } from "../../discovery/UserToolLoader"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { ToolRegistry } from "../../registry/ToolRegistry"
import { parseSmokeArguments, validateImplementationBody, validateStagedTool } from "./builder-validation"
import {
	buildManifest,
	resolveTaskToolDir,
	SMOKE_ARGS_FILE,
	ToolScope,
	upsert_tool_spec,
} from "./constants"
import { buildToolSource, writeTestHarness } from "./scaffold-generator"
import {
	commitToolPromotion,
	createToolStagingDirectory,
	discardStagedTool,
	promoteStagedTool,
	rollbackToolPromotion,
	ToolPromotion,
} from "./tool-lifecycle"

export { upsert_tool_spec }

interface PreparedTool {
	name: string
	scope: ToolScope
	description: string
	parameters: NonNullable<DiracToolSpec["parameters"]>
	finalDir: string
	stagingDir: string
}

interface ActivatedTool {
	prepared: PreparedTool
	loadedTool: NonNullable<Awaited<ReturnType<typeof UserToolLoader.loadWithDiagnostics>>["tool"]>
	promotion: ToolPromotion
	previousTool?: NonNullable<Awaited<ReturnType<typeof UserToolLoader.loadWithDiagnostics>>["tool"]>
	enabledNewTool: boolean
	workspaceRoot: string
}

export class UpsertTool implements IDiracTool {
	spec(): DiracToolSpec {
		return upsert_tool_spec
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(args: any, env: IToolEnvironment): Promise<any> {
		const { tools } = args ?? {}
		const validationError = validateToolDefinitions(tools)
		if (validationError) {
			env.orchestration.reportFailure()
			return validationError
		}

		const progressLines: string[] = []
		const progressCard = await env.ui.createCard({
			header: `Installing ${tools.length} tool${tools.length > 1 ? "s" : ""}`,
			status: CardStatus.RUNNING,
			collapsed: false,
			body: "Starting tool installation...",
		})
		const updateProgress = async (phase: string, detail?: string, status = CardStatus.RUNNING) => {
			const line = detail ? `${phase}: ${detail}` : phase
			progressLines.push(line)
			if (progressLines.length > 40) progressLines.shift()
			await progressCard.update({
				status,
				body: progressLines.map((entry) => `- ${entry}`).join("\n"),
				renderType: "markdown",
			})
		}

		const newlyEnabledToolIds = new Set<string>()
		const activatedTools: ActivatedTool[] = []
		let activationRolledBack = false
		let activationCommitted = false
		let previousTaskScopedToolIds: string[] | undefined
		let outcome: ToolBuildOutcome
		try {
			await updateProgress("Validating request", `${tools.length} tool(s) passed validation`)
			outcome = await env.config.callbacks.withMutationAuthorization(upsert_tool_spec.id, async () => {
				const buildOutcome = await buildAndActivateTools(tools, env, updateProgress, newlyEnabledToolIds, activatedTools)
				await env.config.callbacks.transitionFromMutation(async () => {
					try {
						await env.config.callbacks.commitEnabledToolToggles([...newlyEnabledToolIds], async () => {
							if (activatedTools.some((tool) => tool.prepared.scope === "task")) {
								previousTaskScopedToolIds = [...(env.orchestration.getTaskState("taskScopedToolIds") ?? [])]
							}
							await commitActivatedTools(activatedTools, env)
						})
					} catch (error) {
						activationRolledBack = true
						try {
							await rollbackActivatedTools(activatedTools, env, previousTaskScopedToolIds)
						} catch (rollbackError) {
							throw new AggregateError([error, rollbackError], "Tool activation and rollback both failed")
						}
						throw error
					}
					activationCommitted = true
					await discardPromotionBackups(activatedTools)
				})
				return buildOutcome
			})
		} catch (error) {
			let failure = error
			if (activatedTools.length > 0 && !activationRolledBack && !activationCommitted) {
				try {
					await rollbackActivatedTools(activatedTools, env, previousTaskScopedToolIds)
				} catch (rollbackError) {
					failure = new AggregateError([error, rollbackError], "Tool activation and rollback both failed")
				}
			}
			await updateProgress("Failed", getErrorMessage(failure), CardStatus.ERROR)
			await progressCard.finalize(CardStatus.ERROR)
			throw failure
		}

		const registry = ToolRegistry.getInstance()
		const outcomeLines = outcome.results.map((result) => {
			if (typeof result === "string") return result
			if (result.scope !== "task" && !registry.isEnabled(result.name)) {
				return `✓ Tool '${result.name}' is installed but disabled; enable it in tool settings before invoking it.`
			}
			const paramHint = result.parameters.map((parameter) => parameter.name).join(", ")
			return `✓ Tool '${result.name}' is ready. Invoke it by calling '${result.name}' as a tool function with: ${paramHint}`
		})
		if (outcome.hasFailure && activatedTools.length === 0) env.orchestration.reportFailure()
		const finalStatus = outcome.hasFailure ? CardStatus.ERROR : CardStatus.SUCCESS
		await updateProgress("Complete", `${activatedTools.length}/${tools.length} tools installed`, finalStatus)
		await progressCard.finalize(finalStatus)
		return outcomeLines.join("\n")
	}
}

interface ToolBuildOutcome {
	results: Array<string | PreparedTool>
	hasFailure: boolean
}

async function buildAndActivateTools(
	tools: any[],
	env: IToolEnvironment,
	updateProgress: (phase: string, detail?: string, status?: CardStatus) => Promise<void>,
	newlyEnabledToolIds: Set<string>,
	activatedTools: ActivatedTool[],
): Promise<ToolBuildOutcome> {
	const results: ToolBuildOutcome["results"] = []
	let hasFailure = false

	for (const definition of tools) {
		const preparation = await prepareTool(definition, env, updateProgress)
		if (typeof preparation === "string") {
			results.push(`❌ Tool '${definition.name}' failed: ${preparation}`)
			hasFailure = true
			continue
		}

		const tool = preparation
		try {
			await updateProgress(`[${tool.name}] Validating`, "compilation and smoke test")
			const validation = await validateStagedTool(env, tool.stagingDir, tool.scope)
			if (validation.error) {
				results.push(`❌ Tool '${tool.name}' failed validation: ${validation.error} Repair implementation or smoke_args and call upsert_tool again.`)
				hasFailure = true
				continue
			}

			const activationError = await promoteAndActivateTool(tool, env, updateProgress, newlyEnabledToolIds, activatedTools)
			if (activationError) {
				results.push(`❌ Tool '${tool.name}' failed activation: ${activationError}`)
				hasFailure = true
				continue
			}

			results.push(tool)
		} finally {
			await discardStagedTool(tool.stagingDir)
		}
	}

	return { results, hasFailure }
}

async function prepareTool(
	definition: any,
	env: IToolEnvironment,
	updateProgress: (phase: string, detail?: string, status?: CardStatus) => Promise<void>,
): Promise<PreparedTool | string> {
	const { name, scope, description, parameters, implementation, smoke_args } = definition
	let stagingDir: string | undefined

	try {
		const finalDir = await resolveToolDirectory(name, scope, env)
		await updateProgress(`[${name}] Resolved directory`, finalDir)
		stagingDir = await createToolStagingDirectory(finalDir)

		const manifest = buildManifest(name, scope, description, parameters)
		await fs.writeFile(path.join(stagingDir, "dirac-tool.json"), JSON.stringify(manifest, null, 2), "utf8")
		await fs.writeFile(path.join(stagingDir, "tool.ts"), buildToolSource(name, description, parameters, implementation), "utf8")
		await fs.writeFile(path.join(stagingDir, SMOKE_ARGS_FILE), smoke_args, "utf8")
		await writeTestHarness(stagingDir)
		await updateProgress(`[${name}] Prepared staging directory`, stagingDir)

		return { name, scope, description, parameters, finalDir, stagingDir }
	} catch (error) {
		if (stagingDir) {
			try {
				await discardStagedTool(stagingDir)
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], `Tool '${name}' preparation and staging cleanup both failed`)
			}
		}
		const message = getErrorMessage(error)
		await updateProgress(`[${name}] Failed`, `preparation: ${message}`, CardStatus.ERROR)
		return `preparation failed: ${message}`
	}
}

async function resolveToolDirectory(name: string, scope: ToolScope, env: IToolEnvironment): Promise<string> {
	let dir: string
	if (scope === "task") {
		if (!env.config.taskId) {
			throw new Error("no taskId for task-scoped tool")
		}
		dir = await resolveTaskToolDir(name, env.config.storageAddress ?? env.config.taskId)
	} else {
		const home = diracHomeDir()
		dir = scope === "global"
			? path.join(home, "tools", name)
			: path.join(env.config.cwd, ".dirac", "tools", name)
	}

	// Validate the resolved path structure: must be <base>/tools/<name>
	const resolved = path.resolve(dir)
	const parentDir = path.dirname(resolved)
	if (path.basename(parentDir) !== "tools" || path.basename(resolved) !== name) {
		throw new Error(`Resolved tool directory '${resolved}' does not follow expected <base>/tools/<name> structure`)
	}
	return dir
}

async function promoteAndActivateTool(
	prepared: PreparedTool,
	env: IToolEnvironment,
	updateProgress: (phase: string, detail?: string, status?: CardStatus) => Promise<void>,
	newlyEnabledToolIds: Set<string>,
	activatedTools: ActivatedTool[],
): Promise<string | undefined> {
	let promotion: ToolPromotion | undefined

	try {
		await updateProgress(`[${prepared.name}] Promoting`, prepared.finalDir)
		promotion = await promoteStagedTool(prepared.stagingDir, prepared.finalDir)

		const loadResult = await UserToolLoader.loadWithDiagnostics(prepared.finalDir, prepared.scope)
		if (loadResult.error || !loadResult.tool) {
			throw new Error(`promoted tool failed to load: ${loadResult.error ?? "loader returned no tool"}`)
		}

		const loadedTool = prepared.scope === "task"
			? { ...loadResult.tool, ownerTaskId: getTaskScopedStateKey(env.config.taskId, env.config.storageAddress) }
			: loadResult.tool
		const workspaceRoot = env.config.workspaceManager?.getPrimaryRoot()?.path ?? env.config.cwd
		await updateProgress(`[${prepared.name}] Registering`, "promotion and loading passed")
		const replacement = await ToolRegistry.withExclusiveAccess((registry) =>
			registry.replaceUserToolWithResult(loadedTool, true, workspaceRoot),
		)
		if (!replacement.replaced) {
			throw new Error("loaded but failed to replace the registry entry because of a tool conflict")
		}
		if (replacement.enabledNewTool) newlyEnabledToolIds.add(loadedTool.id)
		activatedTools.push({
			prepared,
			loadedTool,
			promotion,
			previousTool: replacement.previousTool,
			enabledNewTool: replacement.enabledNewTool,
			workspaceRoot,
		})
	} catch (error) {
		if (!promotion) return getErrorMessage(error)
		try {
			await rollbackToolPromotion(promotion)
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], `Tool '${prepared.name}' activation and rollback both failed`)
		}
		await updateProgress(`[${prepared.name}] Rolled back`, "previous tool restored", CardStatus.ERROR)
		return getErrorMessage(error)
	}
	return undefined
}

async function commitActivatedTools(activatedTools: readonly ActivatedTool[], env: IToolEnvironment): Promise<void> {
	const taskTools = activatedTools.filter((tool) => tool.prepared.scope === "task")
	if (taskTools.length === 0) return
	const taskScopedToolIds = new Set(env.orchestration.getTaskState("taskScopedToolIds"))
	for (const activated of taskTools) taskScopedToolIds.add(activated.prepared.name)
	env.orchestration.setTaskState("taskScopedToolIds", [...taskScopedToolIds])
}

// Backups are disposable only after all authoritative activation bookkeeping succeeds.
async function discardPromotionBackups(activatedTools: readonly ActivatedTool[]): Promise<void> {
	for (const activated of activatedTools) {
		try {
			await commitToolPromotion(activated.promotion)
		} catch (error) {
			Logger.warn(`[UpsertTool] Failed to remove backup for '${activated.prepared.name}'.`, error)
		}
	}
}

async function rollbackActivatedTools(
	activatedTools: readonly ActivatedTool[],
	env: IToolEnvironment,
	previousTaskScopedToolIds?: string[],
): Promise<void> {
	const errors: unknown[] = []
	for (const activated of [...activatedTools].reverse()) {
		try {
			await ToolRegistry.withExclusiveAccess((registry) =>
				registry.rollbackUserToolReplacement(
					activated.loadedTool,
					activated.previousTool,
					activated.enabledNewTool,
					activated.workspaceRoot,
				),
			)
		} catch (error) {
			errors.push(error)
		}
		try {
			await rollbackToolPromotion(activated.promotion)
		} catch (error) {
			errors.push(error)
		}
	}
	if (previousTaskScopedToolIds !== undefined) {
		try {
			env.orchestration.setTaskState("taskScopedToolIds", previousTaskScopedToolIds)
		} catch (error) {
			errors.push(error)
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, "Failed to roll back activated tools")
}


function validateToolDefinitions(tools: unknown): string | undefined {
	if (!Array.isArray(tools) || tools.length === 0) {
		return "❌ Missing required parameter: tools (must be a non-empty array of tool definitions)."
	}

	const errors: string[] = []
	const seenNames = new Map<string, number>()
	for (let index = 0; index < tools.length; index++) {
		const tool = tools[index]
		const prefix = `tools[${index}]`
		if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
			errors.push(`${prefix}: tool definition must be an object`)
			continue
		}
		if (typeof tool.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(tool.name)) {
			errors.push(`${prefix}: name must be a snake_case identifier`)
		} else {
			const firstIndex = seenNames.get(tool.name)
			if (firstIndex !== undefined) {
				errors.push(`${prefix}: duplicate name '${tool.name}' (already used at tools[${firstIndex}])`)
			} else {
				seenNames.set(tool.name, index)
			}
		}
		if (!["global", "workspace", "task"].includes(tool.scope)) errors.push(`${prefix}: scope must be 'global', 'workspace', or 'task'`)
		if (typeof tool.description !== "string" || !tool.description.trim()) errors.push(`${prefix}: description must be a non-empty string`)
		if (typeof tool.implementation !== "string" || !tool.implementation.trim()) {
			errors.push(`${prefix}: implementation must be a non-empty async processCall function body`)
		} else {
			const implementationError = validateImplementationBody(tool.implementation)
			if (implementationError) errors.push(`${prefix}: ${implementationError}`)
		}
		if (typeof tool.smoke_args !== "string") {
			errors.push(`${prefix}: smoke_args must be a JSON-encoded object string, e.g. '{"path":"src"}'`)
		} else {
			try {
				parseSmokeArguments(tool.smoke_args)
			} catch (error) {
				errors.push(`${prefix}: ${getErrorMessage(error)}`)
			}
		}
		if (!Array.isArray(tool.parameters)) {
			errors.push(`${prefix}: parameters must be an array`)
			continue
		}
		const parameterNames = new Set<string>()
		for (let parameterIndex = 0; parameterIndex < tool.parameters.length; parameterIndex++) {
			const parameter = tool.parameters[parameterIndex]
			const parameterPrefix = `${prefix}.parameters[${parameterIndex}]`
			if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) {
				errors.push(`${parameterPrefix}: parameter must be an object`)
				continue
			}
			if (typeof parameter.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(parameter.name)) {
				errors.push(`${parameterPrefix}: name must be a snake_case identifier`)
			} else if (parameterNames.has(parameter.name)) {
				errors.push(`${parameterPrefix}: duplicate parameter name '${parameter.name}'`)
			} else {
				parameterNames.add(parameter.name)
			}
			if (!["string", "boolean", "integer", "array", "object"].includes(parameter.type)) errors.push(`${parameterPrefix}: type must be string, boolean, integer, array, or object`)
			if (typeof parameter.required !== "boolean") errors.push(`${parameterPrefix}: required must be a boolean`)
			if (typeof parameter.instruction !== "string" || !parameter.instruction.trim()) errors.push(`${parameterPrefix}: instruction must be a non-empty string`)
		}
	}

	return errors.length > 0
		? `❌ Validation errors:\n${errors.map((error) => `  - ${error}`).join("\n")}`
		: undefined
}
