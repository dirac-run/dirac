import { TaskStatus } from "@shared/ExtensionMessage"
import { Session } from "@shared/services/Session"
import { READ_ONLY_TOOLS } from "@shared/tools"
import cloneDeep from "clone-deep"
import { ResponseProcessorDependencies } from "../types/response-processor"
import { ResponseFormatter } from "./ResponseFormatter"

// Presents assistant message content to the UI — streams text/reasoning deltas,
// executes tool calls, and manages presentation locking to avoid concurrent renders.
export class AssistantMessagePresenter {
	private currentStreamingContentIndex = 0
	private lastProcessedContentLength = 0
	private presentLocked = false
	private hasPendingUpdates = false
	private presentPromise: Promise<void> | undefined = undefined
	private pendingError?: Error
	private formatter = new ResponseFormatter()

	constructor(private deps: ResponseProcessorDependencies) {}

	get pendingPresentationError(): Error | undefined {
		return this.pendingError
	}
	set pendingPresentationError(e: Error | undefined) {
		this.pendingError = e
	}

	resetState(): void {
		this.pendingError = undefined
		this.currentStreamingContentIndex = 0
		this.lastProcessedContentLength = 0
		this.presentLocked = false
		this.hasPendingUpdates = false
	}

	// Passthrough for tests — delegates to ResponseFormatter.
	sanitizeModelQuirks(content: string): string {
		return this.formatter.sanitizeModelQuirks(content)
	}

	async present(): Promise<void> {
		if (this.presentLocked) {
			this.hasPendingUpdates = true
			return this.presentPromise
		}
		this.presentPromise = this.runPresentationLoop()
		return this.presentPromise
	}

	// Main presentation loop — processes content blocks with re-entrant locking
	private async runPresentationLoop(): Promise<void> {
		this.presentLocked = true
		try {
			do {
				this.hasPendingUpdates = false
				await this.processPendingBlocks()
			} while (this.hasPendingUpdates)
		} finally {
			this.presentLocked = false
			this.presentPromise = undefined
		}
	}

	// Process all pending content blocks
	private async processPendingBlocks(): Promise<void> {
		while (this.currentStreamingContentIndex < this.deps.taskState.assistantMessageContent.length) {
			if (this.deps.taskState.abort) throw new Error("Dirac instance aborted")
			const block = cloneDeep(this.deps.taskState.assistantMessageContent[this.currentStreamingContentIndex])
			const isBlockComplete = this.computeBlockComplete(block)
			await this.processBlock(block, isBlockComplete)
			if (isBlockComplete || this.deps.taskState.didRejectTool) {
				this.currentStreamingContentIndex++
				this.lastProcessedContentLength = 0
			} else break
		}
		this.checkAllBlocksProcessed()
	}

	// Determine if a block is complete based on its flag and position
	private computeBlockComplete(block: any): boolean {
		if (block.isComplete) return true
		const isNotLast = this.currentStreamingContentIndex < this.deps.taskState.assistantMessageContent.length - 1
		const nextIsNotText =
			isNotLast && this.deps.taskState.assistantMessageContent[this.currentStreamingContentIndex + 1].type !== "text"
		return nextIsNotText || !this.deps.taskState.isApiRequestActive
	}

	// Process a single content block by type
	private async processBlock(block: any, isBlockComplete: boolean): Promise<void> {
		switch (block.type) {
			case "text":
				return this.processTextBlock(block, isBlockComplete)
			case "reasoning":
				return this.processReasoningBlock(block, isBlockComplete)
			case "tool_use":
				return this.processToolUseBlock(block, isBlockComplete)
		}
	}

	private async processTextBlock(block: any, isBlockComplete: boolean): Promise<void> {
		if (!isBlockComplete) this.deps.taskState.status = TaskStatus.STREAMING_TEXT
		if (this.deps.taskState.didRejectTool) return
		let content = block.content
		if (content) content = this.formatter.sanitizeModelQuirks(content)
		if (isBlockComplete) content = this.formatter.trimTrailingCodeFence(content)
		const delta = content.slice(this.lastProcessedContentLength)
		if (delta) {
			await this.deps.assistantStreamManager.handleChunk(delta, "text")
			this.lastProcessedContentLength += delta.length
		}
	}

	private async processReasoningBlock(block: any, isBlockComplete: boolean): Promise<void> {
		if (!isBlockComplete) this.deps.taskState.status = TaskStatus.THINKING
		const delta = block.reasoning.slice(this.lastProcessedContentLength)
		if (delta) {
			await this.deps.assistantStreamManager.handleChunk(delta, "reasoning")
			this.lastProcessedContentLength += delta.length
		}
	}

	private async processToolUseBlock(block: any, isBlockComplete: boolean): Promise<void> {
		this.deps.taskState.status = isBlockComplete ? TaskStatus.EXECUTING_TOOL : TaskStatus.BUILDING_TOOL_CALL
		await this.deps.postStateToWebview()
		await this.deps.assistantStreamManager.pauseForToolCall()
		await this.awaitCheckpointIfNeeded(block.name)
		await this.deps.toolExecutor.executeTool(block, isBlockComplete)
		if (block.call_id) Session.get().updateToolCall(block.call_id, block.name)
	}

	// Await initial checkpoint for non-read-only tools
	private async awaitCheckpointIfNeeded(toolName: string): Promise<void> {
		if (!this.deps.taskState.initialCheckpointCommitPromise) return
		if ((READ_ONLY_TOOLS as readonly string[]).includes(toolName)) return
		await this.deps.taskState.initialCheckpointCommitPromise
		this.deps.taskState.initialCheckpointCommitPromise = undefined
	}

	// Mark userMessageContentReady when all blocks are processed and stream is done
	private checkAllBlocksProcessed(): void {
		const allProcessed = this.currentStreamingContentIndex >= this.deps.taskState.assistantMessageContent.length
		if (allProcessed && this.deps.taskState.didCompleteReadingStream) {
			this.deps.taskState.userMessageContentReady = true
		}
	}
}
