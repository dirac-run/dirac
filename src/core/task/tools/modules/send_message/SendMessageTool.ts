import { CardStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@shared/icons"
import type { DiracToolSpec } from "@shared/tools"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import { toError } from "@/shared/errors"
import type { CardParams, ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { waitForPresentationOperation } from "../../subagent/PresentationDeadline"

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
		const header = `${actor} → ${request.to} · Message`
		const card = await createMessageCard(
			{
				header,
				body: `${request.text}\n\nSending...`,
				communication: { actor },
				icon: DiracIcon.CHAT,
				status: CardStatus.RUNNING,
				collapsed: true,
				rawInput: request,
			},
			env,
		)
		let receipt: Awaited<ReturnType<typeof communication.send>>
		try {
			receipt = await communication.send(request)
		} catch (error) {
			if (card) {
				await present(
					() =>
						card.update({
							header,
							body: `${request.text}\n\nMessage not accepted.`,
							communication: { actor },
						}),
					env,
				)
				await present(() => card.finalize(CardStatus.ERROR), env)
			}
			throw error
		}
		if (card) {
			await present(
				() =>
					card.update({
						header,
						body: `${request.text}\n\nMessage accepted.`,
						communication: { actor },
					}),
				env,
			)
			await present(() => card.finalize(CardStatus.SUCCESS), env)
		}
		return JSON.stringify(receipt)
	}
}

async function createMessageCard(params: CardParams, env: IToolEnvironment): Promise<ICardHandle | undefined> {
	try {
		const creation = env.ui.createCard(params)
		const result = await waitForPresentationOperation(creation)
		if (!result.timedOut) return result.value
		env.logging.warn("[SendMessageTool] Card creation timed out")
		void creation
			.then((card) => present(() => card.finalize(CardStatus.ABANDONED), env))
			.catch((error) => env.logging.warn("[SendMessageTool] Late card creation failed", toError(error)))
	} catch (error) {
		env.logging.warn("[SendMessageTool] Card creation failed", toError(error))
	}
	return undefined
}

async function present(operation: () => Promise<void>, env: IToolEnvironment): Promise<void> {
	try {
		const result = await waitForPresentationOperation(operation())
		if (result.timedOut) env.logging.warn("[SendMessageTool] Card presentation timed out")
	} catch (error) {
		env.logging.warn("[SendMessageTool] Card presentation failed", toError(error))
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
