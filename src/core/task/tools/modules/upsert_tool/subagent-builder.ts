import { DiracDefaultTool } from "@/shared/tools"
import { RESPOND_TOOL_NAME, ResponseOperation } from "@shared/responseTool"
import { CardStatus, SubagentExecutionStatus } from "@shared/ExtensionMessage"
import { ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { waitForPresentationOperation } from "../../subagent/PresentationDeadline"
import {
	createSubagentCardInput,
	createSubagentCardOutput,
	formatSubagentTrajectory,
	isTerminalSubagentStatus,
	recordSubagentProgress,
	subagentCardStatus,
	type SubagentIdentity,
	type SubagentTrajectoryEvent,
} from "@shared/subagents"
import {
	BUILDER_MAX_ATTEMPTS,
	ToolScope,
	SMOKE_ARGS_FILE,
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
	`${RESPOND_TOOL_NAME}:${ResponseOperation.COMPLETE}`,
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
	allocateIdentity: () => SubagentIdentity,
): Promise<string | undefined> {
	let repairFeedback: string | undefined

	for (let attempt = 1; attempt <= BUILDER_MAX_ATTEMPTS; attempt++) {
		await updateProgress(`[${request.name}] Builder attempt`, `${attempt}/${BUILDER_MAX_ATTEMPTS}`)
		const generationError = await runBuilderSubagentAttempt(
			env,
			request,
			attempt,
			repairFeedback,
			updateProgress,
			allocateIdentity(),
		)
		const parentValidationError = await validate()
		const validationError =
			generationError && parentValidationError
				? `${generationError} Parent validation: ${parentValidationError}`
				: (generationError ?? parentValidationError)

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
	identity: SubagentIdentity,
): Promise<string | undefined> {
	const prompt = buildSubagentPrompt(request, attempt, repairFeedback)
	const taskTitle = "Building tool implementation"
	const trajectory: SubagentTrajectoryEvent[] = []
	let card: ICardHandle | undefined
	const cardPromise = env.ui.createCard({
		header: taskTitle,
		status: CardStatus.RUNNING,
		collapsed: true,
		renderType: "markdown",
		autoScroll: true,
		rawInput: createSubagentCardInput(identity, prompt, taskTitle),
		rawOutput: createSubagentCardOutput(SubagentExecutionStatus.RUNNING, trajectory),
		body: formatSubagentTrajectory({ ...identity, prompt, status: SubagentExecutionStatus.RUNNING, trajectory }),
	})
	const cardCreation = await waitForPresentationOperation(cardPromise)
	if (cardCreation.timedOut) {
		env.logging.warn(`Tool builder '${request.name}' card creation timed out.`)
		void cardPromise
			.then((lateCard) => lateCard.finalize(CardStatus.ABANDONED))
			.catch((error) => env.logging.warn(`Late tool builder '${request.name}' card cleanup failed.`, error))
	} else {
		card = cardCreation.value
	}

	let discardQueuedPresentationUpdates = false
	let presentationUpdates = Promise.resolve()
	let presentationError: Error | undefined
	const enqueuePresentationUpdate = (present: () => Promise<void>) => {
		presentationUpdates = presentationUpdates
			.then(async () => {
				if (discardQueuedPresentationUpdates) return
				await present()
			})
			.catch((error) => {
				presentationError ??= error as Error
			})
	}
	const runPresentationOperation = async (operation: Promise<void>, timeoutMessage: string) => {
		let operationError: Error | undefined
		const observedOperation = operation.catch((error) => {
			operationError = error as Error
		})
		const outcome = await waitForPresentationOperation(observedOperation)
		if (outcome.timedOut) presentationError ??= new Error(timeoutMessage)
		else if (operationError) presentationError ??= operationError
	}

	let lastBuilderOutputUpdateAt = 0
	const result = await env.orchestration.runSubagent(prompt, {
		subagentName: `tool_builder:${request.name}:attempt_${attempt}`,
		agentIdentity: identity,
		taskTitle,
		timeout: SUBAGENT_TIMEOUT_SECONDS,
		allowedTools: BUILDER_ALLOWED_TOOLS,
		systemSuffix: TOOL_BUILDER_SYSTEM_SUFFIX,
		signal: env.config.taskState.abortSignal,
		onUpdate: (update) => {
			const trajectoryChanged = update.trajectoryEvent !== undefined || update.status !== undefined
			if (trajectoryChanged) {
				const status = recordSubagentProgress(trajectory, update)
				if (card && !isTerminalSubagentStatus(status)) {
					const patch = {
						status: subagentCardStatus(status),
						body: formatSubagentTrajectory({ ...identity, prompt, status, trajectory }),
						rawOutput: createSubagentCardOutput(status, trajectory),
					}
					enqueuePresentationUpdate(() => card!.update(patch))
				}
			}

			if (update.textChunk && Date.now() - lastBuilderOutputUpdateAt >= 250) {
				lastBuilderOutputUpdateAt = Date.now()
				const snippet = update.textChunk.length > 200 ? update.textChunk.slice(-200) : update.textChunk
				enqueuePresentationUpdate(() => updateProgress("Builder output", snippet.replace(/\n/g, " ").substring(0, 150)))
			}
			if (update.latestToolCall) {
				enqueuePresentationUpdate(() => updateProgress("Builder subagent", update.latestToolCall))
			}
			if (update.status === SubagentExecutionStatus.COMPLETED) {
				enqueuePresentationUpdate(() => updateProgress("Builder subagent", "completed"))
			}
			if (update.status === SubagentExecutionStatus.FAILED) {
				enqueuePresentationUpdate(() => updateProgress("Builder subagent", update.error || "failed"))
			}
		},
	})

	recordSubagentProgress(trajectory, result)
	const finalPatch = {
		status: subagentCardStatus(result.status),
		body: formatSubagentTrajectory({ ...identity, prompt, status: result.status, trajectory }),
		rawOutput: createSubagentCardOutput(result.status, trajectory),
	}
	const finalProgressDetail = result.status === SubagentExecutionStatus.COMPLETED ? "completed" : result.error || result.status
	const applyTerminalPresentationState = async () => {
		if (card) {
			await runPresentationOperation(card.update(finalPatch), `Tool builder '${request.name}' final card update timed out.`)
			await runPresentationOperation(
				card.finalize(subagentCardStatus(result.status)),
				`Tool builder '${request.name}' card finalization timed out.`,
			)
		}
		await runPresentationOperation(
			updateProgress("Builder subagent", finalProgressDetail),
			`Tool builder '${request.name}' final progress update timed out.`,
		)
	}
	const intermediateUpdates = await waitForPresentationOperation(presentationUpdates)
	if (intermediateUpdates.timedOut) {
		discardQueuedPresentationUpdates = true
		presentationError ??= new Error(`Tool builder '${request.name}' presentation did not drain before the timeout.`)
		void presentationUpdates
			.then(applyTerminalPresentationState)
			.catch((error) => env.logging.warn(`Late tool builder '${request.name}' terminal replay failed.`, error))
	}
	await applyTerminalPresentationState()
	if (presentationError) {
		env.logging.warn(`Tool builder '${request.name}' completed with a presentation error.`, presentationError)
	}

	if (result.status === SubagentExecutionStatus.CANCELLED) {
		throw new Error(`Tool build cancelled: ${result.error || "Subagent execution was cancelled."}`)
	}
	if (result.status !== SubagentExecutionStatus.COMPLETED) {
		return `Code generation failed: ${result.error || "Subagent did not complete successfully."}`
	}
	return undefined
}

function buildSubagentPrompt(request: ToolBuildRequest, attempt: number, repairFeedback: string | undefined): string {
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
5. If the harness fails, repair the implementation and rerun it. Then call respond with operation "complete" and a brief summary.

Never leave the sentinel token in tool.ts, including in comments or strings.`
}

function summarizeError(error: string): string {
	const normalized = error.replace(/\s+/g, " ").trim()
	return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized
}
