import type { DiracToolSpec } from "@shared/tools"
import { DiracDefaultTool } from "@shared/tools"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { CompletionResponseOperation } from "./CompletionResponseOperation"
import { presentPlanForApproval } from "./PlanResponseOperation"
import { presentProgressResponse } from "./ProgressResponseOperation"
import { requestQuestionResponse } from "./QuestionResponseOperation"
import { validateResponseArguments } from "./ResponseArgumentsValidator"
import { RESPONSE_OPERATIONS, ResponseOperation, ResponseParameter } from "@shared/responseTool"

const LOW_VERBOSITY_RESPONSE_INSTRUCTION = `Keep responses concise. Treat this as a presentation constraint, not permission to omit requested or decision-critical information. Preserve material constraints, uncertainty, failures, caveats, and verification status. Explicit requirements for content, detail, or format take precedence.`

function responseTextInstruction(context: { lowVerbosityEnabled?: boolean; executionProfile?: string }): string {
	const isTasklet = context.executionProfile === "tasklet"
	const audience = isTasklet ? "Dirac" : "the user"
	if (context.lowVerbosityEnabled === false) return `Response text for ${audience}.`

	return `${LOW_VERBOSITY_RESPONSE_INSTRUCTION} Address ${audience}.

- progress: Give one short sentence containing only a key finding, milestone, blocker, change in approach, or immediate next action. Skip acknowledgements and routine narration.
- question: Ask only for input required to continue. Give the minimum context, ask one direct question, and keep choices short and distinct. Do not repeat established context or seek confirmation when a safe choice is already determined.${isTasklet ? "" : `
- plan: Answer simple questions directly. For implementation proposals, lead with important decisions and clearly state affected areas, ordered work, and verification. Prominently surface tradeoffs, risks, assumptions, and decisions requiring the user's input; do not bury them in implementation steps. Omit research narration and generic advice.`}
- complete: Lead with the outcome. Include only material changes, verification and results, caveats or failures, and remaining work. Do not recap task history, routine steps, the original request, or a redundant conclusion. Use one sentence when it is enough.`
}

export const respondSpec: DiracToolSpec = {
	id: DiracDefaultTool.RESPOND,
	name: DiracDefaultTool.RESPOND,
	description:
		"Provides progress updates, questions, plans, and completion results to the task's response audience.",
	promptDescription: (context) => {
		const audience = context.executionProfile === "tasklet" ? "Dirac" : "the user"
		const description = `Send a response to ${audience}.`
		return context.lowVerbosityEnabled === false
			? description
			: `Keep responses concise. ${description} Do not omit information needed to understand, decide, act, or verify.`
	},
	parameters: [
		{
			name: ResponseParameter.OPERATION,
			type: "string",
			required: true,
			enum: RESPONSE_OPERATIONS,
			instruction: (context) =>
				context.executionProfile === "tasklet"
					? "progress = interim update to Dirac; question = required input from Dirac; complete = assignment result for Dirac."
					: "progress = interim update; complete = final Act Mode result; plan = Plan Mode response/proposal; question = required user input.",
		},
		{
			name: ResponseParameter.TEXT,
			type: "string",
			required: true,
			instruction: responseTextInstruction,
		},
		{
			name: ResponseParameter.OPTIONS,
			type: "array",
			items: { type: "string" },
			minItems: 2,
			maxItems: 5,
			required: false,
			instruction: "Question choices; omit otherwise.",
		},
	],
}

export class RespondTool implements IDiracTool {
	private readonly completion = new CompletionResponseOperation()

	spec(): DiracToolSpec {
		return respondSpec
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(args: unknown, env: IToolEnvironment): Promise<any> {
		const request = validateResponseArguments(args, env)
		if (request.operation === ResponseOperation.PROGRESS) await env.responseObserver.recordResponse(request)
		env.telemetry.captureCustomMetadata({
			operation: request.operation,
			textLength: request.text.length,
			mode: env.config.mode,
			...(request.operation === ResponseOperation.QUESTION ? { optionCount: request.options?.length ?? 0 } : {}),
		})
		switch (request.operation) {
			case ResponseOperation.PROGRESS:
				return presentProgressResponse(request.text, env)
			case ResponseOperation.QUESTION:
				return requestQuestionResponse(request.text, request.options ?? [], env)
			case ResponseOperation.PLAN:
				return presentPlanForApproval(request.text, env)
			case ResponseOperation.COMPLETE:
				return this.completion.execute(request.text, env)
		}
	}
}
