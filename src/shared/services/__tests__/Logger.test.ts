/**
 * Characterization tests for Logger.
 * Captures current behavior — bugs and all.
 *
 * Phase 0 — Prerequisite coverage for refactoring
 */
import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import sinon from "sinon"
import { Logger } from "../Logger"

describe("Logger", () => {
	let sandbox: sinon.SinonSandbox
	let stderrSpy: sinon.SinonStub

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		stderrSpy = sandbox.stub(process.stderr, "write")
		// Clear subscribers between tests
		;(Logger as any).subscribers.clear()
	})

	afterEach(() => {
		sandbox.restore()
	})

	// ---------------------------------------------------------------
	describe("log levels", () => {
		it("error outputs with ERROR prefix", () => {
			Logger.error("test error")
			stderrSpy.calledOnce.should.be.true()
			const output = stderrSpy.firstCall.args[0]
			output.should.match(/^ERROR test error/)
		})

		it("warn outputs with WARN prefix", () => {
			Logger.warn("test warn")
			const output = stderrSpy.firstCall.args[0]
			output.should.match(/^WARN test warn/)
		})

		it("log outputs with LOG prefix", () => {
			Logger.log("test log")
			const output = stderrSpy.firstCall.args[0]
			output.should.match(/^LOG test log/)
		})

		it("info outputs with INFO prefix", () => {
			Logger.info("test info")
			const output = stderrSpy.firstCall.args[0]
			output.should.match(/^INFO test info/)
		})

		it("debug outputs with DEBUG prefix", () => {
			Logger.debug("test debug")
			const output = stderrSpy.firstCall.args[0]
			output.should.match(/^DEBUG test debug/)
		})

		it("trace outputs with TRACE prefix", () => {
			Logger.trace("test trace")
			const output = stderrSpy.firstCall.args[0]
			output.should.match(/^TRACE test trace/)
		})
	})

	// ---------------------------------------------------------------
	describe("subscribe", () => {
		it("delivers messages to subscribers", () => {
			const received: string[] = []
			Logger.subscribe((msg) => received.push(msg))
			Logger.log("hello subscriber")
			received.length.should.equal(1)
			received[0].should.match(/^LOG hello subscriber/)
		})

		it("delivers to multiple subscribers", () => {
			const r1: string[] = []
			const r2: string[] = []
			Logger.subscribe((msg) => r1.push(msg))
			Logger.subscribe((msg) => r2.push(msg))
			Logger.error("broadcast")
			r1.length.should.equal(1)
			r2.length.should.equal(1)
		})

		it("does not fall back to stderr when subscribers exist", () => {
			Logger.subscribe(() => {})
			Logger.log("to subscriber")
			stderrSpy.called.should.be.false()
		})

		it("falls back to stderr when no subscribers", () => {
			Logger.log("to stderr")
			stderrSpy.calledOnce.should.be.true()
		})
	})

	// ---------------------------------------------------------------
	describe("subscriber errors", () => {
		it("does not crash when subscriber throws", () => {
			Logger.subscribe(() => {
				throw new Error("boom")
			})
			;(() => Logger.log("after boom")).should.not.throw()
		})

		it("still delivers to other subscribers after one throws", () => {
			const received: string[] = []
			Logger.subscribe(() => {
				throw new Error("boom")
			})
			Logger.subscribe((msg) => received.push(msg))
			Logger.log("after boom")
			received.length.should.equal(1)
		})
	})

	// ---------------------------------------------------------------
	describe("argument formatting", () => {
		it("appends extra args to message", () => {
			Logger.log("msg", "extra1", "extra2")
			const output = stderrSpy.firstCall.args[0]
			output.should.containEql("extra1 extra2")
		})

		it("formats Error objects with message and stack", () => {
			const err = new Error("test error")
			err.stack = "Error: test error\n  at test"
			Logger.error("failed", err)
			const output = stderrSpy.firstCall.args[0]
			output.should.containEql("test error")
			output.should.containEql("at test")
		})

		it("formats plain objects as JSON", () => {
			Logger.log("data", { key: "value" })
			const output = stderrSpy.firstCall.args[0]
			output.should.containEql('{"key":"value"}')
		})

		it("handles circular objects gracefully", () => {
			const obj: any = { a: 1 }
			obj.self = obj
			;(() => Logger.log("circular", obj)).should.not.throw()
		})

		it("handles null and undefined args", () => {
			Logger.log("msg", null, undefined)
			const output = stderrSpy.firstCall.args[0]
			output.should.containEql("null")
		})
	})

	// ---------------------------------------------------------------
	describe("edge cases", () => {
		it("trims trailing whitespace", () => {
			Logger.log("  hello  ")
			const output = stderrSpy.firstCall.args[0]
			output.should.containEql("LOG")
		})

		it("handles empty message", () => {
			;(() => Logger.log("")).should.not.throw()
		})

		it("handles very long messages", () => {
			const long = "x".repeat(10000)
			;(() => Logger.log(long)).should.not.throw()
		})
	})
})
