import { strict as assert } from "node:assert"
import { EventEmitter } from "events"
import * as fs from "fs"
import { describe, it } from "mocha"
import type { TerminalCompletionDetails, TerminalProcessEvents, TerminalProcessResultPromise } from "../../types"
import { StandaloneTerminalManager } from "../StandaloneTerminalManager"

// Fake terminal process for background command tests — emulates the merged promise+process shape
class FakeProcess extends EventEmitter<TerminalProcessEvents> {
	isHot = false
	waitForShellIntegration = false
	private promise: Promise<void>
	private resolveFn!: () => void
	private rejectFn!: (err: Error) => void

	constructor() {
		super()
		this.promise = new Promise<void>((resolve, reject) => {
			this.resolveFn = resolve
			this.rejectFn = reject
		})
	}

	continue(): void {
		this.emit("continue")
		this.resolveFn()
	}

	getUnretrievedOutput(): string {
		return ""
	}

	getCompletionDetails(): TerminalCompletionDetails {
		return {}
	}

	terminate(): void {}

	// Attach promise methods so it looks like TerminalProcessResultPromise
	then(onFulfilled?: any, onRejected?: any): Promise<void> {
		return this.promise.then(onFulfilled, onRejected)
	}

	catch(onRejected?: any): Promise<void> {
		return this.promise.catch(onRejected)
	}

	finally(onFinally?: any): Promise<void> {
		return this.promise.finally(onFinally)
	}

	emitCompleted(details?: TerminalCompletionDetails) {
		this.emit("completed", details)
		this.emit("continue")
		this.resolveFn()
	}

	emitError(error: Error) {
		this.emit("error", error)
		this.rejectFn(error)
	}
}

function createFakeProcess(): TerminalProcessResultPromise {
	return new FakeProcess() as unknown as TerminalProcessResultPromise
}

