import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { ask_followup_question_spec, AskFollowupQuestionTool } from "./AskFollowupQuestionTool"

export const spec: DiracToolSpec = ask_followup_question_spec

export function create(): IDiracTool {
	return new AskFollowupQuestionTool()
}
