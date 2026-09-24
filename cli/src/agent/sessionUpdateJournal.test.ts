import type * as acp from "@agentclientprotocol/sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DiracSessionEmitter } from "./DiracSessionEmitter.js"
import { SessionUpdateJournal } from "./sessionUpdateJournal.js"

const update: acp.SessionUpdate = {
	sessionUpdate: "agent_message_chunk",
	content: { type: "text", text: "hello" },
} as acp.SessionUpdate

vi.mock("../acp/acp-session-updates.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../acp/acp-session-updates.js")>()
	return { ...actual, recordSessionUpdate: vi.fn(actual.recordSessionUpdate) }
})

import { recordSessionUpdate } from "../acp/acp-session-updates.js"

describe("SessionUpdateJournal", () => {
	let emitter: DiracSessionEmitter
	let journal: SessionUpdateJournal

	beforeEach(() => {
		emitter = new DiracSessionEmitter()
		journal = new SessionUpdateJournal(() => emitter)
	})

	it("emits the persisted update on the session emitter", async () => {
		const received: unknown[] = []
		emitter.on("agent_message_chunk", (p) => received.push(p))
		await journal.emitSessionUpdate("s1", update)
		expect(received).toHaveLength(1)
	})

	it("synthesizes an ephemeral sequence when journal persistence fails", async () => {
		vi.mocked(recordSessionUpdate).mockImplementationOnce(() => {
			throw new Error("journal full")
		})
		const persisted = journal.persistSessionUpdate("s1", update)
		expect(recordSessionUpdate).toHaveBeenCalled()
		// Fallback sequence is in-process: monotonic from 1 for this session.
		const meta = (persisted as { _meta?: Record<string, unknown> })._meta
		expect(meta?.["dev.dirac/seq"]).toBe(1)
	})

	it("emits an error event instead of throwing when the emitter fails", async () => {
		const errors: Error[] = []
		emitter.on("error", (e) => errors.push(e))
		const realEmit = emitter.emit.bind(emitter) as (event: string, payload: unknown) => boolean
		vi.spyOn(emitter, "emit").mockImplementation(((event: string, payload: unknown) => {
			if (event === "error") return realEmit(event, payload)
			throw new Error("emitter blew up")
		}) as typeof emitter.emit)
		await journal.emitSessionUpdate("s1", update)
		expect(errors).toHaveLength(1)
		expect(errors[0].message).toBe("emitter blew up")
	})
})
