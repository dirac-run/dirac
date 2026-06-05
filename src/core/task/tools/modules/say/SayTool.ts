import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"

export const say_spec: DiracToolSpec = {
	id: DiracDefaultTool.SAY,
	name: "say",
	description: "Provide an interim update or message to the user without ending the task or asking a question.",
	parameters: [
		{
			name: "message",
			type: "string",
			required: true,
			instruction: "The message to send to the user.",
		},
	],
}

export class SayTool implements IDiracTool {
	spec(): DiracToolSpec {
		return say_spec
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(args: any, env: IToolEnvironment): Promise<any> {
		const { message } = args

		if (!message) {
			return "Error: Missing required parameter 'message'."
		}

		// Ensure the message is displayed to the user
		await env.ui.upsertText(message)

		return "Message received. Please proceed with the next step of the task."
	}
}
