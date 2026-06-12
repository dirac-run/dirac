import { JSONParser } from "@streamparser/json"
import { nanoid } from "nanoid"
import {
    DiracAssistantRedactedThinkingBlock,
    DiracAssistantThinkingBlock,
    DiracAssistantToolUseBlock,
    DiracReasoningDetailParam,
    DiracAssistantContent,
} from "@/shared/messages/content"
import { Session } from "@/shared/services/Session"

export interface ParsedToolUseState {
    id: string
    name: string
    input: Record<string, any>
    signature?: string
    call_id: string
    isComplete: boolean
}

export interface PendingToolUse {
    id: string
    name: string
    input: string
    parsedInput?: unknown
    signature?: string
    jsonParser?: JSONParser
    call_id: string
    isComplete: boolean
}

interface ToolUseDeltaBlock {
    id?: string
    type?: string
    name?: string
    input?: string
    signature?: string
}

export interface ReasoningDelta {
    id?: string
    reasoning?: string
    signature?: string
    details?: any[]
    redacted_data?: any
}

export interface PendingReasoning {
    id?: string
    content: string
    signature: string
    redactedThinking: DiracAssistantRedactedThinkingBlock[]
    summary: unknown[] | DiracReasoningDetailParam[]
    isComplete: boolean
}

const ESCAPE_MAP: Record<string, string> = {
    "\\n": "\n",
    "\\t": "\t",
    "\\r": "\r",
    '\\"': '"',
    "\\\\": "\\",
}