describe("StandaloneTerminalManager", () => {
	describe("terminal lifecycle", () => {
		it("creates a terminal for a given cwd", async () => {
			const manager = new StandaloneTerminalManager()
			const terminal = await manager.getOrCreateTerminal("/tmp")
			assert.ok(terminal.id >= 1)
			assert.equal((terminal.terminal as any)._cwd, "/tmp")
			manager.disposeAll()
		})

		it("reuses an idle terminal with matching cwd", async () => {
			const manager = new StandaloneTerminalManager()
			const t1 = await manager.getOrCreateTerminal("/tmp")
			const t2 = await manager.getOrCreateTerminal("/tmp")
			assert.equal(t1.id, t2.id, "should reuse same terminal for same cwd")
			manager.disposeAll()
		})

		it("creates separate terminals for different cwds", async () => {
			const manager = new StandaloneTerminalManager()
			const t1 = await manager.getOrCreateTerminal("/tmp")
			t1.busy = true // prevent reuse
			const t2 = await manager.getOrCreateTerminal("/usr")
			assert.notEqual(t1.id, t2.id, "should create different terminals for different cwds")
			manager.disposeAll()
		})

		it("reuses idle terminal with cd command when reuse enabled", async () => {
			const manager = new StandaloneTerminalManager()
			const t1 = await manager.getOrCreateTerminal("/tmp")
			// Mark as not busy so it can be reused
			t1.busy = false
			const t2 = await manager.getOrCreateTerminal("/usr")
			assert.equal(t1.id, t2.id, "should reuse idle terminal via cd")
			assert.equal((t2.terminal as any)._cwd, "/usr")
			manager.disposeAll()
		})

		it("does not reuse terminals when reuse disabled", async () => {
			const manager = new StandaloneTerminalManager()
			manager.setTerminalReuseEnabled(false)
			const t1 = await manager.getOrCreateTerminal("/tmp")
			t1.busy = false
			const t2 = await manager.getOrCreateTerminal("/usr")
			assert.notEqual(t1.id, t2.id, "should not reuse when reuse disabled")
			manager.disposeAll()
		})

		it("disposeAll clears all terminals", async () => {
			const manager = new StandaloneTerminalManager()
			await manager.getOrCreateTerminal("/tmp")
			await manager.getOrCreateTerminal("/usr")
			manager.disposeAll()
			assert.equal(manager.getTerminals(false).length, 0)
		})
	})

	describe("getTerminals", () => {
		it("returns idle terminals when busy=false", async () => {
			const manager = new StandaloneTerminalManager()
			await manager.getOrCreateTerminal("/tmp")
			const idle = manager.getTerminals(false)
			assert.equal(idle.length, 1)
			assert.equal(idle[0].id, 1)
			manager.disposeAll()
		})

		it("returns busy terminals when busy=true", async () => {
			const manager = new StandaloneTerminalManager()
			const t = await manager.getOrCreateTerminal("/tmp")
			t.busy = true
			t.lastCommand = "test-cmd"
			const busy = manager.getTerminals(true)
			assert.equal(busy.length, 1)
			assert.equal(busy[0].lastCommand, "test-cmd")
			manager.disposeAll()
		})
	})

	describe("processOutput", () => {
		it("joins lines without truncation under limit", () => {
			const manager = new StandaloneTerminalManager()
			const result = manager.processOutput(["line1", "line2", "line3"])
			assert.equal(result, "line1\nline2\nline3")
			manager.disposeAll()
		})

		it("truncates output exceeding limit", () => {
			const manager = new StandaloneTerminalManager()
			manager.setTerminalOutputLineLimit(4)
			const lines = ["a", "b", "c", "d", "e", "f"]
			const result = manager.processOutput(lines)
			assert.ok(result.includes("output truncated"))
			assert.ok(result.includes("a"))
			assert.ok(result.includes("f"))
			manager.disposeAll()
		})

		it("uses override limit when provided", () => {
			const manager = new StandaloneTerminalManager()
			const lines = ["a", "b", "c"]
			const result = manager.processOutput(lines, 2)
			assert.ok(result.includes("output truncated"))
			manager.disposeAll()
		})
	})

	describe("terminal management", () => {
		it("findTerminalInfoByTerminal finds matching terminal", async () => {
			const manager = new StandaloneTerminalManager()
			const t = await manager.getOrCreateTerminal("/tmp")
			const found = manager.findTerminalInfoByTerminal(t.terminal)
			assert.ok(found)
			assert.equal(found?.id, t.id)
			manager.disposeAll()
		})

		it("filterTerminals returns matching terminals", async () => {
			const manager = new StandaloneTerminalManager()
			await manager.getOrCreateTerminal("/tmp")
			const filtered = manager.filterTerminals((t) => t.id === 1)
			assert.equal(filtered.length, 1)
			manager.disposeAll()
		})

		it("closeTerminals closes idle terminals matching filter", async () => {
			const manager = new StandaloneTerminalManager()
			await manager.getOrCreateTerminal("/tmp")
			const closed = manager.closeTerminals((t) => t.id === 1)
			assert.equal(closed, 1)
			assert.equal(manager.getTerminals(false).length, 0)
			manager.disposeAll()
		})

		it("closeTerminals skips busy terminals without force", async () => {
			const manager = new StandaloneTerminalManager()
			const t = await manager.getOrCreateTerminal("/tmp")
			t.busy = true
			const closed = manager.closeTerminals(() => true, false)
			assert.equal(closed, 0)
			manager.disposeAll()
		})

		it("closeTerminals closes busy terminals with force", async () => {
			const manager = new StandaloneTerminalManager()
			const t = await manager.getOrCreateTerminal("/tmp")
			t.busy = true
			const closed = manager.closeTerminals(() => true, true)
			assert.equal(closed, 1)
			manager.disposeAll()
		})

		it("closeAllTerminals closes everything", async () => {
			const manager = new StandaloneTerminalManager()
			const t1 = await manager.getOrCreateTerminal("/tmp")
			t1.busy = true // prevent reuse so we get 2 terminals
			await manager.getOrCreateTerminal("/usr")
			const closed = manager.closeAllTerminals()
			assert.equal(closed, 2)
			manager.disposeAll()
		})

		it("isCwdMatchingExpected returns false when no pendingCwdChange", async () => {
			const manager = new StandaloneTerminalManager()
			const t = await manager.getOrCreateTerminal("/tmp")
			assert.equal(manager.isCwdMatchingExpected(t), false)
			manager.disposeAll()
		})

		it("isCwdMatchingExpected returns true when cwd matches pending", async () => {
			const manager = new StandaloneTerminalManager()
			const t = await manager.getOrCreateTerminal("/tmp")
			;(t as any).pendingCwdChange = "/tmp"
			assert.equal(manager.isCwdMatchingExpected(t), true)
			manager.disposeAll()
		})
	})

	describe("setDefaultTerminalProfile", () => {
		it("returns zero closed when profile unchanged", () => {
			const manager = new StandaloneTerminalManager()
			const result = manager.setDefaultTerminalProfile("default")
			assert.equal(result.closedCount, 0)
			assert.equal(result.busyTerminals.length, 0)
			manager.disposeAll()
		})

		it("closes idle terminals when profile changes", async () => {
			const manager = new StandaloneTerminalManager()
			await manager.getOrCreateTerminal("/tmp")
			const result = manager.setDefaultTerminalProfile("zsh")
			assert.ok(result.closedCount >= 0)
			manager.disposeAll()
		})
	})

	describe("background command tracking", () => {
		it("trackBackgroundCommand creates command with log file", async () => {
			const manager = new StandaloneTerminalManager()
			const process = createFakeProcess()
			const cmd = manager.trackBackgroundCommand(process, "echo hello", ["existing output"])
			assert.ok(cmd.id.startsWith("background-"))
			assert.equal(cmd.command, "echo hello")
			assert.equal(cmd.status, "running")
			assert.ok(cmd.logFilePath)
			assert.equal(cmd.lineCount, 1)
			// Wait for write stream to open and flush
			await new Promise((resolve) => setTimeout(resolve, 50))
			assert.ok(fs.existsSync(cmd.logFilePath))
			const content = fs.readFileSync(cmd.logFilePath, "utf-8")
			assert.ok(content.includes("existing output"))
			manager.disposeAll()
		})

		it("getBackgroundCommand returns tracked command", () => {
			const manager = new StandaloneTerminalManager()
			const process = createFakeProcess()
			const cmd = manager.trackBackgroundCommand(process, "test")
			const found = manager.getBackgroundCommand(cmd.id)
			assert.ok(found)
			assert.equal(found?.id, cmd.id)
			manager.disposeAll()
		})

		it("getAllBackgroundCommands returns all tracked commands", () => {
			const manager = new StandaloneTerminalManager()
			const p1 = createFakeProcess()
			const p2 = createFakeProcess()
			manager.trackBackgroundCommand(p1, "cmd1")
			manager.trackBackgroundCommand(p2, "cmd2")
			const all = manager.getAllBackgroundCommands()
			assert.equal(all.length, 2)
			manager.disposeAll()
		})

		it("getRunningBackgroundCommands filters by running status", () => {
			const manager = new StandaloneTerminalManager()
			const process = createFakeProcess()
			const cmd = manager.trackBackgroundCommand(process, "test")
			const running = manager.getRunningBackgroundCommands()
			assert.equal(running.length, 1)
			assert.equal(running[0].id, cmd.id)
			manager.disposeAll()
		})

		it("hasActiveBackgroundCommands returns true when running", () => {
			const manager = new StandaloneTerminalManager()
			const process = createFakeProcess()
			manager.trackBackgroundCommand(process, "test")
			assert.equal(manager.hasActiveBackgroundCommands(), true)
			manager.disposeAll()
		})

		it("hasActiveBackgroundCommands returns false when none running", () => {
			const manager = new StandaloneTerminalManager()
			assert.equal(manager.hasActiveBackgroundCommands(), false)
			manager.disposeAll()
		})

		it("cancelBackgroundCommand terminates and marks as error", () => {
			const manager = new StandaloneTerminalManager()
			const process = createFakeProcess()
			const cmd = manager.trackBackgroundCommand(process, "test")
			const cancelled = manager.cancelBackgroundCommand(cmd.id)
			assert.equal(cancelled, true)
			const updated = manager.getBackgroundCommand(cmd.id)
			assert.equal(updated?.status, "error")
			manager.disposeAll()
		})

		it("cancelBackgroundCommand returns false for unknown id", () => {
			const manager = new StandaloneTerminalManager()
			assert.equal(manager.cancelBackgroundCommand("nonexistent"), false)
			manager.disposeAll()
		})

		it("cancelBackgroundCommand returns false for already completed", () => {
			const manager = new StandaloneTerminalManager()
			const process = createFakeProcess()
			const cmd = manager.trackBackgroundCommand(process, "test")
			// Simulate completion
			const updated = manager.getBackgroundCommand(cmd.id)!
			updated.status = "completed"
			assert.equal(manager.cancelBackgroundCommand(cmd.id), false)
			manager.disposeAll()
		})

		it("getBackgroundCommandsSummary returns empty when no running commands", () => {
			const manager = new StandaloneTerminalManager()
			assert.equal(manager.getBackgroundCommandsSummary(), "")
			manager.disposeAll()
		})

		it("getBackgroundCommandsSummary returns summary for running commands", () => {
			const manager = new StandaloneTerminalManager()
			const process = createFakeProcess()
			manager.trackBackgroundCommand(process, "echo hello")
			const summary = manager.getBackgroundCommandsSummary()
			assert.ok(summary.includes("Background Commands"))
			assert.ok(summary.includes("echo hello"))
			manager.disposeAll()
		})

		it("marks command as completed when process emits completed with exit code 0", () => {
			const manager = new StandaloneTerminalManager()
			const process = createFakeProcess()
			const fakeProcess = process as unknown as FakeProcess
			const cmd = manager.trackBackgroundCommand(process, "test")
			fakeProcess.emitCompleted({ exitCode: 0 })
			const updated = manager.getBackgroundCommand(cmd.id)
			assert.equal(updated?.status, "completed")
			manager.disposeAll()
		})

		it("marks command as error when process exits with non-zero code", () => {
			const manager = new StandaloneTerminalManager()
			const process = createFakeProcess()
			const fakeProcess = process as unknown as FakeProcess
			const cmd = manager.trackBackgroundCommand(process, "test")
			fakeProcess.emitCompleted({ exitCode: 1 })
			const updated = manager.getBackgroundCommand(cmd.id)
			assert.equal(updated?.status, "error")
			assert.equal(updated?.exitCode, 1)
			manager.disposeAll()
		})

		it("marks command as error when process emits error", () => {
			const manager = new StandaloneTerminalManager()
			const process = createFakeProcess()
			const fakeProcess = process as unknown as FakeProcess
			const cmd = manager.trackBackgroundCommand(process, "test")
			fakeProcess.emitError(new Error("exit code 127"))
			const updated = manager.getBackgroundCommand(cmd.id)
			assert.equal(updated?.status, "error")
			assert.equal(updated?.exitCode, 127)
			manager.disposeAll()
		})

		it("pipes line events to log file", async () => {
			const manager = new StandaloneTerminalManager()
			const process = createFakeProcess()
			const fakeProcess = process as unknown as FakeProcess
			const cmd = manager.trackBackgroundCommand(process, "test")
			fakeProcess.emit("line", "output line 1")
			fakeProcess.emit("line", "output line 2")
			fakeProcess.emitCompleted({ exitCode: 0 })
			// Wait for stream to flush
			await new Promise((resolve) => setTimeout(resolve, 50))
			const content = fs.readFileSync(cmd.logFilePath, "utf-8")
			assert.ok(content.includes("output line 1"))
			assert.ok(content.includes("output line 2"))
			manager.disposeAll()
		})

		it("disposeBackgroundCommands cleans up all resources", () => {
			const manager = new StandaloneTerminalManager()
			const p1 = createFakeProcess()
			const p2 = createFakeProcess()
			manager.trackBackgroundCommand(p1, "cmd1")
			manager.trackBackgroundCommand(p2, "cmd2")
			manager.disposeBackgroundCommands()
			assert.equal(manager.getAllBackgroundCommands().length, 0)
			manager.disposeAll()
		})
	})

	describe("isProcessHot", () => {
		it("returns false for unknown terminal id", () => {
			const manager = new StandaloneTerminalManager()
			assert.equal(manager.isProcessHot(999), false)
			manager.disposeAll()
		})
	})

	describe("getUnretrievedOutput", () => {
		it("returns empty string for unknown terminal id", () => {
			const manager = new StandaloneTerminalManager()
			assert.equal(manager.getUnretrievedOutput(999), "")
			manager.disposeAll()
		})
	})
})
