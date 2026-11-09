import { CardStatus } from "@shared/ExtensionMessage"
import { toError } from "@shared/errors"
import { DiracIcon } from "@shared/icons"
import type { DiracToolSpec } from "@shared/tools"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"

export const list_agents_spec: DiracToolSpec = {
	id: "list_agents",
	name: "list_agents",
	description:
		"Discover agents in your runtime-authenticated root group, including settled agents. Returns a compact page of id, title_preview (at most 80 characters), status, and accepts_messages; use next_cursor for more. This is a passive snapshot, not a reservation of message admission. Default 10, maximum 50 agents and 16 KiB serialized output per page. No sibling evidence, conversations, pending requests, or supervision controls are exposed.",
	parameters: [
		{ name: "cursor", required: false, minLength: 1, instruction: "Continuation cursor from this root group's previous next_cursor." },
		{ name: "limit", type: "integer", required: false, minimum: 1, maximum: 50, instruction: "Page size, default 10. The serialized page bound also applies." },
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
		const card = await env.ui.createCard({
			header: `${actor} is listing agents`,
			communication: { actor },
			icon: DiracIcon.SUBAGENTS,
			status: CardStatus.RUNNING,
			collapsed: false,
			do_not_auto_collapse: true,
			rawInput: query,
		})
		try {
			const page = communication.list(query)
			const output = JSON.stringify(page)
			const roster = page.agents.map((agent) => `${agent.id} — ${agent.title_preview}\nStatus: ${agent.status}; messages: ${agent.accepts_messages ? "available" : "unavailable"}`)
			await card.update({
				header: `${actor} listed agents`,
				body: roster.length ? roster.join("\n\n") : "No agents on this page.",
				communication: { actor, detail: `Availability is a snapshot, not a reservation.${page.next_cursor ? ` More agents available; next cursor: ${page.next_cursor}` : ""}` },
			})
			await card.finalize(CardStatus.SUCCESS, true)
			return output
		} catch (error) {
			await card.update({
				header: `${actor} failed to list agents`,
				communication: { actor, detail: toError(error).message },
			})
			await card.finalize(CardStatus.ERROR, true)
			throw error
		}
	}
}

function parseQuery(input: unknown): { cursor?: string; limit?: number } {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("list_agents arguments must be an object")
	const args = input as Record<string, unknown>
	for (const key of Object.keys(args)) {
		if (key !== "cursor" && key !== "limit") throw new Error(`Parameter '${key}' is not valid for list_agents`)
	}
	if (args.cursor !== undefined && (typeof args.cursor !== "string" || !args.cursor.trim())) throw new Error("cursor must be a nonblank string")
	if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 50)) {
		throw new Error("limit must be an integer from 1 to 50")
	}
	return {
		...(args.cursor === undefined ? {} : { cursor: args.cursor as string }),
		...(args.limit === undefined ? {} : { limit: args.limit as number }),
	}
}
