import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const tempDataDirectories: string[] = []

function setupDataDirectory(): string {
	const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "dirac-acp-session-updates-"))
	process.env.DIRAC_DATA_DIR = dataDirectory
	tempDataDirectories.push(dataDirectory)
	return dataDirectory
}

describe("ACP session update journal", () => {
	beforeEach(() => {
		vi.resetModules()
		setupDataDirectory()
	})

	afterEach(() => {
		delete process.env.DIRAC_DATA_DIR
		for (const dataDirectory of tempDataDirectories.splice(0)) {
			fs.rmSync(dataDirectory, { recursive: true, force: true })
		}
	})

	it("persists a monotonic per-session sequence and preserves it for replay", async () => {
		const { getSessionUpdates, recordClientAnnotation, recordSessionUpdate } = await import("./acp-session-updates.js")

		const first = recordSessionUpdate("session-1", {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "first" },
		} as any)
		const usage = recordSessionUpdate("session-1", {
			sessionUpdate: "usage_update",
			used: 12,
			size: 100,
		} as any)
		const annotation = recordClientAnnotation("session-1", {
			kind: "permission_decision",
			outcome: "allow_once",
		})
		const second = recordSessionUpdate("session-1", {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "second" },
		} as any)

		expect(first._meta).toEqual({ "dev.dirac/seq": 1 })
		expect(usage._meta).toEqual({ "dev.dirac/seq": 2 })
		expect(annotation._meta).toEqual({ "dev.dirac/seq": 3 })
		expect(second._meta).toEqual({ "dev.dirac/seq": 4 })
		expect(getSessionUpdates("session-1")).toEqual([
			{ kind: "session_update", sequenceNumber: 1, update: first },
			{ kind: "session_update", sequenceNumber: 2, update: usage },
			{ kind: "client_annotation", sequenceNumber: 3, annotation },
			{ kind: "session_update", sequenceNumber: 4, update: second },
		])


		vi.resetModules()
		const restartedJournal = await import("./acp-session-updates.js")
		expect(restartedJournal.getSessionUpdates("session-1")).toEqual([
			{ kind: "session_update", sequenceNumber: 1, update: first },
			{ kind: "session_update", sequenceNumber: 2, update: usage },
			{ kind: "client_annotation", sequenceNumber: 3, annotation },
			{ kind: "session_update", sequenceNumber: 4, update: second },
		])
	})
})
