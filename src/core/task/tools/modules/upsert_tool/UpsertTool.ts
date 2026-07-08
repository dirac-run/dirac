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
	ToolScope, upsert_tool_spec,
	resolveTaskToolDir,
	buildManifest
} from "./constants"
import { spawnBuilderSubagent } from "./subagent-builder"
import { buildScaffoldedToolSource, writeTestHarness } from "./scaffold-generator"

export { upsert_tool_spec }

export class UpsertTool implements IDiracTool {
	spec(): DiracToolSpec {
		return upsert_tool_spec
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(args: any, env: IToolEnvironment): Promise<any> {
		const { tools } = args ?? {}

		// --- Validate tools array ---
		if (!Array.isArray(tools) || tools.length === 0) {
			return "❌ Missing required parameter: tools (must be a non-empty array of tool definitions)."
		}

		const errors: string[] = []
		for (let i = 0; i < tools.length; i++) {
			const t = tools[i]
			const prefix = `tools[${i}]`
			if (!t.name || typeof t.name !== "string") errors.push(`${prefix}: Missing required field: name`)
			if (!t.scope || !["global", "workspace", "task"].includes(t.scope)) errors.push(`${prefix}: scope must be 'global', 'workspace', or 'task'`)
			if (!t.description || typeof t.description !== "string") errors.push(`${prefix}: Missing required field: description`)
			if (!t.requirements || typeof t.requirements !== "string") errors.push(`${prefix}: Missing required field: requirements`)
			if (!/^[a-z][a-z0-9_]*$/.test(t.name || "")) errors.push(`${prefix}: name must be a snake_case identifier`)
		}

		if (errors.length > 0) {
			return `❌ Validation errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`
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

		// --- Prepare all tools: resolve dirs, write manifests, scaffolds, test harnesses ---
		interface PreparedTool {
			name: string
			scope: ToolScope
			description: string
			parameters: any[]
			requirements: string
			toolDir: string
		}
		const prepared: PreparedTool[] = []

		for (const t of tools) {
			const { name, scope, description, parameters, requirements } = t

			// Resolve tool directory
			let toolDir: string
			try {
				if (scope === "task") {
					const taskId = env.config.taskId
					if (!taskId) {
						await updateProgress(`[${name}] Failed`, "no taskId for task-scoped tool", CardStatus.ERROR)
						continue
					}
					toolDir = await resolveTaskToolDir(name, taskId)
				} else {
					const home = process.env.DIRAC_DIR || path.join(process.env.HOME || "~", ".dirac")
					if (scope === "global") {
						toolDir = path.join(home, "tools", name)
					} else {
						toolDir = path.join(env.config.cwd, ".dirac", "tools", name)
					}
				}
				await updateProgress(`[${name}] Resolved directory`, toolDir)
			} catch (error) {
				await updateProgress(`[${name}] Failed`, `directory resolution: ${error instanceof Error ? error.message : String(error)}`, CardStatus.ERROR)
				continue
			}

			// Write manifest
			try {
				await fs.mkdir(toolDir, { recursive: true })
				const manifest = buildManifest(name, scope)
				await fs.writeFile(path.join(toolDir, "dirac-tool.json"), JSON.stringify(manifest, null, 2), "utf8")
				await updateProgress(`[${name}] Wrote manifest`, toolDir)
			} catch (error) {
				await updateProgress(`[${name}] Failed`, `manifest: ${error instanceof Error ? error.message : String(error)}`, CardStatus.ERROR)
				continue
			}

			// Write test harness
			try {
				await writeTestHarness(toolDir)
				await updateProgress(`[${name}] Wrote test harness`, toolDir)
			} catch (error) {
				await updateProgress(`[${name}] Failed`, `test harness: ${error instanceof Error ? error.message : String(error)}`, CardStatus.ERROR)
				continue
			}

			// Scaffold tool.ts
			try {
				const scaffoldSource = buildScaffoldedToolSource(name, description, parameters)
				await fs.writeFile(path.join(toolDir, "tool.ts"), scaffoldSource, "utf8")
				await updateProgress(`[${name}] Scaffolded tool.ts`, "boilerplate written")
			} catch (error) {
				await updateProgress(`[${name}] Failed`, `scaffold: ${error instanceof Error ? error.message : String(error)}`, CardStatus.ERROR)
				continue
			}

			prepared.push({ name, scope, description, parameters, requirements, toolDir })
		}

		if (prepared.length === 0) {
			await progressCard.finalize(CardStatus.ERROR)
			return "❌ All tools failed during preparation. Check the progress card for details."
		}

		await updateProgress("Spawning builders", `${prepared.length} subagent(s) in parallel`)

		// --- Spawn all builder subagents in parallel ---
		const buildResults = await Promise.allSettled(
			prepared.map((t) =>
				spawnBuilderSubagent(env, t.name, t.scope, t.description, t.parameters, t.requirements, t.toolDir, updateProgress),
			),
		)

		// --- Load & register all successful tools ---
		const outcomeLines: string[] = []
		const taskScopedToolIds = new Set(env.orchestration.getTaskState("taskScopedToolIds"))
		let hasFailure = false

		for (let i = 0; i < prepared.length; i++) {
			const t = prepared[i]
			const buildResult = buildResults[i]

			// Check if build failed
			if (buildResult.status === "rejected") {
				outcomeLines.push(`❌ Tool '${t.name}' failed: ${buildResult.reason?.message || "subagent crashed"}`)
				hasFailure = true
				continue
			}
			if (buildResult.value) {
				outcomeLines.push(`❌ Tool '${t.name}' failed: ${buildResult.value}`)
				hasFailure = true
				continue
			}

			// Load
			await updateProgress(`[${t.name}] Loading`, "compile/import")
			const loadResult = await UserToolLoader.loadWithDiagnostics(t.toolDir, t.scope)
			if (loadResult.error) {
				Logger.verbose(`[UpsertTool] Tool load error: ${loadResult.error}, dir: ${t.toolDir}`)
				outcomeLines.push(`❌ Tool '${t.name}' failed to load: ${loadResult.error}`)
				hasFailure = true
				continue
			}

			const tool = loadResult.tool!
			await updateProgress(`[${t.name}] Loaded`, "passed")

			// Register
			const registry = ToolRegistry.getInstance()
			registry.removeUserTool(t.name)
			if (!registry.registerUserTool(tool)) {
				outcomeLines.push(`❌ Tool '${t.name}' loaded but failed to register (conflicts with a built-in tool).`)
				hasFailure = true
				continue
			}
			registry.enable(t.name)
			Logger.info(`[UpsertTool] Registered and enabled '${t.name}' (source: ${t.scope}, registryVersion: ${registry.getVersion()})`)

			if (t.scope === "task" && env.config.taskId) {
				taskScopedToolIds.add(t.name)
			}

			const paramHint = Array.isArray(t.parameters) ? t.parameters.map((p: any) => p.name).join(", ") : ""
			outcomeLines.push(`✅ Tool '${t.name}' is ready. Invoke it by calling '${t.name}' as a tool function with: ${paramHint}`)
		}

		if (env.config.taskId) {
			env.orchestration.setTaskState("taskScopedToolIds", [...taskScopedToolIds])
		}

		const successCount = outcomeLines.filter((l) => l.startsWith("✅")).length
		await updateProgress("Complete", `${successCount}/${tools.length} tools ready`, hasFailure ? CardStatus.ERROR : CardStatus.SUCCESS)
		await progressCard.finalize(hasFailure ? CardStatus.ERROR : CardStatus.SUCCESS)

		return outcomeLines.join("\n")
	}
}