const ESCAPE_PATTERN = /\\[ntr"\\]/g

export class StreamResponseHandler {
    private lastActiveId: string | undefined
    private toolUseHandler = new ToolUseHandler()
    private reasoningHandler = new ReasoningHandler()
    private blockSequence: string[] = []
    private textBlocks = new Map<string, { text: string; signature?: string }>()

    private _requestId: string | undefined

    public setRequestId(id?: string) {
        if (!this._requestId && id) {
            this._requestId = id
        }
    }

    public get requestId() {
        return this._requestId
    }

    public getParsedToolUseStates(isComplete: boolean = false): ParsedToolUseState[] {
        return this.toolUseHandler.getParsedToolUseStates(isComplete)
    }

    public getHandlers() {
        return {
            toolUseHandler: this.toolUseHandler,
            reasonsHandler: this.reasoningHandler,
        }
    }

    private recordId(id: string) {
        if (!this.blockSequence.includes(id)) {
            if (this.lastActiveId && this.lastActiveId !== id) {
                this.toolUseHandler.markAsComplete(this.lastActiveId)
                this.reasoningHandler.markAsComplete(this.lastActiveId)
            }
            this.lastActiveId = id
            this.blockSequence.push(id)
        }
    }

    public processTextDelta(delta: { id?: string; text?: string; signature?: string }) {
        let id = delta.id
        if (!id) {
            if (this.lastActiveId && this.textBlocks.has(this.lastActiveId)) {
                id = this.lastActiveId
            } else {
                id = "text_" + nanoid(8)
            }
        }
        this.recordId(id)
        let textData = this.textBlocks.get(id)
        if (!textData) {
            textData = { text: "" }
            this.textBlocks.set(id, textData)
        }
        if (delta.text) {
            textData.text += delta.text
        }
        if (delta.signature) {
            textData.signature = delta.signature
        }
    }

    public processReasoningDelta(delta: ReasoningDelta) {
        const id = delta.id || this.reasoningHandler.getLastReasoningId() || "default_reasoning"
        this.recordId(id)
        this.reasoningHandler.processReasoningDelta({ ...delta, id })
    }

    public processToolUseDelta(delta: ToolUseDeltaBlock, call_id?: string) {
        const id = delta.id || "default_tool_use"
        this.recordId(id)
        this.toolUseHandler.processToolUseDelta({ ...delta, id }, call_id)
    }

    public getOrderedBlocks(): DiracAssistantContent[] {
        const blocks: DiracAssistantContent[] = []
        for (const id of this.blockSequence) {
            if (this.reasoningHandler.hasReasoning(id)) {
                // Add redacted thinking first if any
                const redacted = this.reasoningHandler.getRedactedThinkingForId(id)
                blocks.push(...redacted)

                const reasoningBlock = this.reasoningHandler.getReasoningBlock(id)
                if (reasoningBlock) {
                    blocks.push(reasoningBlock)
                }
            } else if (this.toolUseHandler.hasToolUse(id)) {
                const toolUse = this.toolUseHandler.getFinalizedToolUse(id)
                if (toolUse) {
                    blocks.push(toolUse)
                }
            } else if (this.textBlocks.has(id)) {
                const textData = this.textBlocks.get(id)!
                blocks.push({
                    type: "text",
                    text: textData.text,
                    signature: textData.signature,
                    call_id: id,
                })
            }
        }
        return blocks
    }

    public reset() {
        this._requestId = undefined
        this.toolUseHandler = new ToolUseHandler()
        this.reasoningHandler = new ReasoningHandler()
        this.blockSequence = []
        this.textBlocks.clear()
        this.lastActiveId = undefined
    }
}

/**
 * Handles streaming native tool use blocks and converts them to DiracAssistantToolUseBlock format
 */
class ToolUseHandler {
    markAsComplete(id: string) {
        const pending = this.pendingToolUses.get(id)
        if (pending) {
            pending.isComplete = true
        }
    }
    private pendingToolUses = new Map<string, PendingToolUse>()

    processToolUseDelta(delta: ToolUseDeltaBlock, call_id?: string): void {
        if (!delta.id) {
            return
        }

        let pending = this.pendingToolUses.get(delta.id)
        if (!pending) {
            pending = this.createPendingToolUse(delta.id, delta.name || "", call_id)
        }

        if (delta.name) {
            pending.name = delta.name
        }

        if (delta.signature) {
            pending.signature = delta.signature
        }

        if (delta.input) {
            pending.input += delta.input
            try {
                pending.jsonParser?.write(delta.input)
            } catch {
                // Expected during streaming - JSONParser may not have complete JSON yet
            }
        }
    }

    getFinalizedToolUse(id: string): DiracAssistantToolUseBlock & { isComplete: boolean } | undefined {
        const pending = this.pendingToolUses.get(id)
        if (!pending?.name) {
            return undefined
        }

        const input = this.parsePendingInput(pending)

        return {
            type: "tool_use",
            id: pending.id,
            name: pending.name,
            input,
            signature: pending.signature,
            call_id: pending.call_id,
            isComplete: pending.isComplete,
        }
    }

    getAllFinalizedToolUses(summary?: DiracAssistantToolUseBlock["reasoning_details"]): DiracAssistantToolUseBlock[] {
        const results: DiracAssistantToolUseBlock[] = []
        for (const id of this.pendingToolUses.keys()) {
            const toolUse = this.getFinalizedToolUse(id)
            if (toolUse) {
                results.push({ ...toolUse, reasoning_details: summary })
            }
        }
        return results
    }

    hasToolUse(id: string): boolean {
        return this.pendingToolUses.has(id)
    }

    getParsedToolUseStates(isComplete: boolean = false): ParsedToolUseState[] {
        const results: ParsedToolUseState[] = []
        const pendingToolUses = this.pendingToolUses.values()

        for (const pending of pendingToolUses) {
            if (!pending.name) {
                continue
            }

            const input = this.parsePendingInput(pending)

            const params: Record<string, any> = {}
            if (typeof input === "object" && input !== null) {
                for (const [key, value] of Object.entries(input)) {
                    params[key] = value
                }
            }

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
        if (pending.parsedInput != null) {
            return pending.parsedInput
        }

        if (!pending.input) {
            return {}
        }

        try {
            return JSON.parse(pending.input)
        } catch {
            return this.extractPartialJsonFields(pending.input)
        }
    }


    private createPendingToolUse(id: string, name: string, callId?: string): PendingToolUse {
        const jsonParser = new JSONParser()
        jsonParser.onValue = (info: any) => {
            if (info.stack.length === 0 && info.value && typeof info.value === "object") {
                pending.parsedInput = info.value
            }
        }

        jsonParser.onError = () => { }

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

        this.pendingToolUses.set(id, pending)
        Session.get().updateToolCall(pending.call_id, pending.name)

        return pending
    }

    private extractPartialJsonFields(partialJson: string): Record<string, any> {
        const result: Record<string, any> = {}
        // Match string values: "key": "value"
        const stringPattern = /"(\w+)":\s*"((?:[^"\\]|\\.)*)(?:")?/g
        for (const match of partialJson.matchAll(stringPattern)) {
            result[match[1]] = match[2].replace(ESCAPE_PATTERN, (m) => ESCAPE_MAP[m])
        }
        // Match array values: "key": ["val1", "val2"]
        const arrayPattern = /"(\w+)":\s*\[\s*([^\]]*)\s*\]?/g
        for (const match of partialJson.matchAll(arrayPattern)) {
            const key = match[1]
            const arrayContent = match[2]
            const values = arrayContent
                .split(",")
                .map((v) => v.trim().replace(/^"(.*)"$/, "$1"))
                .filter((v) => v !== "")
            result[key] = values
        }
        return result
    }
}

