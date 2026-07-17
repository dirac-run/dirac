import { DiracDefaultTool } from "@/shared/tools"
import { CardStatus } from "@shared/ExtensionMessage"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import {
	BUILDER_MAX_ATTEMPTS,
	ToolScope,
	SMOKE_ARGS_FILE,
	SUBAGENT_MAX_TURNS,
	SUBAGENT_TIMEOUT_SECONDS,
	TOOL_AUTHORING_CONTRACT,
	TOOL_BUILDER_SYSTEM_SUFFIX,
	TOOL_IMPLEMENTATION_SENTINEL,
} from "./constants"

const BUILDER_ALLOWED_TOOLS = [
	DiracDefaultTool.FILE_READ,
	DiracDefaultTool.EDIT_FILE,
	DiracDefaultTool.FILE_NEW,
	DiracDefaultTool.BASH,
	DiracDefaultTool.ATTEMPT,
]

interface ToolBuildRequest {
	name: string
	scope: ToolScope
	description: string
	parameters: any[]
	requirements: string
	toolDir: string
}

export async function buildToolWithRepairs(
	env: IToolEnvironment,
	request: ToolBuildRequest,
	validate: () => Promise<string | undefined>,
	updateProgress: (phase: string, detail?: string, status?: CardStatus) => Promise<void>,
): Promise<string | undefined> {
	let repairFeedback: string | undefined

	for (let attempt = 1; attempt <= BUILDER_MAX_ATTEMPTS; attempt++) {
		await updateProgress(`[${request.name}] Builder attempt`, `${attempt}/${BUILDER_MAX_ATTEMPTS}`)
		const generationError = await runBuilderSubagentAttempt(env, request, attempt, repairFeedback, updateProgress)
		const parentValidationError = await validate()
		const validationError = parentValidationError
			? generationError ? `${generationError} Parent validation: ${parentValidationError}` : parentValidationError
			: undefined

		if (!validationError) {
			await updateProgress(`[${request.name}] Validated`, `attempt ${attempt}`)
			return undefined
		}

		repairFeedback = validationError
		if (attempt < BUILDER_MAX_ATTEMPTS) {
			await updateProgress(`[${request.name}] Repair requested`, summarizeError(validationError))
		}
	}

	return `Build failed after ${BUILDER_MAX_ATTEMPTS} attempts. Last error: ${repairFeedback}`
}

async function runBuilderSubagentAttempt(
	env: IToolEnvironment,
	request: ToolBuildRequest,
	attempt: number,
	repairFeedback: string | undefined,
	updateProgress: (phase: string, detail?: string, status?: CardStatus) => Promise<void>,
): Promise<string | undefined> {
	const prompt = buildSubagentPrompt(request, attempt, repairFeedback)
	const result = await env.orchestration.runSubagent(prompt, {
		subagentName: `tool_builder:${request.name}:attempt_${attempt}`,
		maxTurns: SUBAGENT_MAX_TURNS,
		timeout: SUBAGENT_TIMEOUT_SECONDS,
		allowedTools: BUILDER_ALLOWED_TOOLS,
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
				await updateProgress("Builder subagent", update.error || "failed")
			}
		},
	})

	if (result.status === "failed") {
		return `Code generation failed: ${result.error || "Subagent did not complete successfully."}`
	}

	return undefined
}

function buildSubagentPrompt(
	request: ToolBuildRequest,
	attempt: number,
	repairFeedback: string | undefined,
): string {
	const repairSection = repairFeedback
		? `\n## Repair Feedback\n\nThe parent validator rejected the previous attempt:\n\n${repairFeedback}\n\nRead the current files and repair the implementation. Do not restore the scaffold sentinel.`
		: ""

	return `You are a Dirac tool code generator. Implement and smoke-test the existing tool scaffold for the Dirac coding agent.

## Tool Requirements

- **Name**: ${request.name}
- **Description**: ${request.description}
- **Requested Scope**: ${request.scope}
- **Parameters**: ${JSON.stringify(request.parameters, null, 2)}
- **Behavior**: ${request.requirements}
- **Builder Attempt**: ${attempt}/${BUILDER_MAX_ATTEMPTS}

## Scope Protocol

The requested scope is **${request.scope}**. Treat it as immutable context.
You are not allowed to decide a different scope, write a manifest, choose a storage directory, register a tool, enable a tool, or call upsert_tool.
Only edit the processCall implementation and the smoke-test arguments file in the existing staging directory.
\`upsert_tool\` handles validation, promotion, registration, and enablement.

${TOOL_AUTHORING_CONTRACT}
${repairSection}

## Steps

1. Read ${request.toolDir}/tool.ts and any existing ${request.toolDir}/${SMOKE_ARGS_FILE}.
2. On the first attempt, replace the exact sentinel statement \`throw new Error(${JSON.stringify(TOOL_IMPLEMENTATION_SENTINEL)})\` with the complete processCall implementation using edit_file. On repair attempts, make only the edits needed to address the validator feedback.
3. Write ${request.toolDir}/${SMOKE_ARGS_FILE} as a JSON object containing realistic arguments for a successful smoke test. This is the only auxiliary file you may write.
4. Run: \`npx tsx ${JSON.stringify(`${request.toolDir}/test-harness.ts`)}\` via execute_command. The harness reads ${SMOKE_ARGS_FILE} itself.
5. If the harness fails, repair the implementation and rerun it. Then call attempt_completion with a brief summary.

Never leave the sentinel token in tool.ts, including in comments or strings.`
}

function summarizeError(error: string): string {
	const normalized = error.replace(/\s+/g, " ").trim()
	return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized
}
