/**
 * Characterization tests for TaskState's transition-gated fields.
 * Pins the flag-ordering and single-assignment semantics the task loop relies on,
 * plus the gate itself: writes outside a transition must fail.
 */
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { type ReadonlyTaskState, TaskState, type TaskStateTransition } from "../TaskState"

describe("TaskState contract", () => {
	describe("stream-stage flags", () => {
		it("begin/endApiRequest toggle the live-request flag", () => {
			const state = new TaskState()
			assert.equal(state.isApiRequestActive, false)
			state.beginApiRequest()
			assert.equal(state.isApiRequestActive, true)
			state.endApiRequest()
			assert.equal(state.isApiRequestActive, false)
		})

		it("endApiRequest releases the attached voice stream", () => {
			const state = new TaskState()
			state.attachVoiceStream("voice-1")
			state.beginApiRequest()
			state.endApiRequest()
			assert.equal(state.activeVoiceStreamId, undefined)
		})

		it("detachVoiceStream with a mismatched id leaves the current attachment", () => {
			const state = new TaskState()
			state.attachVoiceStream("voice-2")
			state.detachVoiceStream("voice-1")
			assert.equal(state.activeVoiceStreamId, "voice-2")
			state.detachVoiceStream("voice-2")
			assert.equal(state.activeVoiceStreamId, undefined)
		})

		it("first-chunk wait toggles only through its pair", () => {
			const state = new TaskState()
			state.beginFirstChunkWait()
			assert.equal(state.isWaitingForFirstChunk, true)
			state.endFirstChunkWait()
			assert.equal(state.isWaitingForFirstChunk, false)
		})

		it("stream read completion toggles through complete/reset", () => {
			const state = new TaskState()
			state.completeStreamRead()
			assert.equal(state.didCompleteReadingStream, true)
			state.resetStreamRead()
			assert.equal(state.didCompleteReadingStream, false)
		})

		it("markStreamAbortFinished is a one-way latch", () => {
			const state = new TaskState()
			assert.equal(state.didFinishAbortingStream, false)
			state.markStreamAbortFinished()
			assert.equal(state.didFinishAbortingStream, true)
			state.markStreamAbortFinished()
			assert.equal(state.didFinishAbortingStream, true)
		})
	})

	describe("task-level timing", () => {
		it("recordFirstTokenAt keeps the first recorded value", () => {
			const state = new TaskState()
			state.recordFirstTokenAt(120)
			state.recordFirstTokenAt(999)
			assert.equal(state.taskFirstTokenTimeMs, 120)
		})
	})

	describe("terminal fields", () => {
		it("settleRunOutcome returns the outcome and records it", () => {
			const state = new TaskState()
			const outcome = { kind: "completed", response: "done", completedAt: 1 } as const
			assert.equal(state.settleRunOutcome(outcome), outcome)
			assert.equal(state.runOutcome, outcome)
		})

		it("settleRunOutcome throws on a second settlement", () => {
			const state = new TaskState()
			state.settleRunOutcome({ kind: "completed", response: "done", completedAt: 1 })
			assert.throws(
				() => state.settleRunOutcome({ kind: "cancelled", cancelledAt: 2 }),
				/already settled/,
			)
		})

		it("a failed outcome preserves the error for the owner", () => {
			const state = new TaskState()
			const error = { name: "Error", message: "boom" }
			state.settleRunOutcome({ kind: "failed", error, failedAt: 1 })
			assert.deepEqual(state.terminalError, error)
		})

		it("cancelled/interrupted outcomes imply a cancellation intent", () => {
			const cancelled = new TaskState()
			cancelled.settleRunOutcome({ kind: "cancelled", reason: "user", cancelledAt: 1 })
			assert.deepEqual(cancelled.cancellationIntent, { kind: "cancelled", reason: "user" })

			const interrupted = new TaskState()
			interrupted.settleRunOutcome({ kind: "interrupted", reason: "hook", interruptedAt: 1 })
			assert.deepEqual(interrupted.cancellationIntent, { kind: "interrupted", reason: "hook" })
		})

		it("a pre-captured intent wins over the outcome-implied one", () => {
			const state = new TaskState()
			state.captureCancellationIntent({ kind: "interrupted", reason: "hook cancelled first" })
			state.settleRunOutcome({ kind: "cancelled", reason: "user", cancelledAt: 1 })
			assert.deepEqual(state.cancellationIntent, { kind: "interrupted", reason: "hook cancelled first" })
		})

		it("captureCancellationIntent is first-wins and ignored after settle", () => {
			const state = new TaskState()
			state.captureCancellationIntent({ kind: "cancelled", reason: "first" })
			state.captureCancellationIntent({ kind: "cancelled", reason: "second" })
			assert.deepEqual(state.cancellationIntent, { kind: "cancelled", reason: "first" })

			const settled = new TaskState()
			settled.settleRunOutcome({ kind: "completed", response: "ok", completedAt: 1 })
			settled.captureCancellationIntent({ kind: "cancelled" })
			assert.equal(settled.cancellationIntent, undefined)
		})

		it("completion response commits and clears across turns", () => {
			const state = new TaskState()
			state.commitCompletionResponse("shipped it")
			assert.equal(state.completionResponse, "shipped it")
			state.clearCompletionResponse()
			assert.equal(state.completionResponse, undefined)
		})
	})

	describe("mutation gate", () => {
		it("direct writes to gated fields throw outside a transition", () => {
			const state = new TaskState()
			for (const key of [
				"isApiRequestActive",
				"isWaitingForFirstChunk",
				"didCompleteReadingStream",
				"didFinishAbortingStream",
				"activeVoiceStreamId",
				"taskFirstTokenTimeMs",
				"runOutcome",
				"terminalError",
				"cancellationIntent",
				"completionResponse",
			] as const) {
				assert.throws(
					() => {
						// Bypassing the type contract is exactly what the gate exists to catch.
						;(state as unknown as Record<string, unknown>)[key] = true
					},
					TypeError,
					`expected write to ${key} to throw`,
				)
			}
		})

		it("ReadonlyTaskState exposes no setters or transitions (typecheck-level)", () => {
			const view: ReadonlyTaskState = new TaskState()
			assert.equal(view.isApiRequestActive, false)
			function assertsViewIsReadonly(v: ReadonlyTaskState) {
				// @ts-expect-error gated fields are readonly through the view
				v.isApiRequestActive = true
				// @ts-expect-error plain fields are readonly through the view
				v.consecutiveMistakeCount = 1
				// @ts-expect-error transitions are not part of the view
				v.beginApiRequest()
				// @ts-expect-error terminal settlement is not part of the view
				v.settleRunOutcome({ kind: "cancelled", cancelledAt: 0 })
			}
			void assertsViewIsReadonly // typecheck-only; never invoked
		})

		it("every TaskState method is a listed transition (typecheck-level sync lock)", () => {
			// A method added to TaskState but missing from TaskStateTransition would leak
			// onto ReadonlyTaskState — this lock fails typecheck in that case.
			// (-? strips optionality so optional fields contribute never, not never|undefined.)
			type MethodNames = {
				[K in keyof TaskState]-?: TaskState[K] extends (...args: never[]) => unknown ? K : never
			}[keyof TaskState]
			type Unlisted = Exclude<MethodNames, TaskStateTransition>
			const unlistedIsEmpty: Unlisted extends never ? true : never = true
			assert.equal(unlistedIsEmpty, true)
		})
	})
})
