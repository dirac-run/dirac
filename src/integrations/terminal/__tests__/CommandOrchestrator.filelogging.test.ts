/**
 * Behavioral tests for CommandOrchestrator file-based logging.
 * Verifies that large outputs trigger file-based logging instead of accumulating in memory.
 * Baseline reference: 1d316d3d — switchToFileBased() was called when output exceeded thresholds.
 */
import assert from "node:assert/strict"
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { DiracAskResponse } from "@shared/WebviewMessage"
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
		const p = this as unknown as FakeTerminalProcess & Partial<TerminalProcessResultPromise>
		p.then = this.promise.then.bind(this.promise)
		p.catch = this.promise.catch.bind(this.promise)
		p.finally = this.promise.finally.bind(this.promise)
		return p as TerminalProcessResultPromise
	}

	sendLine(line: string): void {
		this.emit("line", line)
	}
}

// Callbacks that auto-approve the card interaction so buffering doesn't block
function createCallbacks(): { callbacks: CommandExecutorCallbacks; upsertedTexts: string[] } {
	const upsertedTexts: string[] = []
	return {
		callbacks: {
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
					// Auto-approve so didContinue=true, lines stream directly without blocking
					waitForInteraction: async () => ({ response: DiracAskResponse.APPROVE }) as any,
				}),
				upsertApiStatus: async () => {},
			} as any,
			updateBackgroundCommandState: () => {},
			updateDiracMessage: async () => {},
			getDiracMessages: () => [],
			addToUserMessageContent: () => {},
			getEnvironmentVariables: async () => undefined,
		},
		upsertedTexts,
	}
}

function createTerminalManager(): ITerminalManager {
	return {
		processOutput: (outputLines: string[]) => outputLines.join("\n"),
	} as ITerminalManager
}

// Helper: emit N lines with small periodic delays to let async handlers complete
async function emitLines(process: FakeTerminalProcess, count: number, lineFn: (i: number) => string) {
	for (let i = 0; i < count; i++) {
		process.sendLine(lineFn(i))
		if (i % 100 === 0) await delay(1)
	}
	await delay(10)
}

describe("CommandOrchestrator file-based logging", () => {
	it("activates file logging when output exceeds MAX_LINES_BEFORE_FILE threshold", async () => {
		const { orchestrateCommandExecution } = await import("../CommandOrchestrator")
		const process = new FakeTerminalProcess()
		const { callbacks, upsertedTexts } = createCallbacks()
		const orchestrationPromise = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), callbacks, {
			command: "large-output",
			suppressUserInteraction: true,
		})

		// Emit 1001 lines to trigger MAX_LINES_BEFORE_FILE (1000)
		await emitLines(process, 1001, (i) => `line-${i}`)
		process.complete({ exitCode: 0, signal: null })
		const result: OrchestrationResult = await orchestrationPromise

		// Verify file logging was activated — user should be notified
		const fileNotification = upsertedTexts.find((t) => t.includes("Output is large"))
		assert.ok(fileNotification, "Should have notified user about file-based logging")

		// Result should reference a log file path
		assert.ok(result.logFilePath, "Result should have a logFilePath when file logging activated")
		assert.ok(existsSync(result.logFilePath!), "Log file should exist on disk")

		// Clean up
		try {
			unlinkSync(result.logFilePath!)
		} catch {}
	})

	it("activates file logging when output exceeds MAX_BYTES_BEFORE_FILE threshold", async () => {
		const { orchestrateCommandExecution } = await import("../CommandOrchestrator")
		const process = new FakeTerminalProcess()
		const { callbacks, upsertedTexts } = createCallbacks()
		const orchestrationPromise = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), callbacks, {
			command: "large-bytes",
			suppressUserInteraction: true,
		})

		// Emit lines that exceed 512KB in total bytes (each line ~1KB, need ~513 lines)
		await emitLines(process, 513, () => "x".repeat(1024))
		process.complete({ exitCode: 0, signal: null })
		const result: OrchestrationResult = await orchestrationPromise

		const fileNotification = upsertedTexts.find((t) => t.includes("Output is large"))
		assert.ok(fileNotification, "Should have notified user about file-based logging (byte threshold)")
		assert.ok(result.logFilePath, "Result should have a logFilePath when byte threshold exceeded")

		try {
			unlinkSync(result.logFilePath!)
		} catch {}
	})

	it("writes all output to file after switching to file mode", async () => {
		const { orchestrateCommandExecution } = await import("../CommandOrchestrator")
		const process = new FakeTerminalProcess()
		const { callbacks } = createCallbacks()
		const orchestrationPromise = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), callbacks, {
			command: "file-write-test",
			suppressUserInteraction: true,
		})

		// Emit 1001 lines — first 1000 go to outputLines, line 1001 triggers switch
		await emitLines(process, 1001, (i) => `line-${i}`)
		process.complete({ exitCode: 0, signal: null })
		const result: OrchestrationResult = await orchestrationPromise

		assert.ok(result.logFilePath, "Should have log file path")
		const fileContent = readFileSync(result.logFilePath!, "utf8")
		// All lines should be in the file (existing lines are batch-written, new lines appended)
		assert.ok(fileContent.includes("line-0"), "First line should be in file")
		assert.ok(fileContent.includes("line-1000"), "Last line should be in file")

		try {
			unlinkSync(result.logFilePath!)
		} catch {}
	})

	it("does not activate file logging for small outputs", async () => {
		const { orchestrateCommandExecution } = await import("../CommandOrchestrator")
		const process = new FakeTerminalProcess()
		const { callbacks, upsertedTexts } = createCallbacks()
		const orchestrationPromise = orchestrateCommandExecution(process.asResultPromise(), createTerminalManager(), callbacks, {
			command: "small-output",
		})

		process.sendLine("line one")
		process.sendLine("line two")
		await delay(10)
		process.complete({ exitCode: 0, signal: null })
		const result: OrchestrationResult = await orchestrationPromise

		const fileNotification = upsertedTexts.find((t) => t.includes("Output is large"))
		assert.ok(!fileNotification, "Should NOT notify about file logging for small output")
		assert.ok(!result.logFilePath, "Should NOT have a log file path for small output")
	})
})
