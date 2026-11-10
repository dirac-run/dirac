import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { ToolExecutionDeadline, ToolTimeoutError } from "./ToolExecutionDeadline"

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
	return { promise, resolve, reject }
}

describe("ToolExecutionDeadline service-owned observation", () => {
	for (const stop of ["timeout", "cancellation"] as const) {
		for (const late of ["resolve", "reject"] as const) {
			it(`bounds ${stop} without joining a service query that later ${late}s`, async () => {
				const clock = sinon.useFakeTimers()
				const unhandled = sinon.spy()
				process.on("unhandledRejection", unhandled)
				try {
					const controller = new AbortController()
					const query = deferred<string>()
					const deadline = new ToolExecutionDeadline("inspect_ast", { timeoutMs: 10, cancellationSignal: controller.signal })
					let signal!: AbortSignal
					const commit = sinon.spy()
					const pending = deadline.observe("querying service", (operationSignal) => {
						signal = operationSignal
						return query.promise
					}).then(commit)
					const reason = new Error("cancelled")
					const rejection = assert.rejects(pending, (error) => stop === "timeout" ? error instanceof ToolTimeoutError : error === reason)
					if (stop === "timeout") await clock.tickAsync(10)
					else controller.abort(reason)
					await rejection
					assert.equal(signal.aborted, true)
					assert.equal(clock.countTimers(), 0)
					if (late === "resolve") query.resolve("late result")
					else query.reject(new Error("late service rejection"))
					await clock.tickAsync(0)
					sinon.assert.notCalled(commit)
					sinon.assert.notCalled(unhandled)
				} finally {
					process.removeListener("unhandledRejection", unhandled)
					clock.restore()
				}
			})
		}
	}

	it("observes rejection when the query synchronously cancels its observer", async () => {
		const controller = new AbortController()
		const reason = new Error("cancelled inside query")
		const failure = new Error("late query failure")
		const unhandled = sinon.spy()
		process.on("unhandledRejection", unhandled)
		try {
			await assert.rejects(new ToolExecutionDeadline("diagnostics_scan", { cancellationSignal: controller.signal }).observe("preparing", () => {
				controller.abort(reason)
				return Promise.reject(failure)
			}), (error) => error === reason)
			await new Promise<void>((resolve) => setImmediate(resolve))
			sinon.assert.notCalled(unhandled)
		} finally {
			process.removeListener("unhandledRejection", unhandled)
		}
	})

	it("does not invoke a pre-aborted query", async () => {
		const controller = new AbortController()
		const reason = new Error("already cancelled")
		controller.abort(reason)
		const query = sinon.stub().resolves("unexpected")
		await assert.rejects(new ToolExecutionDeadline("diagnostics_scan", { cancellationSignal: controller.signal }).observe("preparing", query), (error) => error === reason)
		sinon.assert.notCalled(query)
	})

	it("shares the execution budget with owned operations", async () => {
		const clock = sinon.useFakeTimers()
		try {
			const deadline = new ToolExecutionDeadline("read_file", { timeoutMs: 10 })
			await deadline.run("owned read", async () => "first")
			await clock.tickAsync(6)
			const rejection = assert.rejects(deadline.observe("service query", () => new Promise(() => { })), ToolTimeoutError)
			await clock.tickAsync(4)
			await rejection
		} finally {
			clock.restore()
		}
	})
})