/**
 * Handles streaming reasoning content and converts it to the appropriate message format
 */
class ReasoningHandler {
    markAsComplete(id: string) {
        const pending = this.pendingReasonings.get(id)
        if (pending) {
            pending.isComplete = true
        }
    }
    private pendingReasonings = new Map<string, PendingReasoning>()
    private lastReasoningId: string | undefined

    public hasReasoning(id: string): boolean {
        return this.pendingReasonings.has(id)
    }

    public getLastReasoningId(): string | undefined {
        return this.lastReasoningId
    }

    public getReasoningBlock(id: string): DiracAssistantThinkingBlock | null {
        const pending = this.pendingReasonings.get(id)
        if (pending) {
            return this.mapToThinkingBlock(pending)
        }
        return null
    }

    public getRedactedThinkingForId(id: string): DiracAssistantRedactedThinkingBlock[] {
        const pending = this.pendingReasonings.get(id)
        return pending?.redactedThinking || []
    }

    processReasoningDelta(delta: ReasoningDelta): void {
        const id = delta.id || this.lastReasoningId
        if (!id) return

        this.lastReasoningId = id
        let pending = this.pendingReasonings.get(id)
        if (!pending) {
            pending = {
                isComplete: false,
                id,
                content: "",
                signature: "",
                redactedThinking: [],
                summary: [],
            }
            this.pendingReasonings.set(id, pending)
        }

        if (delta.reasoning) {
            pending.content += delta.reasoning
        }
        if (delta.signature) {
            pending.signature = delta.signature
        }
        if (delta.details) {
            if (Array.isArray(delta.details)) {
                pending.summary.push(...delta.details)
            } else {
                pending.summary.push(delta.details)
            }
        }
        if (delta.redacted_data) {
            pending.redactedThinking.push({
                type: "redacted_thinking",
                data: delta.redacted_data,
                call_id: delta.id || pending.id,
            })
        }
    }

    getCurrentReasoning(): DiracAssistantThinkingBlock | null {
        if (this.lastReasoningId) {
            const pending = this.pendingReasonings.get(this.lastReasoningId)
            if (pending) {
                return this.mapToThinkingBlock(pending)
            }
        }
        return null
    }

    getAllReasoningBlocks(): DiracAssistantThinkingBlock[] {
        const results: DiracAssistantThinkingBlock[] = []
        for (const pending of this.pendingReasonings.values()) {
            const block = this.mapToThinkingBlock(pending)
            if (block) {
                results.push(block)
            }
        }
        return results
    }

    private mapToThinkingBlock(pending: PendingReasoning): DiracAssistantThinkingBlock & { isComplete: boolean } | null {
        if (!pending.summary.length && !pending.content && pending.redactedThinking.length > 0) {
            return null
        }

        if (!pending.signature && pending.summary.length) {
            const lastSummary = pending.summary.at(-1)
            if (lastSummary && typeof lastSummary === "object" && "signature" in lastSummary) {
                if (typeof lastSummary.signature === "string") {
                    pending.signature = lastSummary.signature
                }
            }
        }

        return {
            type: "thinking",
            thinking: pending.content,
            signature: pending.signature,
            summary: pending.summary,
            call_id: pending.id,
            isComplete: pending.isComplete,
        }
    }

    getRedactedThinking(): DiracAssistantRedactedThinkingBlock[] {
        const results: DiracAssistantRedactedThinkingBlock[] = []
        for (const pending of this.pendingReasonings.values()) {
            results.push(...pending.redactedThinking)
        }
        return results
    }

    reset(): void {
        this.pendingReasonings.clear()
        this.lastReasoningId = undefined
    }
}
