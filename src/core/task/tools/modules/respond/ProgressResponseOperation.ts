import { IToolEnvironment } from "../../interfaces/IToolEnvironment"

export async function presentProgressResponse(text: string, env: IToolEnvironment): Promise<string> {
	await env.ui.upsertText(text, false, "assistant")

	// A bare "proceed" made a finished reply sent as progress loop: the model repeated it every turn.
	const finalOperation = env.config.executionProfile !== "tasklet" && env.config.mode === "plan" ? "plan" : "complete"
	const audienceFeedback = env.config.executionProfile === "tasklet" ? "Reported to Dirac." : "Shown to the user."
	return `${audienceFeedback} 'progress' does not end your turn: continue with the next step, or if your reply is finished, send it with respond '${finalOperation}'.`
}
