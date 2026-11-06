import * as fs from "fs/promises"
import * as path from "path"
import * as ts from "typescript"
import { z } from "zod"
import { getErrorMessage } from "@/shared/errors"
import { safeParseJson } from "@/shared/safe-json-parse"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { resolveCommandApproval } from "../../autoApprove"
import { ToolSkippedByUserMessage } from "../../types/ToolSkippedByUserMessage"
import type { DiscoveredTool } from "../../discovery/DiscoveredTool"
import { UserToolLoader } from "../../discovery/UserToolLoader"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { SMOKE_ARGS_FILE, SMOKE_COMPLETION_MARKER, ToolScope } from "./constants"

export interface StagedToolValidationResult {
	tool?: DiscoveredTool
	error?: string
}

// JSON parsing establishes JSON values; the schema rejects arrays, null, and primitives.
const smokeArgsSchema = z.record(z.unknown())

export function parseSmokeArguments(raw: string): Record<string, unknown> {
	return safeParseJson(smokeArgsSchema, raw, "smoke_args (must encode a JSON object)")
}

/** Checks a function-body boundary, not a sandbox for the code executed by the smoke test. */
export function validateImplementationBody(implementation: string): string | undefined {
	const prefix = "async function processCall(args: unknown, env: unknown) {\n"
	const source = `${prefix}${implementation}\n}`
	const parsed = ts.createSourceFile("implementation.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
	const diagnostics = ts.transpileModule(source, {
		fileName: "implementation.ts",
		compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
		reportDiagnostics: true,
	}).diagnostics ?? []
	const syntaxErrors = diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
	if (syntaxErrors.length > 0) {
		return `implementation must be a valid async processCall body: ${syntaxErrors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")).join("; ")}`
	}

	const declaration = parsed.statements[0]
	if (parsed.statements.length !== 1 || !declaration || !ts.isFunctionDeclaration(declaration)
		|| declaration.name?.text !== "processCall" || !declaration.body
		|| declaration.getStart(parsed) !== 0 || declaration.end !== source.length
		|| declaration.body.getStart(parsed) !== prefix.length - 2
		|| declaration.body.getLastToken(parsed)?.getStart(parsed) !== source.length - 1) {
		return "implementation must contain only the body of async processCall(args, env); do not close the wrapper or supply module-level code."
	}

	const forbiddenDeclaration = (node: ts.Node): boolean => {
		if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isExportDeclaration(node)
			|| ts.isExportAssignment(node) || ts.isImportTypeNode(node)
			|| (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))) {
			return true
		}
		return ts.forEachChild(node, forbiddenDeclaration) ?? false
	}
	if (forbiddenDeclaration(declaration.body)) {
		return "implementation must not contain import/export declarations; use await import(...) inside the body for dynamic imports."
	}
	return undefined
}

export async function validateStagedTool(
	env: IToolEnvironment,
	toolDir: string,
	scope: ToolScope,
): Promise<StagedToolValidationResult> {
	const smokeArgsError = await validateSmokeArguments(toolDir)
	if (smokeArgsError) {
		return { error: smokeArgsError }
	}

	const loadResult = await UserToolLoader.loadWithDiagnostics(toolDir, scope)
	if (loadResult.error || !loadResult.tool) {
		return { error: `Tool failed to compile or load: ${loadResult.error ?? "loader returned no tool"}` }
	}

	const harnessError = await runSmokeHarness(env, toolDir)
	if (harnessError) return { error: harnessError }

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
		parseSmokeArguments(raw)
		return undefined
	} catch (error) {
		return getErrorMessage(error)
	}
}

async function runSmokeHarness(env: IToolEnvironment, toolDir: string): Promise<string | undefined> {
	const harnessPath = path.join(toolDir, "test-harness.ts")
	const command = `npx tsx '${harnessPath.replace(/'/g, "'\\''")}'`
	if (!await approveSmokeCommand(env, command)) return "Smoke-test command was rejected by the user."
	let result
	try {
		result = await env.system.executeCommand(command, { timeout: 60_000 })
	} catch (error) {
		return `Smoke-test command failed: ${getErrorMessage(error)}`
	}
	const output = formatOutput(result.output)

	if (result.userRejected) {
		return "Smoke-test command was rejected by the user."
	}
	if (result.completed !== true) {
		return `Smoke-test command did not complete.${output ? ` Output: ${output}` : ""}`
	}
	if (result.exitCode !== 0 || result.signal) {
		return `Smoke-test harness did not exit successfully (status: ${result.exitCode ?? "unknown"}, signal: ${result.signal ?? "none"}).${output ? ` Output: ${output}` : ""}`
	}
	const rawOutput = typeof result.output === "string" ? result.output : JSON.stringify(result.output)
	if (!rawOutput?.includes(SMOKE_COMPLETION_MARKER)) {
		return `Smoke-test harness is incomplete: missing completion marker after both processCall checks.${output ? ` Output: ${output}` : ""}`
	}

	return undefined
}

async function approveSmokeCommand(env: IToolEnvironment, command: string): Promise<boolean> {
	const utilityEnabled = env.config.permissionDecisionBinding !== undefined
	const approval = resolveCommandApproval(
		[command], utilityEnabled, env.config.autoApprover, env.config.services.commandPermissionController,
	)
	if (!approval.required) return true

	const card = await env.ui.createCard({
		header: "Execute custom-tool smoke test",
		status: CardStatus.WAITING_FOR_INPUT,
		requireApproval: true,
		permissionOperation: { kind: "commands", commands: [command] },
		permissionRequestKind: utilityEnabled ? (approval.utilityEligible ? "tool" : "manual_tool") : undefined,
		renderType: "markdown",
		body: `Runs the supplied implementation with smoke_args and empty arguments. This code is not sandboxed.\n\n\`\`\`bash\n${command}\n\`\`\``,
		rawInput: { commands: [{ command, displayName: command, language: "bash" }] },
		collapsed: false,
	})
	let status = CardStatus.CANCELLED
	try {
		const interaction = await card.waitForInteraction()
		if (interaction.action === DiracAskResponse.MESSAGE) {
			if (interaction.text) await env.ui.upsertText(interaction.text, false, "user")
			status = CardStatus.SKIPPED
			return false
		}
		if (interaction.action !== DiracAskResponse.APPROVE) return false
		status = CardStatus.SUCCESS
		return true
	} catch (error) {
		if (error instanceof ToolSkippedByUserMessage) status = CardStatus.SKIPPED
		throw error
	} finally {
		await card.finalize(status)
	}
}

function formatOutput(output: unknown): string {
	const text = typeof output === "string" ? output : JSON.stringify(output)
	if (!text) return ""
	const normalized = text.trim()
	return normalized.length > 4_000 ? `${normalized.slice(0, 4_000)}…` : normalized
}

function errorMessage(error: unknown): string {
	return getErrorMessage(error)
}
