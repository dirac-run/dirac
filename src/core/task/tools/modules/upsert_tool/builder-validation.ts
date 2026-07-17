import * as fs from "fs/promises"
import * as path from "path"
import type { DiscoveredTool } from "../../discovery/DiscoveredTool"
import { UserToolLoader } from "../../discovery/UserToolLoader"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { SMOKE_ARGS_FILE, TOOL_IMPLEMENTATION_SENTINEL, ToolScope } from "./constants"

export interface StagedToolValidationResult {
	tool?: DiscoveredTool
	error?: string
}

export async function validateStagedTool(
	env: IToolEnvironment,
	toolDir: string,
	scope: ToolScope,
): Promise<StagedToolValidationResult> {
	const sourcePath = path.join(toolDir, "tool.ts")
	let source: string
	try {
		source = await fs.readFile(sourcePath, "utf8")
	} catch (error) {
		return { error: `Generated tool source was not found: ${errorMessage(error)}` }
	}

	if (source.includes(TOOL_IMPLEMENTATION_SENTINEL)) {
		return { error: "processCall still contains the scaffold implementation sentinel." }
	}

	const smokeArgsError = await validateSmokeArguments(toolDir)
	if (smokeArgsError) {
		return { error: smokeArgsError }
	}

	const harnessError = await runSmokeHarness(env, toolDir)
	if (harnessError) {
		return { error: harnessError }
	}

	const loadResult = await UserToolLoader.loadWithDiagnostics(toolDir, scope)
	if (loadResult.error) {
		return { error: `Generated tool failed to compile or load: ${loadResult.error}` }
	}

	return { tool: loadResult.tool }
}

async function validateSmokeArguments(toolDir: string): Promise<string | undefined> {
	const smokeArgsPath = path.join(toolDir, SMOKE_ARGS_FILE)
	let raw: string
	try {
		raw = await fs.readFile(smokeArgsPath, "utf8")
	} catch (error) {
		return `${SMOKE_ARGS_FILE} was not written: ${errorMessage(error)}`
	}

	try {
		const parsed = JSON.parse(raw)
		if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
			return `${SMOKE_ARGS_FILE} must contain a JSON object.`
		}
		return undefined
	} catch (error) {
		return `${SMOKE_ARGS_FILE} is not valid JSON: ${errorMessage(error)}`
	}
}

async function runSmokeHarness(
	env: IToolEnvironment,
	toolDir: string,
): Promise<string | undefined> {
	const harnessPath = path.join(toolDir, "test-harness.ts")
	const command = `npx tsx ${JSON.stringify(harnessPath)}`
	const result = await env.system.executeCommand(command, { timeout: 60_000 })
	const output = formatOutput(result.output)

	if (result.userRejected) {
		return "Smoke-test command was rejected by the user."
	}
	if (result.completed === false) {
		return `Smoke-test command did not complete.${output ? ` Output: ${output}` : ""}`
	}
	if (result.exitCode !== undefined && result.exitCode !== null && result.exitCode !== 0) {
		return `Smoke-test harness exited with status ${result.exitCode}.${output ? ` Output: ${output}` : ""}`
	}

	return undefined
}

function formatOutput(output: unknown): string {
	const text = typeof output === "string" ? output : JSON.stringify(output)
	if (!text) return ""
	const normalized = text.trim()
	return normalized.length > 4_000 ? `${normalized.slice(0, 4_000)}…` : normalized
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
