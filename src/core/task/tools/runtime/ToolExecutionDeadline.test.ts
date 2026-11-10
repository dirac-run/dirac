import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { ToolExecutionDeadline, ToolTimeoutError } from "./ToolExecutionDeadline"

function untilAborted(signal: AbortSignal): Promise<string> {
	return new Promise((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), { once: true })
	})
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => { resolve = done })
	return { promise, resolve }
}

describe("ToolExecutionDeadline", () => {
	it("starts its budget with the first execution operation", async () => {
		const clock = sinon.useFakeTimers()
		try {
			const deadline = new ToolExecutionDeadline("list_files", { timeoutMs: 30_000 })
			await clock.tickAsync(15_000)
			let operationSignal: AbortSignal | undefined
			const pending = deadline.run("listing files", (signal) => {
				operationSignal = signal
				return untilAborted(signal)
			})
			const rejection = assert.rejects(pending, ToolTimeoutError)
			await clock.tickAsync(29_999)
			assert.equal(operationSignal?.aborted, false)
			await clock.tickAsync(1)
			await rejection
		} finally {
			clock.restore()
		}
	})

	it("shares one wall-clock budget across sequential operations", async () => {
		const clock = sinon.useFakeTimers()
		try {
			const deadline = new ToolExecutionDeadline("read_file", { timeoutMs: 30_000 })
			await deadline.run("first read", async () => "first")
			await clock.tickAsync(10_000)
			const pending = deadline.run("second read", untilAborted)
			const rejection = assert.rejects(pending, (error: unknown) => {
				assert.ok(error instanceof ToolTimeoutError)
				assert.equal(error.toolName, "read_file")
				assert.equal(error.operation, "second read")
				assert.equal(error.timeoutMs, 30_000)
				return true
			})
			await clock.tickAsync(20_000)
			await rejection
		} finally {
			clock.restore()
		}
	})

	for (const stop of ["timeout", "cancellation"] as const) {
		it(`retains cleanup ownership after ${stop} until the operation settles`, async () => {
			const clock = sinon.useFakeTimers()
			try {
				const controller = new AbortController()
				const cleanup = deferred()
				const deadline = new ToolExecutionDeadline("search_files", {
					timeoutMs: 30_000,
					cancellationSignal: controller.signal,
				})
				let operationSignal!: AbortSignal
				let settled = false
				const pending = deadline.run("searching src", async (signal) => {
					operationSignal = signal
					try {
						return await untilAborted(signal)
					} finally {
						await cleanup.promise
					}
				})
				const reason = new Error("task stopped")
				const rejection = assert.rejects(pending, (error: unknown) => {
					assert.equal(error, stop === "timeout" ? operationSignal.reason : reason)
					return true
				}).then(() => { settled = true })
				if (stop === "timeout") await clock.tickAsync(30_000)
				else controller.abort(reason)
				await clock.tickAsync(1)
				assert.equal(operationSignal.aborted, true)
				assert.equal(settled, false)
				cleanup.resolve()
				await rejection
				assert.equal(settled, true)
			} finally {
				clock.restore()
			}
		})
	}

	it("retains ownership when an operation ignores abort and later resolves", async () => {
		const clock = sinon.useFakeTimers()
		try {
			const cleanup = deferred()
			const deadline = new ToolExecutionDeadline("read_file", { timeoutMs: 10 })
			let settled = false
			const pending = deadline.run("reading", async () => { await cleanup.promise; return "late result" })
			const rejection = assert.rejects(pending, ToolTimeoutError).then(() => { settled = true })
			await clock.tickAsync(100)
			assert.equal(settled, false)
			cleanup.resolve()
			await rejection
		} finally {
			clock.restore()
		}
	})

	it("preserves a distinct cleanup failure as the timeout cause", async () => {
		const clock = sinon.useFakeTimers()
		try {
			const failure = new Error("resource cleanup failed")
			const deadline = new ToolExecutionDeadline("read_file", { timeoutMs: 10 })
			const pending = deadline.run("reading", async (signal) => {
				try {
					return await untilAborted(signal)
				} catch (error) {
					assert.equal(error, signal.reason)
					throw failure
				}
			})
			const rejection = assert.rejects(pending, (error: unknown) => {
				assert.ok(error instanceof ToolTimeoutError)
				assert.equal(error.cause, failure)
				return true
			})
			await clock.tickAsync(10)
			await rejection
		} finally {
			clock.restore()
		}
	})

	it("does not start an operation after cancellation or an exhausted budget", async () => {
		const controller = new AbortController()
		const reason = new Error("task stopped")
		controller.abort(reason)
		const operation = sinon.stub().resolves("unexpected")
		await assert.rejects(new ToolExecutionDeadline("read_file", { cancellationSignal: controller.signal }).run("reading", operation), (error) => error === reason)
		await assert.rejects(new ToolExecutionDeadline("read_file", { timeoutMs: 0 }).run("reading", operation), ToolTimeoutError)
		sinon.assert.notCalled(operation)
	})

	it("preserves ordinary operation failures", async () => {
		const failure = new Error("read failed")
		await assert.rejects(new ToolExecutionDeadline("read_file").run("reading", async () => { throw failure }), (error) => error === failure)
	})
})
