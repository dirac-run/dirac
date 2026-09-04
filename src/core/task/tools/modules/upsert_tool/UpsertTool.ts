import { CardStatus } from "@shared/ExtensionMessage"
import { allocateSubagentIdentity, type SubagentIdentity } from "@shared/subagents"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { getErrorMessage } from "@/shared/errors"
import { Logger } from "@/shared/services/Logger"
import { DiracToolSpec } from "@/shared/tools"
import { UserToolLoader } from "../../discovery/UserToolLoader"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { ToolRegistry } from "../../registry/ToolRegistry"
import { validateStagedTool } from "./builder-validation"
import {
	buildManifest,
	resolveTaskToolDir,
	ToolScope,
	upsert_tool_spec,
} from "./constants"
import { buildToolWithRepairs } from "./subagent-builder"
import { buildScaffoldedToolSource, writeTestHarness } from "./scaffold-generator"
import {
	commitToolPromotion,
	createToolStagingDirectory,
	discardStagedTool,
	promoteStagedTool,
	rollbackToolPromotion,
	ToolPromotion
} from "./tool-lifecycle"

export { upsert_tool_spec }

interface PreparedTool {
	name: string
	scope: ToolScope
	description: string
	parameters: any[]
	requirements: string
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
		if (validationError) return validationError

		const progressLines: string[] = []
		const progressCard = await env.ui.createCard({
			header: `Building ${tools.length} tool${tools.length > 1 ? "s" : ""}`,
			status: CardStatus.RUNNING,
			collapsed: false,
			body: "Starting tool creation...",
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

		await updateProgress("Validating request", `${tools.length} tool(s) passed validation`)
		const newlyEnabledToolIds = new Set<string>()
		const activatedTools: ActivatedTool[] = []
		let activationRolledBack = false
		let outcome: ToolBuildOutcome
		try {
			outcome = await env.config.callbacks.withMutationAuthorization(upsert_tool_spec.id, async () => {
				const buildOutcome = await buildAndActivateTools(
					tools,
					env,
					updateProgress,
					newlyEnabledToolIds,
					activatedTools,
				)
				await env.config.callbacks.transitionFromMutation(async () => {
					try {
						await env.config.callbacks.commitEnabledToolToggles([...newlyEnabledToolIds], () =>
							commitActivatedTools(activatedTools, env),
						)
					} catch (error) {
						try {
							activationRolledBack = true
							await rollbackActivatedTools(activatedTools)
						} catch (rollbackError) {
							throw new AggregateError([error, rollbackError], "Tool activation and rollback both failed")
						}
						throw error
					}
				})
				return buildOutcome
			})
		} catch (error) {
			if (activatedTools.length > 0 && !activationRolledBack) {
				try {
					await rollbackActivatedTools(activatedTools)
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "Tool activation and rollback both failed")
				}
			}
			await updateProgress("Failed", getErrorMessage(error), CardStatus.ERROR)
			await progressCard.finalize(CardStatus.ERROR)
			throw error
		}

		const successCount = outcome.outcomeLines.filter((line) => line.startsWith("✓")).length
		const finalStatus = outcome.hasFailure ? CardStatus.ERROR : CardStatus.SUCCESS
		await updateProgress("Complete", `${successCount}/${tools.length} tools ready`, finalStatus)
		await progressCard.finalize(finalStatus)
		return outcome.outcomeLines.join("\n")
	}
}

interface ToolBuildOutcome {
	outcomeLines: string[]
	hasFailure: boolean
}

async function buildAndActivateTools(
	tools: any[],
	env: IToolEnvironment,
	updateProgress: (phase: string, detail?: string, status?: CardStatus) => Promise<void>,
	newlyEnabledToolIds: Set<string>,
	activatedTools: ActivatedTool[],
): Promise<ToolBuildOutcome> {
	const prepared: PreparedTool[] = []
	const outcomeLines: string[] = []
	let hasFailure = false
	const reservedBuilderIdentities: SubagentIdentity[] = []
	const allocateBuilderIdentity = (): SubagentIdentity => {
		const identity = allocateSubagentIdentity(env.orchestration.getHistory(), reservedBuilderIdentities)
		reservedBuilderIdentities.push(identity)
		return identity
	}

	for (const definition of tools) {
		const preparation = await prepareTool(definition, env, updateProgress)
		if (typeof preparation === "string") {
			outcomeLines.push(`❌ Tool '${definition.name}' failed: ${preparation}`)
			hasFailure = true
			continue
		}
		prepared.push(preparation)
	}

	if (prepared.length > 0) await updateProgress("Spawning builders", `${prepared.length} subagent(s) in parallel`)
	const buildResults = await Promise.allSettled(
		prepared.map((tool) =>
			buildToolWithRepairs(
				env,
				{
					name: tool.name,
					scope: tool.scope,
					description: tool.description,
					parameters: tool.parameters,
					requirements: tool.requirements,
					toolDir: tool.stagingDir,
				},
				async () => (await validateStagedTool(env, tool.stagingDir, tool.scope)).error,
				updateProgress,
				allocateBuilderIdentity,
			),
		),
	)

	for (let index = 0; index < prepared.length; index++) {
		const tool = prepared[index]
		const buildResult = buildResults[index]
		const buildError = buildResult.status === "rejected" ? getErrorMessage(buildResult.reason) : buildResult.value
		if (buildError) {
			await discardStagedTool(tool.stagingDir)
			outcomeLines.push(`❌ Tool '${tool.name}' failed: ${buildError}`)
			hasFailure = true
			continue
		}

		const activationError = await promoteAndActivateTool(
			tool,
			env,
			updateProgress,
			newlyEnabledToolIds,
			activatedTools,
		)
		if (activationError) {
			outcomeLines.push(`❌ Tool '${tool.name}' failed: ${activationError}`)
			hasFailure = true
			continue
		}

		const paramHint = tool.parameters.map((parameter: any) => parameter.name).join(", ")
		outcomeLines.push(
			`✓ Tool '${tool.name}' is ready. Invoke it by calling '${tool.name}' as a tool function with: ${paramHint}`,
		)
	}

	return { outcomeLines, hasFailure }
}

