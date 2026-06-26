import assert from "node:assert/strict"
import { EventEmitter } from "events"
import { describe, it } from "mocha"
import type {
	CommandExecutorCallbacks,
	ITerminalManager,
	OrchestrationResult,
	TerminalCompletionDetails,
	TerminalProcessEvents,
	TerminalProcessResultPromise,
} from "../types"

class FakeTerminalProcess extends EventEmitter<TerminalProcessEvents> {
	isHot = false
	private readonly promise: Promise<void>
	private resolvePromise!: () => void
	private rejectPromise!: (error: Error) => void

	constructor() {
		super()
		this.promise = new Promise<void>((resolve, reject) => {
			this.resolvePromise = resolve
			this.rejectPromise = reject
		})
	}

	continue(): void {
		this.emit("continue")
		this.resolvePromise()
	}

	getUnretrievedOutput(): string {
		return ""
	}

	getCompletionDetails(): TerminalCompletionDetails {
		return {}
	}

	complete(details?: TerminalCompletionDetails): void {
		// Use setImmediate to ensure event handlers run before promise resolves
		setImmediate(() => {
			this.emit("completed", details)
			this.emit("continue")
			this.resolvePromise()
		})
	}

	fail(error: Error): void {
		this.emit("error", error)
		this.rejectPromise(error)
	}

	asResultPromise(): TerminalProcessResultPromise {
		const processWithPromise = this as unknown as FakeTerminalProcess & Partial<TerminalProcessResultPromise>
		processWithPromise.then = this.promise.then.bind(this.promise)
		processWithPromise.catch = this.promise.catch.bind(this.promise)
		processWithPromise.finally = this.promise.finally.bind(this.promise)
		return processWithPromise as TerminalProcessResultPromise
	}

	sendLine(line: string): void {
		this.emit("line", line)
	}
}

function createCallbacks(): CommandExecutorCallbacks {
	const upsertedTexts: string[] = []
	return {
		taskMessenger: {
			upsertText: async (text?: string) => {
				if (text) upsertedTexts.push(text)
			},
			streamText: async () => ({
				id: "1",
				append: async () => {},
				close: async () => {},
				setImages: async () => {},
				setFiles: async () => {},
			}),
			createCard: async () => ({
				id: "1",
				update: async () => {},
				appendBody: async () => {},
				finalize: async () => {},
				waitForInteraction: async () => ({ response: 0 }) as any, // default to no interaction
			}),
			upsertApiStatus: async () => {},
		} as any,
		updateBackgroundCommandState: () => {},
		updateDiracMessage: async () => {},
		getDiracMessages: () => [],
		addToUserMessageContent: () => {},
		getEnvironmentVariables: async () => undefined,
	}
}

function createTerminalManager(): ITerminalManager {
	return {
		processOutput: (outputLines: string[]) => outputLines.join("\n"),
	} as ITerminalManager
}

describe("CommandOrchestrator line buffering", () => {
	it.skip("accumulates lines and includes them in result - needs proper fake process timing") // complex timing with flushBuffer + createCard

	it("handles multiple lines of output", async () => {
		const { orchestrateCommandExecution } = await import("../CommandOrchestrator")
		const process = new FakeTerminalProcess()
		const orchestrationPromise = orchestrateCommandExecution(
			process.asResultPromise(),
			createTerminalManager(),
			createCallbacks(),
			{ command: "echo test" },
		)

		process.sendLine("line one")
		process.sendLine("line two")
		process.sendLine("line three")
		process.complete({ exitCode: 0, signal: null })
		const result: OrchestrationResult = await orchestrationPromise

		assert.ok((result.result as string).includes("line one"))
		assert.ok((result.result as string).includes("line two"))
		assert.ok((result.result as string).includes("line three"))
	})
})

describe("CommandOrchestrator completion handling", () => {
	it("handles process error gracefully", async () => {
		const { orchestrateCommandExecution } = await import("../CommandOrchestrator")
		const process = new FakeTerminalProcess()
		const orchestrationPromise = orchestrateCommandExecution(
			process.asResultPromise(),
			createTerminalManager(),
			createCallbacks(),
			{ command: "fail" },
		)

		process.fail(new Error("command failed"))

		try {
			await orchestrationPromise
			assert.fail("Should have thrown")
		} catch (err: any) {
			assert.equal(err.message, "command failed")
		}
	})
})
