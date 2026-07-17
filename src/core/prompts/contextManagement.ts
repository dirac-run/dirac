export const autoCondensePrompt = () => {
	return `The conversation is nearing its context limit. To continue effectively, you must now call the condense tool with a comprehensive, high-fidelity summary of the task's progress.

Your summary must be exhaustive, capturing the "whole nine yards":
- All user intents and requirements.
- Every technical finding, architectural decision, and code pattern discovered.
- A detailed account of all files examined or modified, including critical code snippets.
- The precise current status and the exact next steps to take.

This summary will be your only context moving forward, so ensure no relevant detail is lost. You MUST ONLY respond by calling condense or attempt_completion.`
}

export const continuationPrompt = (summaryText: string) => `
This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:
${summaryText}.

Please continue the conversation from where we left it off without asking the user any further questions. Continue with the last task that you were asked to work on. Pay special attention to the most recent user message when responding rather than the initial task message, if applicable.
If the most recent user's message starts with "/newtask", "/smol", "/compact", or "/newrule", you should indicate to the user that they will need to run this command again.
`
