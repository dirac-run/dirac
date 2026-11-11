import { CardStatus } from "@shared/ExtensionMessage"
import { toError } from "@shared/errors"
import { DiracIcon } from "@shared/icons"
import type { DiracToolSpec } from "@shared/tools"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { CardParams, ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { waitForPresentationOperation } from "../../subagent/PresentationDeadline"

export const list_agents_spec: DiracToolSpec = {
	id: "list_agents",
	name: "list_agents",
	description:
		"Discover agents in your runtime-authenticated root group, including settled agents. Agents accepting messages come first, preserving roster order within each availability group. Returns a compact page of id, title_preview (at most 80 characters), status, and accepts_messages; use next_cursor for more. This is a passive snapshot, not a reservation of message admission; roster or availability changes can shift cursor pages. Default 20, maximum 20 agents and 16 KiB serialized output per page. No sibling evidence, conversations, pending requests, or supervision controls are exposed.",
	parameters: [
		{ name: "cursor", required: false, minLength: 1, instruction: "Continuation cursor from this root group's previous next_cursor." },
		{ name: "limit", type: "integer", required: false, minimum: 1, maximum: 20, instruction: "Page size, default 20. The serialized page bound also applies." },
	],
}

export class ListAgentsTool implements IDiracTool {
	spec(): DiracToolSpec {
		return list_agents_spec
	}

	supportedSurfaces() {
		return ["all" as const]
	}

	async processCall(input: unknown, env: IToolEnvironment): Promise<string> {
		const query = parseQuery(input)
		const communication = env.orchestration.agentCommunication
		if (!communication) throw new Error("Agent discovery is unavailable for this execution")
		const identity = env.orchestration.agentIdentity
		const actor = identity.parent === null ? "Dirac" : identity.id
		const card = await createRosterCard({
			header: `${actor} is listing agents`,
			communication: { actor },
			icon: DiracIcon.SUBAGENTS,
			status: CardStatus.RUNNING,
			collapsed: false,
			do_not_auto_collapse: true,
			rawInput: query,
		}, env)
		let page: ReturnType<typeof communication.list>
		try {
			page = communication.list(query)
		} catch (error) {
			if (card) {
				await present(() => card.update({
					header: `${actor} failed to list agents`,
					communication: { actor, detail: toError(error).message },
				}), env)
				await present(() => card.finalize(CardStatus.ERROR, true), env)
			}
			throw error
		}
		if (card) {
			const roster = page.agents.map((agent) => `${agent.id} — ${agent.title_preview}\nStatus: ${agent.status}; messages: ${agent.accepts_messages ? "available" : "unavailable"}`)
			await present(() => card.update({
				header: `${actor} listed agents`,
				body: roster.length ? roster.join("\n\n") : "No agents on this page.",
				communication: { actor, detail: page.next_cursor ? "More agents available." : undefined },
			}), env)
			await present(() => card.finalize(CardStatus.SUCCESS, true), env)
		}
		return JSON.stringify(page)
	}
}

async function createRosterCard(params: CardParams, env: IToolEnvironment): Promise<ICardHandle | undefined> {
	try {
		const creation = env.ui.createCard(params)
		const result = await waitForPresentationOperation(creation)
		if (!result.timedOut) return result.value
		env.logging.warn("[ListAgentsTool] Card creation timed out")
		void creation
			.then((card) => present(() => card.finalize(CardStatus.ABANDONED), env))
			.catch((error) => env.logging.warn("[ListAgentsTool] Late card creation failed", toError(error)))
	} catch (error) {
		env.logging.warn("[ListAgentsTool] Card creation failed", toError(error))
	}
	return undefined
}

async function present(operation: () => Promise<void>, env: IToolEnvironment): Promise<void> {
	try {
		const result = await waitForPresentationOperation(operation())
		if (result.timedOut) env.logging.warn("[ListAgentsTool] Card presentation timed out")
	} catch (error) {
		env.logging.warn("[ListAgentsTool] Card presentation failed", toError(error))
	}
}

function parseQuery(input: unknown): { cursor?: string; limit?: number } {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("list_agents arguments must be an object")
	const args = input as Record<string, unknown>
	for (const key of Object.keys(args)) {
		if (key !== "cursor" && key !== "limit") throw new Error(`Parameter '${key}' is not valid for list_agents`)
	}
	if (args.cursor !== undefined && (typeof args.cursor !== "string" || !args.cursor.trim())) throw new Error("cursor must be a nonblank string")
	if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 20)) {
		throw new Error("limit must be an integer from 1 to 20")
	}
	return {
		...(args.cursor === undefined ? {} : { cursor: args.cursor as string }),
		...(args.limit === undefined ? {} : { limit: args.limit as number }),
	}
}
