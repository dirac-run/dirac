import * as fs from "fs/promises"
import * as path from "path"
import { DiracDefaultTool } from "@/shared/tools"
import { CardStatus } from "@shared/ExtensionMessage"
import { SUBAGENT_DEFAULT_ALLOWED_TOOLS } from "../../subagent/SubagentBuilder"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import {
    ToolScope,
    SUBAGENT_MAX_TURNS,
    SUBAGENT_TIMEOUT_SECONDS,
    TOOL_BUILDER_SYSTEM_SUFFIX,
    TOOL_AUTHORING_CONTRACT,
} from "./constants"

export async function spawnBuilderSubagent(
	env: IToolEnvironment,
	name: string,
	scope: ToolScope,
	description: string,
	parameters: any[],
	requirements: string,
	toolDir: string,
	updateProgress: (phase: string, detail?: string, status?: CardStatus) => Promise<void>,
): Promise<string | undefined> {
	const builderAllowedTools = SUBAGENT_DEFAULT_ALLOWED_TOOLS.filter(
		(tool) => tool !== DiracDefaultTool.UPSERT_TOOL && tool !== DiracDefaultTool.USE_SUBAGENTS,
	)

	const prompt = buildSubagentPrompt(name, scope, description, parameters, requirements, toolDir)

	await updateProgress("Generating implementation", "subagent")
	const result = await env.orchestration.runSubagent(prompt, {
		subagentName: `tool_builder:${name}`,
		maxTurns: SUBAGENT_MAX_TURNS,
		timeout: SUBAGENT_TIMEOUT_SECONDS,
		allowedTools: builderAllowedTools,
		systemSuffix: TOOL_BUILDER_SYSTEM_SUFFIX,
		onUpdate: async (update) => {
			if (update.textChunk) {
				const snippet = update.textChunk.length > 200 ? update.textChunk.slice(-200) : update.textChunk
				await updateProgress("Builder output", snippet.replace(/\n/g, " ").substring(0, 150))
			}
			if (update.latestToolCall) {
				await updateProgress("Builder subagent", update.latestToolCall)
			}
			if (update.status === "completed") {
				await updateProgress("Builder subagent", "completed")
			}
			if (update.status === "failed") {
				await updateProgress("Builder subagent", update.error || "failed", CardStatus.ERROR)
			}
		},
	})

	if (result.status === "failed") {
		return `❌ Code generation failed: ${result.error || "Subagent did not complete successfully."}`
	}

	// Verify the subagent wrote tool.ts to disk
	try {
		await fs.access(path.join(toolDir, "tool.ts"))
		await updateProgress("Generated tool source", "verified on disk")
		// Verify the generated tool actually differs from the scaffold
		const generated = await fs.readFile(path.join(toolDir, "tool.ts"), "utf8")
		if (generated.includes("REPLACE THIS BLOCK")) {
			return `❌ Subagent did not implement processCall — tool.ts still contains the scaffold placeholder.\n\nTool directory: ${toolDir}`
		}
		await updateProgress("Verified implementation", "processCall implemented")
		return undefined
	} catch {
		return `❌ Subagent reported success but tool.ts was not found at ${toolDir}/tool.ts.`
	}
}

/**
 * Builds the complete prompt for the code-generation subagent.
 */
function buildSubagentPrompt(
	name: string,
	scope: ToolScope,
	description: string,
	parameters: any[],
	requirements: string,
	toolDir: string,
): string {
	return `You are a Dirac tool code generator. Your job is to implement processCall in the existing tool.ts scaffold for the Dirac coding agent.

## Tool Requirements

- **Name**: ${name}
- **Description**: ${description}
- **Requested Scope**: ${scope}
- **Parameters**: ${JSON.stringify(parameters, null, 2)}
- **Behavior**: ${requirements}

## Scope Protocol

The requested scope is **${scope}**. Treat it as immutable context.
You are not allowed to decide a different scope, write a manifest, choose a storage directory, register a tool, enable a tool, or call upsert_tool.
Only implement the processCall body in the existing tool.ts.
\`upsert_tool\` will handle validation, registration, and enabling the tool.

${TOOL_AUTHORING_CONTRACT}

## Steps

1. tool.ts already exists with correct boilerplate. Read it, then replace everything between the \`/* ── REPLACE THIS BLOCK ── */\` and \`/* ── END REPLACE ── */\` markers in processCall with your real implementation using a single edit_file call.
2. Run: \`cd ${toolDir} && npx tsx test-harness.ts '{"your_realistic_args_here"}'\` via execute_command
3. If output shows PASS, call attempt_completion. If FAIL, fix tool.ts and retry (max 2 retries).
`
}
