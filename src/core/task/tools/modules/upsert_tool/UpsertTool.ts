import * as fs from "fs/promises"
import * as path from "path"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracToolSpec } from "@/shared/tools"
import { UserToolLoader } from "../../discovery/UserToolLoader"
import { ToolRegistry } from "../../registry/ToolRegistry"
import { Logger } from "@/shared/services/Logger"
import { CardStatus } from "@shared/ExtensionMessage"
import {
	ToolScope,
	upsert_tool_spec,
	resolveTaskToolDir,
	buildManifest,
} from "./constants"
import { buildToolWithRepairs } from "./subagent-builder"
import { buildScaffoldedToolSource, writeTestHarness } from "./scaffold-generator"
import { validateStagedTool } from "./builder-validation"
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
	parameters: any[]
	requirements: string
	finalDir: string
	stagingDir: string
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
			return validationError
		}

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

		const prepared: PreparedTool[] = []
		const outcomeLines: string[] = []
		let hasFailure = false

		for (const definition of tools) {
			const preparation = await prepareTool(definition, env, updateProgress)
			if (typeof preparation === "string") {
				outcomeLines.push(`❌ Tool '${definition.name}' failed: ${preparation}`)
				hasFailure = true
				continue
			}
			prepared.push(preparation)
		}

		if (prepared.length > 0) {
			await updateProgress("Spawning builders", `${prepared.length} subagent(s) in parallel`)
		}

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
				),
			),
		)

		const taskScopedToolIds = new Set(env.orchestration.getTaskState("taskScopedToolIds"))
		for (let index = 0; index < prepared.length; index++) {
			const tool = prepared[index]
			const buildResult = buildResults[index]
			const buildError = buildResult.status === "rejected"
				? buildResult.reason instanceof Error ? buildResult.reason.message : String(buildResult.reason)
				: buildResult.value

			if (buildError) {
				await discardStagedTool(tool.stagingDir)
				outcomeLines.push(`❌ Tool '${tool.name}' failed: ${buildError}`)
				hasFailure = true
				continue
			}

			const activationError = await promoteAndActivateTool(tool, env, updateProgress)
			if (activationError) {
				outcomeLines.push(`❌ Tool '${tool.name}' failed: ${activationError}`)
				hasFailure = true
				continue
			}

			if (tool.scope === "task" && env.config.taskId) {
				taskScopedToolIds.add(tool.name)
			}
			const paramHint = tool.parameters.map((parameter: any) => parameter.name).join(", ")
			outcomeLines.push(`✅ Tool '${tool.name}' is ready. Invoke it by calling '${tool.name}' as a tool function with: ${paramHint}`)
		}

		if (env.config.taskId) {
			env.orchestration.setTaskState("taskScopedToolIds", [...taskScopedToolIds])
		}

		const successCount = outcomeLines.filter((line) => line.startsWith("✅")).length
		const finalStatus = hasFailure ? CardStatus.ERROR : CardStatus.SUCCESS
		await updateProgress("Complete", `${successCount}/${tools.length} tools ready`, finalStatus)
		await progressCard.finalize(finalStatus)
		return outcomeLines.join("\n")
	}
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
		const message = error instanceof Error ? error.message : String(error)
		await updateProgress(`[${name}] Failed`, `preparation: ${message}`, CardStatus.ERROR)
		return `preparation failed: ${message}`
	}
}

async function resolveToolDirectory(name: string, scope: ToolScope, env: IToolEnvironment): Promise<string> {
	if (scope === "task") {
		if (!env.config.taskId) {
			throw new Error("no taskId for task-scoped tool")
		}
		return resolveTaskToolDir(name, env.config.taskId)
	}

	const home = process.env.DIRAC_DIR || path.join(process.env.HOME || "~", ".dirac")
	return scope === "global"
		? path.join(home, "tools", name)
		: path.join(env.config.cwd, ".dirac", "tools", name)
}

async function promoteAndActivateTool(
	prepared: PreparedTool,
	env: IToolEnvironment,
	updateProgress: (phase: string, detail?: string, status?: CardStatus) => Promise<void>,
): Promise<string | undefined> {
	let promotion: ToolPromotion | undefined

	try {
		await updateProgress(`[${prepared.name}] Promoting`, prepared.finalDir)
		promotion = await promoteStagedTool(prepared.stagingDir, prepared.finalDir)

		const loadResult = await UserToolLoader.loadWithDiagnostics(prepared.finalDir, prepared.scope)
		if (loadResult.error) {
			throw new Error(`promoted tool failed to load: ${loadResult.error}`)
		}

		const registry = ToolRegistry.getInstance()
		if (!registry.replaceUserTool(loadResult.tool!, true)) {
			throw new Error("loaded but failed to replace the registry entry because of a tool conflict")
		}
	} catch (error) {
		const failure = error instanceof Error ? error.message : String(error)
		if (!promotion) {
			await discardStagedTool(prepared.stagingDir)
			return failure
		}

		try {
			await rollbackToolPromotion(promotion)
			await updateProgress(`[${prepared.name}] Rolled back`, "previous tool restored", CardStatus.ERROR)
			return failure
		} catch (rollbackError) {
			const rollbackFailure = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
			return `${failure}; rollback also failed: ${rollbackFailure}`
		}
	}

	try {
		await commitToolPromotion(promotion)
	} catch (error) {
		Logger.warn(`[UpsertTool] Failed to remove backup for '${prepared.name}'.`, error)
	}

	const registry = ToolRegistry.getInstance()
	Logger.info(`[UpsertTool] Registered and enabled '${prepared.name}' (source: ${prepared.scope}, registryVersion: ${registry.getVersion()})`)
	await updateProgress(`[${prepared.name}] Activated`, "promotion and registration passed")
	return undefined
}

function validateToolDefinitions(tools: unknown): string | undefined {
	if (!Array.isArray(tools) || tools.length === 0) {
		return "❌ Missing required parameter: tools (must be a non-empty array of tool definitions)."
	}

	const errors: string[] = []
	for (let index = 0; index < tools.length; index++) {
		const tool = tools[index]
		const prefix = `tools[${index}]`
		if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
			errors.push(`${prefix}: tool definition must be an object`)
			continue
		}
		if (!tool.name || typeof tool.name !== "string") errors.push(`${prefix}: Missing required field: name`)
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
