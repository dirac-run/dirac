import { CardStatus } from "@shared/ExtensionMessage"
import { toError } from "@shared/errors"
import { DiracIcon } from "@shared/icons"
import type { DiracToolSpec } from "@shared/tools"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"

export const send_message_spec: DiracToolSpec = {
	id: "send_message",
	name: "send_message",
	description:
		"Send ordinary communication to one agent in your root group. Use the exact address from list_agents; Dirac addresses the root. Sender identity and root scope come from the runtime. Self-send and inactive recipients are rejected. Success means volatile acceptance, not delivery, understanding, or action. Pending mail may be lost on crash, shutdown, or cancellation; there is no automatic replay, retry, or resumption. Mail is included at eligible model-input boundaries and never resolves structured questions, grants permission, changes assignments, or restarts settled agents. Queue limits reject excess mail. Text is limited to 8 KiB UTF-8 and the serialized message envelope to 16 KiB.",
	parameters: [
		{ name: "to", required: true, minLength: 1, instruction: "Exact local agent address, case-sensitive; no aliases or normalization." },
		{ name: "text", required: true, minLength: 1, instruction: "Nonblank ordinary message, preserved verbatim; at most 8 KiB UTF-8. JSON escaping and envelope metadata must also fit 16 KiB." },
	],
}

export class SendMessageTool implements IDiracTool {
	spec(): DiracToolSpec {
		return send_message_spec
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(input: unknown, env: IToolEnvironment): Promise<string> {
		const request = parseMessage(input)
		const communication = env.orchestration.agentCommunication
		if (!communication) throw new Error("Agent communication is unavailable for this execution")
		const identity = env.orchestration.agentIdentity
		const actor = identity.parent === null ? "Dirac" : identity.id
		const card = await env.ui.createCard({
			header: `${actor} is sending a message to ${request.to}`,
			body: request.text,
			communication: { actor },
			icon: DiracIcon.CHAT,
			status: CardStatus.RUNNING,
			collapsed: false,
			do_not_auto_collapse: true,
			rawInput: request,
		})
		try {
			const receipt = await communication.send(request)
			await card.update({
				header: `${actor} sent a message to ${request.to}`,
				communication: { actor, detail: "Accepted into the volatile mailbox; delivery, understanding, and action are not confirmed." },
			})
			await card.finalize(CardStatus.SUCCESS, true)
			return JSON.stringify(receipt)
		} catch (error) {
			await card.update({
				header: `${actor} failed to send a message to ${request.to}`,
				communication: { actor, detail: toError(error).message },
			})
			await card.finalize(CardStatus.ERROR, true)
			throw error
		}
	}
}

function parseMessage(input: unknown): { to: string; text: string } {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("send_message arguments must be an object")
	const args = input as Record<string, unknown>
	for (const key of Object.keys(args)) {
		if (key !== "to" && key !== "text") throw new Error(`Parameter '${key}' is not valid for send_message`)
	}
	if (typeof args.to !== "string" || !args.to.trim()) throw new Error("to must be a nonblank exact agent address")
	if (typeof args.text !== "string" || !args.text.trim()) throw new Error("text must be a nonblank string")
	if (Buffer.byteLength(args.text, "utf8") > 8 * 1024) throw new Error("text must be at most 8 KiB UTF-8")
	return { to: args.to, text: args.text }
}
