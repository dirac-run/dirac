import { IToolEnvironment } from "../../interfaces/IToolEnvironment"

export async function presentProgressResponse(text: string, env: IToolEnvironment): Promise<string> {
	await env.ui.upsertText(text, false, "assistant")

	// A bare "proceed" made a finished reply sent as progress loop: the model repeated it every turn.
	const finalOperation = env.config.mode === "plan" && !env.config.isSubagentExecution ? "plan" : "complete"
	return `Shown to the user. 'progress' does not end your turn: continue with the next step, or if your reply is finished, send it with respond '${finalOperation}'.`
}
