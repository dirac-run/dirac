import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type * as acp from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DiracSessionEmitter } from "./DiracSessionEmitter.js"

const update: acp.SessionUpdate = {
	sessionUpdate: "agent_message_chunk",
	content: { type: "text", text: "hello" },
} as acp.SessionUpdate

// The module-level mock keeps a spy on recordSessionUpdate. importOriginal's
// result is cached for the whole file, so the spy delegates to a holder that
// beforeEach refreshes via vi.importActual after resetModules() — that is the
// only instance evaluated with this test's DIRAC_DATA_DIR.
const journalMocks = vi.hoisted(() => ({
	realRecordSessionUpdate: undefined as typeof import("../acp/acp-session-updates.js").recordSessionUpdate | undefined,
}))

vi.mock("../acp/acp-session-updates.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../acp/acp-session-updates.js")>()
	return {
		...actual,
		recordSessionUpdate: vi.fn((sessionId: string, update: acp.SessionUpdate) => {
			if (!journalMocks.realRecordSessionUpdate) throw new Error("real recordSessionUpdate not initialized")
			return journalMocks.realRecordSessionUpdate(sessionId, update)
		}),
	}
})

describe("SessionUpdateJournal", () => {
	let tempDir: string
	let emitter: DiracSessionEmitter
	let journal: import("./sessionUpdateJournal.js").SessionUpdateJournal
	let recordSessionUpdate: typeof import("../acp/acp-session-updates.js").recordSessionUpdate

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dirac-test-"))
		process.env.DIRAC_DATA_DIR = tempDir
		vi.resetModules()
		const realUpdates = await vi.importActual<typeof import("../acp/acp-session-updates.js")>("../acp/acp-session-updates.js")
		journalMocks.realRecordSessionUpdate = realUpdates.recordSessionUpdate
		const acpUpdates = await import("../acp/acp-session-updates.js")
		recordSessionUpdate = acpUpdates.recordSessionUpdate
		const { SessionUpdateJournal } = await import("./sessionUpdateJournal.js")
		emitter = new DiracSessionEmitter()
		journal = new SessionUpdateJournal(() => emitter)
	})

	afterEach(() => {
		delete process.env.DIRAC_DATA_DIR
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it("emits the persisted update on the session emitter", async () => {
		const received: unknown[] = []
		emitter.on("agent_message_chunk", (p) => received.push(p))
		await journal.emitSessionUpdate("s1", update)
		expect(received).toHaveLength(1)
	})

	it("writes the journal under DIRAC_DATA_DIR", async () => {
		await journal.emitSessionUpdate("s1", update)
		expect(fs.readdirSync(path.join(tempDir, "acp-session-updates")).length).toBeGreaterThan(0)
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
