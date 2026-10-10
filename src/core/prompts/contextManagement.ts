import { formatCurrentTurnUserRequests } from "@core/text-condensation/CurrentTurnUserRequests"

export const autoCondensePrompt = (useUtilityModel = false) => {
	if (useUtilityModel) {
		return `The conversation is nearing its context limit. Call condense without a context parameter, or respond with operation "complete" only if the current user request—not merely an earlier task—is finished.`
	}

	return `The conversation is nearing its context limit. To continue effectively, you must now call the condense tool with a comprehensive, high-fidelity summary of the task's progress.

Your summary must be exhaustive, capturing the "whole nine yards":
- The current unfinished user request, including later corrections and answers. Distinguish it from completed historical tasks; completing an earlier task does not complete a newer request.
- Earlier user intents and requirements that remain relevant.
- Every technical finding, architectural decision, and code pattern discovered.
- A detailed account of all files examined or modified, including critical code snippets.
- The precise current status and the exact next steps to take.

Ensure no relevant detail is lost. Call only condense, or respond with operation "complete" only if the current request—not merely an earlier task—is finished.`
}

export const continuationPrompt = (summaryText: string, currentTurnUserRequests: readonly string[]) => `
This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:
${summaryText}

${formatCurrentTurnUserRequests(currentTurnUserRequests)}

Please continue the conversation from where we left it off. The current-turn user requests above are original user input, not generated summary text. Use them to identify the current unfinished task and its corrections; later requests supersede conflicting historical intent. An earlier task's completion does not complete a newer request. Do not restart a completed historical task because it remains in the initial message or summary. Preserve relevant constraints and completed work from the summary, and continue at the precise unfinished step rather than repeating work already done.
A subsequent user request in this conversation takes precedence over this snapshot. Compaction commands such as "/smol" and "/compact" are not new tasks and have already been handled; do not ask the user to repeat them.
`
