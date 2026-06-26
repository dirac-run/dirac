import { JSONParser } from "@streamparser/json"
import { nanoid } from "nanoid"
import { DiracAssistantToolUseBlock } from "@/shared/messages/content"
import { Session } from "@/shared/services/Session"
import type { PendingToolUse, ParsedToolUseState, ToolUseDeltaBlock } from "./types"

const ESCAPE_MAP: Record<string, string> = { "\\n": "\n", "\\t": "\t", "\\r": "\r", '\\"': '"', "\\\\": "\\" }
const ESCAPE_PATTERN = /\\[ntr"\\]/g

// Handles streaming native tool use blocks and converts them to DiracAssistantToolUseBlock format.
export class ToolUseHandler {
	private pendingToolUses = new Map<string, PendingToolUse>()

	markAsComplete(id: string) {
		const pending = this.pendingToolUses.get(id)
		if (pending) pending.isComplete = true
	}

	processToolUseDelta(delta: ToolUseDeltaBlock, call_id?: string): void {
		if (!delta.id) return
		let pending = this.pendingToolUses.get(delta.id)
		if (!pending) pending = this.createPendingToolUse(delta.id, delta.name || "", call_id)
		if (delta.name) pending.name = delta.name
		if (delta.signature) pending.signature = delta.signature
		if (delta.input) {
			pending.input += delta.input
			try {
				pending.jsonParser?.write(delta.input)
			} catch {
				/* Expected during streaming — JSONParser may not have complete JSON yet */
			}
		}
	}

	getFinalizedToolUse(id: string): (DiracAssistantToolUseBlock & { isComplete: boolean }) | undefined {
		const pending = this.pendingToolUses.get(id)
		if (!pending?.name) return undefined
		return {
			type: "tool_use",
			id: pending.id,
			name: pending.name,
			input: this.parsePendingInput(pending),
			signature: pending.signature,
			call_id: pending.call_id,
			isComplete: pending.isComplete,
		}
	}

	getAllFinalizedToolUses(summary?: DiracAssistantToolUseBlock["reasoning_details"]): DiracAssistantToolUseBlock[] {
		const results: DiracAssistantToolUseBlock[] = []
		for (const id of this.pendingToolUses.keys()) {
			const toolUse = this.getFinalizedToolUse(id)
			if (toolUse) results.push({ ...toolUse, reasoning_details: summary })
		}
		return results
	}

	hasToolUse(id: string): boolean {
		return this.pendingToolUses.has(id)
	}

	getParsedToolUseStates(isComplete: boolean = false): ParsedToolUseState[] {
		const results: ParsedToolUseState[] = []
		for (const pending of this.pendingToolUses.values()) {
			if (!pending.name) continue
			const input = this.parsePendingInput(pending)
			const params: Record<string, any> = {}
			if (typeof input === "object" && input !== null) for (const [key, value] of Object.entries(input)) params[key] = value
			results.push({
				id: pending.id,
				name: pending.name,
				input: params,
				signature: pending.signature,
				call_id: pending.call_id,
				isComplete: isComplete || pending.isComplete,
			})
		}
		return results
	}

	private parsePendingInput(pending: PendingToolUse): unknown {
		if (pending.parsedInput != null) return pending.parsedInput
		if (!pending.input) return {}
		try {
			return JSON.parse(pending.input)
		} catch {
			return this.extractPartialJsonFields(pending.input)
		}
	}

	private createPendingToolUse(id: string, name: string, callId?: string): PendingToolUse {
		const jsonParser = new JSONParser()
		const pending: PendingToolUse = {
			id,
			name,
			input: "",
			parsedInput: undefined,
			jsonParser,
			call_id: callId || id || nanoid(8),
			signature: undefined,
			isComplete: false,
		}
		jsonParser.onValue = (info: any) => {
			if (info.stack.length === 0 && info.value && typeof info.value === "object") pending.parsedInput = info.value
		}
		jsonParser.onError = () => {}
		this.pendingToolUses.set(id, pending)
		Session.get().updateToolCall(pending.call_id, pending.name)
		return pending
	}

	// Recovers partial JSON fields from incomplete streaming input.
	private extractPartialJsonFields(partialJson: string): Record<string, any> {
		const result: Record<string, any> = {}
		const stringPattern = /"(\w+)":\s*"((?:[^"\\]|\\.)*)(?:")?/g
		for (const match of partialJson.matchAll(stringPattern))
			result[match[1]] = match[2].replace(ESCAPE_PATTERN, (m) => ESCAPE_MAP[m])
		const arrayPattern = /"(\w+)":\s*\[\s*([^\]]*)\s*\]?/g
		for (const match of partialJson.matchAll(arrayPattern)) {
			result[match[1]] = match[2]
				.split(",")
				.map((v) => v.trim().replace(/^"(.*)"$/, "$1"))
				.filter((v) => v !== "")
		}
		return result
	}
}