async function prepareTool(
	definition: any,
	env: IToolEnvironment,
	updateProgress: (phase: string, detail?: string, status?: CardStatus) => Promise<void>,
): Promise<PreparedTool | string> {
	const { name, scope, description, parameters, requirements } = definition
	let finalDir: string
	let stagingDir: string | undefined

	try {
		finalDir = await resolveToolDirectory(name, scope, env)
		await updateProgress(`[${name}] Resolved directory`, finalDir)
		stagingDir = await createToolStagingDirectory(finalDir)

		const manifest = buildManifest(name, scope)
		await fs.writeFile(path.join(stagingDir, "dirac-tool.json"), JSON.stringify(manifest, null, 2), "utf8")
		await writeTestHarness(stagingDir)
		await fs.writeFile(path.join(stagingDir, "tool.ts"), buildScaffoldedToolSource(name, description, parameters), "utf8")
		await updateProgress(`[${name}] Prepared staging directory`, stagingDir)

		return { name, scope, description, parameters, requirements, finalDir, stagingDir }
	} catch (error) {
		if (stagingDir) {
			await discardStagedTool(stagingDir)
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
		dir = await resolveTaskToolDir(name, env.config.taskId)
	} else {
		const home = process.env.DIRAC_DIR || path.join(os.homedir(), ".dirac")
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
		if (loadResult.error) {
			throw new Error(`promoted tool failed to load: ${loadResult.error}`)
		}

		const loadedTool = prepared.scope === "task"
			? { ...loadResult.tool!, ownerTaskId: env.config.taskId }
			: loadResult.tool!
		const workspaceRoot = env.config.workspaceManager?.getPrimaryRoot()?.path ?? env.config.cwd
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
		const failure = getErrorMessage(error)
		if (!promotion) {
			await discardStagedTool(prepared.stagingDir)
			return failure
		}

		try {
			await rollbackToolPromotion(promotion)
			await updateProgress(`[${prepared.name}] Rolled back`, "previous tool restored", CardStatus.ERROR)
			return failure
		} catch (rollbackError) {
			const rollbackFailure = getErrorMessage(rollbackError)
			return `${failure}; rollback also failed: ${rollbackFailure}`
		}
	}
	const registryVersion = await ToolRegistry.withExclusiveAccess((registry) => registry.getVersion())
	Logger.info(`[UpsertTool] Registered and enabled '${prepared.name}' (source: ${prepared.scope}, registryVersion: ${registryVersion})`)
	await updateProgress(`[${prepared.name}] Activated`, "promotion and registration passed")
	return undefined
}

async function commitActivatedTools(activatedTools: readonly ActivatedTool[], env: IToolEnvironment): Promise<void> {
	for (const activated of activatedTools) {
		try {
			await commitToolPromotion(activated.promotion)
		} catch (error) {
			Logger.warn(`[UpsertTool] Failed to remove backup for '${activated.prepared.name}'.`, error)
		}
	}
	if (!env.config.taskId) return
	const taskScopedToolIds = new Set(env.orchestration.getTaskState("taskScopedToolIds"))
	for (const activated of activatedTools) {
		if (activated.prepared.scope === "task") taskScopedToolIds.add(activated.prepared.name)
	}
	env.orchestration.setTaskState("taskScopedToolIds", [...taskScopedToolIds])
}

async function rollbackActivatedTools(activatedTools: readonly ActivatedTool[]): Promise<void> {
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
	if (errors.length > 0) throw new AggregateError(errors, "Failed to roll back activated tools")
}


function validateToolDefinitions(tools: unknown): string | undefined {
	if (!Array.isArray(tools) || tools.length === 0) {
		return "❌ Missing required parameter: tools (must be a non-empty array of tool definitions)."
	}

	const errors: string[] = []
	const seenNames = new Map<string, number>() // name -> first index
	for (let index = 0; index < tools.length; index++) {
		const tool = tools[index]
		const prefix = `tools[${index}]`
		if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
			errors.push(`${prefix}: tool definition must be an object`)
			continue
		}
		if (!tool.name || typeof tool.name !== "string") {
			errors.push(`${prefix}: Missing required field: name`)
		} else {
			// Reject duplicate names within the same call — they would race on finalDir
			const firstIndex = seenNames.get(tool.name)
			if (firstIndex !== undefined) {
				errors.push(`${prefix}: duplicate name '${tool.name}' (already used at tools[${firstIndex}])`)
			} else {
				seenNames.set(tool.name, index)
			}
		}
		if (!tool.scope || !["global", "workspace", "task"].includes(tool.scope)) errors.push(`${prefix}: scope must be 'global', 'workspace', or 'task'`)
		if (!tool.description || typeof tool.description !== "string") errors.push(`${prefix}: Missing required field: description`)
		if (!tool.requirements || typeof tool.requirements !== "string") errors.push(`${prefix}: Missing required field: requirements`)
		if (!Array.isArray(tool.parameters)) errors.push(`${prefix}: parameters must be an array`)
		if (!/^[a-z][a-z0-9_]*$/.test(tool.name || "")) errors.push(`${prefix}: name must be a snake_case identifier`)
	}

	return errors.length > 0
		? `❌ Validation errors:\n${errors.map((error) => `  - ${error}`).join("\n")}`
		: undefined
}
