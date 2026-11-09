import { CardStatus } from "@shared/ExtensionMessage"
import { toError } from "@shared/errors"
import { DiracIcon } from "@shared/icons"
import type { DiracToolSpec } from "@shared/tools"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"

export const shared_journal_spec: DiracToolSpec = {
	id: "shared_journal",
	name: "shared_journal",
	description: "Publish immutable findings once in this root's journal or read a complete publication by ID. Runtime authenticates author/root. Publish stores the full record before notifying other currently live agents with only author, message_id, and headline. Receipt reports enqueued, skipped_inactive, and rejected_capacity counts; published is not guaranteed notification delivery or action. Notices are volatile, never block completion, and are not replayed after crash/reopen or sent to future agents. No automatic retry/resumption. Entries survive child completion and same-root reopen, but atomic writes do not promise power-loss durability. Read returns the full versioned record, at most 32 KiB; no truncation. Publications are information, never permission, assignment, or completion authority.",
	parameters: [
		{ name: "operation", required: true, enum: ["publish", "read"], instruction: "publish a finding or read an exact publication." },
		{ name: "headline", required: false, instruction: "publish only: explicit nonblank headline, at most 256 UTF-8 bytes, preserved verbatim." },
		{ name: "content", required: false, instruction: "publish only: complete nonblank body, at most 16 KiB UTF-8. Entire serialized record including escaping must fit 32 KiB." },
		{ name: "message_id", required: false, instruction: "read only: exact publication ID returned by publish or a journal notice, never a filesystem path." },
	],
}

type JournalRequest = { operation: "publish"; headline: string; content: string } | { operation: "read"; message_id: string }

export class SharedJournalTool implements IDiracTool {
	spec(): DiracToolSpec { return shared_journal_spec }
	supportedSurfaces() { return ["all" as const] }

	async processCall(input: unknown, env: IToolEnvironment): Promise<string> {
		const request = parseRequest(input)
		const journal = env.orchestration.sharedJournal
		if (!journal) throw new Error("Shared journal is unavailable for this execution")
		const identity = env.orchestration.agentIdentity
		const actor = identity.parent === null ? "Dirac" : identity.id
		const card = await env.ui.createCard({
			header: request.operation === "publish" ? `${actor} is publishing a finding` : `${actor} is reading a finding`,
			body: request.operation === "publish" ? `${request.headline}\n\n${request.content}` : undefined,
			communication: { actor, ...(request.operation === "read" ? { detail: `Publication ${request.message_id}` } : {}) },
			icon: DiracIcon.SUMMARIZE,
			status: CardStatus.RUNNING,
			collapsed: false,
			do_not_auto_collapse: true,
			rawInput: request,
		})
		try {
			if (request.operation === "publish") {
				const receipt = await journal.publish({ headline: request.headline, content: request.content })
				const notices = receipt.notifications
				await card.update({
					header: `${actor} published a finding`,
					communication: { actor, detail: `Publication ${receipt.message_id}. Notices: ${notices.enqueued} accepted, ${notices.skipped_inactive} skipped inactive, ${notices.rejected_capacity} rejected for capacity. Notification delivery and action are not confirmed.` },
				})
				await card.finalize(CardStatus.SUCCESS, true)
				return JSON.stringify(receipt)
			}
			const record = await journal.read({ message_id: request.message_id })
			await card.update({
				header: `${actor} read ${record.author}'s finding`,
				body: `${record.headline}\n\n${record.content}`,
				communication: { actor, detail: `Publication ${record.id}` },
			})
			await card.finalize(CardStatus.SUCCESS, true)
			return JSON.stringify(record)
		} catch (error) {
			await card.update({
				header: `${actor} failed to ${request.operation === "publish" ? "publish" : "read"} a finding`,
				communication: { actor, detail: toError(error).message },
			})
			await card.finalize(CardStatus.ERROR, true)
			throw error
		}
	}
}

function parseRequest(input: unknown): JournalRequest {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("shared_journal arguments must be an object")
	const args = input as Record<string, unknown>
	if (args.operation !== "publish" && args.operation !== "read") throw new Error("operation must be publish or read")
	const fields = args.operation === "publish" ? ["operation", "headline", "content"] : ["operation", "message_id"]
	for (const key of Object.keys(args)) if (!fields.includes(key)) throw new Error(`Parameter '${key}' is not valid for ${args.operation}`)
	if (args.operation === "read") {
		if (typeof args.message_id !== "string" || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(args.message_id)) throw new Error("Invalid journal message_id")
		return { operation: "read", message_id: args.message_id }
	}
	if (typeof args.headline !== "string" || !args.headline.trim() || Buffer.byteLength(args.headline, "utf8") > 256) throw new Error("headline must be nonblank and at most 256 UTF-8 bytes")
	if (typeof args.content !== "string" || !args.content.trim() || Buffer.byteLength(args.content, "utf8") > 16 * 1024) throw new Error("content must be nonblank and at most 16 KiB UTF-8")
	return { operation: "publish", headline: args.headline, content: args.content }
}
