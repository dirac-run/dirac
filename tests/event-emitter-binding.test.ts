import { strict as assert } from "node:assert"
import { EventEmitter } from "events"
import { describe, it } from "mocha"
import type {
	TerminalProcessEvents,
	TerminalCompletionDetails,
	TerminalProcessResultPromise,
} from "@/integrations/terminal/types"

class FakeTerminalProcess extends EventEmitter<TerminalProcessEvents> implements any {
	isHot = false
	waitForShellIntegration = true
	private readonly promise: Promise<void>
	private resolvePromise!: () => void

	constructor() {
		super()
		this.promise = new Promise<void>((resolve) => {
			this.resolvePromise = resolve
		})
	}

	continue(): void {
		this.emit("continue")
		this.resolvePromise()
	}

	getUnretrievedOutput(): string {
		return ""
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
		Promise.reject(error)
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

describe("EventEmitter binding strategies", () => {
	it("Strategy 1a: Direct parameter - standalone variable works", async () => {
		const process = new FakeTerminalProcess()

		assert.equal(typeof process.once, "function")

		let onceCalled = false
		process.once("line", (line: string) => {
			onceCalled = true
		})
		process.sendLine("test line")
		assert.ok(onceCalled, "Direct process.once() should work")
	})

	it("Strategy 1b: Via object property access - the problematic pattern", async () => {
		const process = new FakeTerminalProcess()
		const ctx = { process }

		assert.equal(typeof ctx.process.once, "function")

		let onceCalled = false
		try {
			ctx.process.once("line", (line: string) => {
				onceCalled = true
			})
			process.sendLine("test line")
			assert.ok(onceCalled, "ctx.process.once() should work")
		} catch (err: any) {
			console.log(`[Strategy 1b] Error via property access: ${err.message}`)
			throw err
		}
	})

	it("Strategy 2a: Explicit .call() binding", async () => {
		const process = new FakeTerminalProcess()
		const ctx = { process }

		let onceCalled = false
		try {
			const onceFn = ctx.process.once as (event: string, listener: (...args: any[]) => void) => any
			onceFn.call(ctx.process, "line", (line: string) => {
				onceCalled = true
			})
			process.sendLine("test line")
			assert.ok(onceCalled, ".call() binding should work")
		} catch (err: any) {
			console.log(`[Strategy 2a] Error with .call(): ${err.message}`)
			throw err
		}
	})

	it("Strategy 2b: Explicit .apply() binding", async () => {
		const process = new FakeTerminalProcess()
		const ctx = { process }

		let onceCalled = false
		try {
			const onceFn = ctx.process.once as (...args: any[]) => any
			onceFn.apply(ctx.process, [
				"line",
				(line: string) => {
					onceCalled = true
				},
			])
			process.sendLine("test line")
			assert.ok(onceCalled, ".apply() binding should work")
		} catch (err: any) {
			console.log(`[Strategy 2b] Error with .apply(): ${err.message}`)
			throw err
		}
	})

	it("Strategy 3a: Extract listener to local variable first", async () => {
		const process = new FakeTerminalProcess()

		let onceCalled = false
		const onLine = (line: string) => {
			onceCalled = true
		}

		process.once("line", onLine)
		process.sendLine("test line")
		assert.ok(onceCalled, "Named listener function should work")
	})

	it("Strategy 3b: Extract listener AND pass via context with named function", async () => {
		const process = new FakeTerminalProcess()
		const ctx = { process }

		let onceCalled = false
		const onLine = (line: string) => {
			onceCalled = true
		}

		try {
			ctx.process.once("line", onLine)
			process.sendLine("test line")
			assert.ok(onceCalled, "Named listener via ctx should work")
		} catch (err: any) {
			console.log(`[Strategy 3b] Error: ${err.message}`)
			throw err
		}
	})

	it("Strategy 4a: Proxy wrapper preserving binding", async () => {
		const process = new FakeTerminalProcess()

		const proxy = new Proxy(process, {
			get(target, prop, receiver) {
				const value = (target as any)[prop]
				if (typeof value === "function" && ["on", "once", "emit", "off"].includes(String(prop))) {
					return value.bind(target)
				}
				return value
			},
		})

		assert.equal(typeof proxy.once, "function")
		let onceCalled = false
		proxy.once("line", (line: string) => {
			onceCalled = true
		})
		process.sendLine("test line")
		assert.ok(onceCalled, "Proxy-wrapped process.once should work")
	})

	it("Strategy 4b: Proxy wrapper accessed via context object", async () => {
		const process = new FakeTerminalProcess()

		const proxy = new Proxy(process, {
			get(target, prop, receiver) {
				const value = (target as any)[prop]
				if (typeof value === "function" && ["on", "once", "emit", "off"].includes(String(prop))) {
					return value.bind(target)
				}
				return value
			},
		})

		const ctx = { process: proxy }
		assert.equal(typeof ctx.process.once, "function")

		let onceCalled = false
		ctx.process.once("line", (line: string) => {
			onceCalled = true
		})
		process.sendLine("test line")
		assert.ok(onceCalled, "Proxy via context should work")
	})

	it("Strategy 5a: Pure function with process passed directly - no context object", async () => {
		const process = new FakeTerminalProcess()

		function attachListeners(process: any, onLine: (s: string) => void): void {
			process.once("line", onLine)
		}

		assert.equal(typeof attachListeners, "function")

		let onceCalled = false
		attachListeners(process, () => {
			onceCalled = true
		})
		process.sendLine("test")
		assert.ok(onceCalled, "Direct parameter decomposition should work")
	})

	it("Strategy 5b: Simulating ACTUAL orchestration pattern with direct params", async () => {
		const process = new FakeTerminalProcess()

		let state_completed = false

		function attachCompletionListener(process: any, onCompleted: (details?: TerminalCompletionDetails) => void): void {
			process.once("completed", onCompleted)
		}

		attachCompletionListener(process, () => {
			state_completed = true
		})
		process.complete({ exitCode: 0, signal: null })

		// Wait for setImmediate to fire
		await new Promise((r) => setTimeout(r, 50))
		assert.ok(state_completed, "Direct parameter listeners should work")
	})

	it("Strategy 6: Extract event emitter methods into a plain object wrapper", async () => {
		const process = new FakeTerminalProcess()

		// Wrap EventEmitter in an object that exposes methods directly (not via nested .process)
		const emmitterWrapper = {
			once: process.once.bind(process),
			on: process.on.bind(process),
			emit: process.emit.bind(process),
		}

		let onceCalled = false
		emmitterWrapper.once("line", (line: string) => {
			onceCalled = true
		})
		process.sendLine("test line")
		assert.ok(onceCalled, "Flattened wrapper should work")
	})

	it("Strategy 7: Use a class method instead of function with context object", async () => {
		class ListenerAttacher {
			constructor(private process: any) {}

			attachCompletion(onCompleted: (details?: TerminalCompletionDetails) => void): void {
				this.process.once("completed", onCompleted)
			}
		}

		const process = new FakeTerminalProcess()
		let state_completed = false

		const attacher = new ListenerAttacher(process)
		attacher.attachCompletion(() => {
			state_completed = true
		})
		process.complete({ exitCode: 0, signal: null })

		await new Promise((r) => setTimeout(r, 50))
		assert.ok(state_completed, "Class method binding should work")
	})
})
