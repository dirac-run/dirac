import { CardStatus } from "@shared/ExtensionMessage"
import { toError } from "@shared/errors"
import { DiracIcon } from "@shared/icons"
import type { DiracToolSpec } from "@shared/tools"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"

export const wait_for_message_spec: DiracToolSpec = {
	id: "wait_for_message",
	name: "wait_for_message",
	description: "Child-only voluntary wait for ordinary messages or journal notices, cancellation, or a finite deadline. Already-pending communication returns immediately. Waiting remains active work visible to the parent; a wake does not consume messages or complete the assignment. Not available while a structured question or permission request is pending. After a timeout, another wait is rejected until fresh inbound communication or parent control/guidance arrives: do useful work, complete, or ask the parent with respond question instead of polling.",
	parameters: [{ name: "timeout_ms", type: "integer", required: false, minimum: 1000, maximum: 300000, instruction: "Finite wait in milliseconds, default 30000; integer from 1000 through 300000 (1–300 seconds)." }],
}

export class WaitForMessageTool implements IDiracTool {
	spec(): DiracToolSpec { return wait_for_message_spec }
	supportedSurfaces() { return ["all" as const] }

	async processCall(input: unknown, env: IToolEnvironment): Promise<string> {
		if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("wait_for_message arguments must be an object")
		const args = input as Record<string, unknown>
		for (const key of Object.keys(args)) if (key !== "timeout_ms") throw new Error(`Parameter '${key}' is not valid for wait_for_message`)
		const timeout = args.timeout_ms ?? 30000
		if (args.timeout_ms === null || !Number.isInteger(timeout) || (timeout as number) < 1000 || (timeout as number) > 300000) {
			throw new Error("timeout_ms must be an integer from 1000 to 300000")
		}
		const waiting = env.orchestration.agentWait
		if (!waiting) throw new Error("wait_for_message is available only to an active child")
		const identity = env.orchestration.agentIdentity
		const actor = identity.parent === null ? "Dirac" : identity.id
		const card = await env.ui.createCard({
			header: `${actor} is waiting for communication`,
			body: `Waiting up to ${Number(timeout) / 1000} seconds for communication or parent guidance. A wake does not complete the assignment.`,
			communication: { actor },
			icon: DiracIcon.CHAT,
			status: CardStatus.RUNNING,
			collapsed: false,
			do_not_auto_collapse: true,
			rawInput: args,
		})
		try {
			const result = await waiting.wait({ timeout_ms: timeout as number })
			const body = result.reason === "timeout"
				? "Deadline reached. Do useful work, complete, or ask the parent; another wait requires fresh communication or parent guidance."
				: result.reason === "cancelled"
					? "Waiting was cancelled. The assignment was not completed by this wait."
					: "Communication or parent guidance is available. A wake does not consume messages or complete the assignment."
			await card.update({ header: `${actor}'s wait ended: ${result.reason}`, body })
			await card.finalize(result.reason === "cancelled" ? CardStatus.ABANDONED : CardStatus.SUCCESS, true)
			return JSON.stringify(result)
		} catch (error) {
			await card.update({
				header: `${actor} failed to wait for communication`,
				body: toError(error).message,
			})
			await card.finalize(CardStatus.ERROR, true)
			throw error
		}
	}
}
