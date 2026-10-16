import { spawn } from "node:child_process"
import crypto from "node:crypto"
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

function journalFilePath(dataDirectory: string, sessionId: string): string {
	const digest = crypto.createHash("sha256").update(sessionId).digest("hex")
	return path.join(dataDirectory, "acp-session-updates", `${digest}.jsonl`)
}

function legacyIsolatedJournalPath(dataDirectory: string, sessionId: string): string {
	const digest = crypto.createHash("sha256").update(sessionId).digest("hex")
	return path.join(dataDirectory, "acp-session-updates", `${digest}.json`)
}

function isWellFormedJournal(filePath: string): boolean {
	const contents = fs.readFileSync(filePath, "utf8")
	const lines = contents.split("\n")
	if (lines[lines.length - 1] !== "") return false
	for (const line of lines) {
		if (line === "") continue
		JSON.parse(line)
	}
	return true
}

async function workerBundle(): Promise<string> {
	const workerPath = path.join(process.cwd(), `.dirac-acp-session-updates-worker-${crypto.randomUUID()}.cjs`)
	const sourcePath = path.resolve(__dirname, "acp-session-updates.ts")
	const esbuild = await import("esbuild")
	await esbuild.build({
		entryPoints: [sourcePath],
		outfile: workerPath,
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node22",
	})
	tempDataDirectories.push(workerPath)
	return workerPath
}

function spawnWriter(
	workerPath: string,
	dataDirectory: string,
	sessionId: string,
	writerId: number,
	count: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const source = `
			const { recordSessionUpdate } = require(${JSON.stringify(workerPath)});
			for (let i = 0; i < ${count}; i += 1) {
				recordSessionUpdate(${JSON.stringify(sessionId)}, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: ${JSON.stringify(`writer-${writerId}-`)} + i },
				});
			}
		`
		const child = spawn(process.execPath, ["--eval", source], {
			env: { ...process.env, DIRAC_DATA_DIR: dataDirectory },
			stdio: ["ignore", "ignore", "pipe"],
		})
		let stderr = ""
		child.stderr.setEncoding("utf8")
		child.stderr.on("data", (chunk) => {
			stderr += chunk
		})
		child.on("error", reject)
		child.on("exit", (code) => {
			if (code === 0) resolve()
			else reject(new Error(`writer ${writerId} exited with code ${code}: ${stderr}`))
		})
	})
}

describe("ACP session update journal", () => {
	beforeEach(() => {
		vi.resetModules()
		setupDataDirectory()
	})

	afterEach(() => {
		delete process.env.DIRAC_DATA_DIR
		delete process.env.DIRAC_ACP_SESSION_UPDATES_MAX_BYTES
		for (const entry of tempDataDirectories.splice(0)) {
			fs.rmSync(entry, { recursive: true, force: true })
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
		expect(isWellFormedJournal(journalFilePath(process.env.DIRAC_DATA_DIR!, "session-1"))).toBe(true)
	})

	it("keeps committed JSONL valid and retains updates written by separate processes", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "concurrent-session"
		const writerPath = await workerBundle()
		const writerCount = 4
		const updatesPerWriter = 35
		const committedPath = journalFilePath(dataDirectory, sessionId)
		let readerStopped = false
		let readerError: unknown
		const reader = (async () => {
			while (!readerStopped) {
				try {
					isWellFormedJournal(committedPath)
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						readerError = error
						return
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 1))
			}
		})()

		await Promise.all(
			Array.from({ length: writerCount }, (_, writerId) =>
				spawnWriter(writerPath, dataDirectory, sessionId, writerId, updatesPerWriter),
			),
		)
		readerStopped = true
		await reader
		expect(readerError).toBeUndefined()

		vi.resetModules()
		const { getSessionUpdates } = await import("./acp-session-updates.js")
		const updates = getSessionUpdates(sessionId)
		expect(updates).toHaveLength(writerCount * updatesPerWriter)
		expect(updates.map((update) => update.sequenceNumber)).toEqual(
			Array.from({ length: writerCount * updatesPerWriter }, (_, index) => index + 1),
		)
		const texts = updates.map((persisted) => {
			if (persisted.kind !== "session_update" || persisted.update.sessionUpdate !== "agent_message_chunk") return ""
			return persisted.update.content.type === "text" ? persisted.update.content.text : ""
		})
		for (let writerId = 0; writerId < writerCount; writerId += 1) {
			for (let index = 0; index < updatesPerWriter; index += 1) {
				expect(texts).toContain(`writer-${writerId}-${index}`)
			}
		}
		expect(() => isWellFormedJournal(committedPath)).not.toThrow()
	})

	it("ignores a torn trailing line from an interrupted append and keeps committed entries", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "torn-session"
		const journal = await import("./acp-session-updates.js")
		journal.recordSessionUpdate(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "committed-1" },
		} as any)
		journal.recordSessionUpdate(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "committed-2" },
		} as any)
		const committedPath = journalFilePath(dataDirectory, sessionId)
		fs.appendFileSync(committedPath, '{"kind":"session_update","sequenceNumber":3,"update":{"content":"torn')

		expect(journal.getSessionUpdates(sessionId).map((entry) => entry.sequenceNumber)).toEqual([1, 2])
	})

	it("tolerates a failed compaction rewrite without losing the appended update", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "compaction-session"
		process.env.DIRAC_ACP_SESSION_UPDATES_MAX_BYTES = "600"
		const journal = await import("./acp-session-updates.js")
		for (let index = 0; index < 3; index += 1) {
			journal.recordSessionUpdate(sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: `u-${index}` },
			} as any)
		}
		const committedPath = journalFilePath(dataDirectory, sessionId)

		const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
			throw new Error("simulated interruption during compaction")
		})
		expect(() =>
			journal.recordSessionUpdate(sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "m".repeat(2_000) },
			} as any),
		).not.toThrow()
		rename.mockRestore()

		const updates = journal.getSessionUpdates(sessionId)
		expect(updates).toHaveLength(4)
		expect(updates.at(-1)?.sequenceNumber).toBe(4)
		expect(() => isWellFormedJournal(committedPath)).not.toThrow()
		expect(fs.readdirSync(path.dirname(committedPath)).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
	})

	it("migrates a legacy per-session JSON journal into JSONL and archives the original", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "legacy-isolated-session"
		const legacyPath = legacyIsolatedJournalPath(dataDirectory, sessionId)
		fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
		fs.writeFileSync(
			legacyPath,
			JSON.stringify({
				version: 1,
				sessionId,
				updates: [
					{
						kind: "session_update",
						sequenceNumber: 1,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: "legacy" },
							_meta: { "dev.dirac/seq": 1 },
						},
					},
				],
			}),
		)
		const journal = await import("./acp-session-updates.js")

		expect(journal.getSessionUpdates(sessionId)).toHaveLength(1)
		expect(fs.existsSync(legacyPath)).toBe(false)
		expect(isWellFormedJournal(journalFilePath(dataDirectory, sessionId))).toBe(true)
		expect(
			fs
				.readdirSync(path.dirname(legacyPath))
				.some((entry) =>
					entry.startsWith(`${crypto.createHash("sha256").update(sessionId).digest("hex")}.json.migrated`),
				),
		).toBe(true)
	})

	it("reports malformed legacy flat data and never overwrites it", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const legacyPath = path.join(dataDirectory, "acp-session-updates.json")
		const malformed = '{"session-1":[{"kind":"session_update","update":{"content":"unterminated'
		fs.writeFileSync(legacyPath, malformed)
		const journal = await import("./acp-session-updates.js")

		expect(() => journal.getSessionUpdates("session-1")).toThrow(
			expect.objectContaining({
				message: expect.stringContaining(`Malformed ACP session update journal at ${legacyPath}`),
			}),
		)
		expect(() => journal.getSessionUpdates("session-1")).toThrow("will not overwrite or reset this file")
		expect(fs.readFileSync(legacyPath, "utf8")).toBe(malformed)
	})

	it("recovers a complete legacy flat map with trailing corruption and archives the original bytes", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const legacyPath = path.join(dataDirectory, "acp-session-updates.json")
		const sessionId = "recoverable-session"
		const legacyContents =
			JSON.stringify({
				[sessionId]: [
					{
						kind: "session_update",
						sequenceNumber: 1,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: "preserved" },
							_meta: { "dev.dirac/seq": 1 },
						},
					},
					{
						kind: "usage_update",
						sequenceNumber: 2,
						usage: {
							tokensIn: 10,
							tokensOut: 5,
							_meta: { "dev.dirac/seq": 2 },
						},
					},
					{
						kind: "client_annotation",
						sequenceNumber: 3,
						annotation: {
							kind: "permission_decision",
							_meta: { "dev.dirac/seq": 3 },
						},
					},
				],
			}) + '{"incomplete":'
		fs.writeFileSync(legacyPath, legacyContents)
		const journal = await import("./acp-session-updates.js")

		expect(journal.getSessionUpdates(sessionId)).toEqual([
			expect.objectContaining({ kind: "session_update", sequenceNumber: 1 }),
			expect.objectContaining({ kind: "client_annotation", sequenceNumber: 3 }),
		])
		expect(fs.existsSync(legacyPath)).toBe(false)
		const recoveryFiles = fs
			.readdirSync(dataDirectory)
			.filter((entry) => entry.startsWith("acp-session-updates.json.recovery-"))
		expect(recoveryFiles).toHaveLength(1)
		expect(fs.readFileSync(path.join(dataDirectory, recoveryFiles[0]), "utf8")).toBe(legacyContents)
		expect(journal.getSessionUpdates(sessionId).map((entry) => entry.sequenceNumber)).toEqual([1, 3])
	})

	it("migrates valid legacy flat data into an isolated JSONL journal", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const legacyPath = path.join(dataDirectory, "acp-session-updates.json")
		fs.writeFileSync(
			legacyPath,
			JSON.stringify({
				"session-1": [
					{
						kind: "session_update",
						sequenceNumber: 1,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: "legacy" },
							_meta: { "dev.dirac/seq": 1 },
						},
					},
				],
			}),
		)
		const journal = await import("./acp-session-updates.js")
		expect(journal.getSessionUpdates("session-1")).toHaveLength(1)
		expect(fs.existsSync(legacyPath)).toBe(false)
		expect(isWellFormedJournal(journalFilePath(dataDirectory, "session-1"))).toBe(true)
	})

	it("keeps the isolated journal when a stale legacy flat file reappears", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "mixed-version-session"
		const legacyPath = path.join(dataDirectory, "acp-session-updates.json")
		const journal = await import("./acp-session-updates.js")
		journal.recordSessionUpdate(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "first" },
		} as any)
		journal.recordSessionUpdate(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "newer" },
		} as any)
		const isolatedBefore = fs.readFileSync(journalFilePath(dataDirectory, sessionId))
		const firstUpdate = journal.getSessionUpdates(sessionId)[0]
		fs.writeFileSync(legacyPath, JSON.stringify({ [sessionId]: [firstUpdate] }))

		expect(journal.getSessionUpdates(sessionId)).toHaveLength(2)
		expect(fs.readFileSync(journalFilePath(dataDirectory, sessionId))).toEqual(isolatedBefore)
		expect(fs.existsSync(legacyPath)).toBe(false)
	})

	it("sheds oldest entries instead of failing once the journal exceeds its budget", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "bounded-session"
		process.env.DIRAC_ACP_SESSION_UPDATES_MAX_BYTES = "600"
		const journal = await import("./acp-session-updates.js")
		for (let index = 0; index < 3; index += 1) {
			journal.recordSessionUpdate(sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: `small-${index}` },
			} as any)
		}
		const committedPath = journalFilePath(dataDirectory, sessionId)

		expect(() =>
			journal.recordSessionUpdate(sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "x".repeat(2_000) },
			} as any),
		).not.toThrow()

		const updates = journal.getSessionUpdates(sessionId)
		expect(updates).toHaveLength(1)
		expect(updates[0].sequenceNumber).toBe(4)
		expect(() => isWellFormedJournal(committedPath)).not.toThrow()
	})

	it("leaves headroom so the next streaming chunk does not compact again", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "headroom-session"
		process.env.DIRAC_ACP_SESSION_UPDATES_MAX_BYTES = "2048"
		const journal = await import("./acp-session-updates.js")

		let retained = journal.getSessionUpdates(sessionId)
		for (let index = 0; index < 100 && (retained[0]?.sequenceNumber ?? 1) === 1; index += 1) {
			journal.recordSessionUpdate(sessionId, {
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: `chunk-${index}` },
			} as any)
			retained = journal.getSessionUpdates(sessionId)
		}

		expect(retained[0].sequenceNumber).toBeGreaterThan(1)
		const oldestRetained = retained[0].sequenceNumber
		const next = journal.recordSessionUpdate(sessionId, {
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "next chunk" },
		} as any)
		const afterNext = journal.getSessionUpdates(sessionId)
		expect(afterNext[0].sequenceNumber).toBe(oldestRetained)
		expect(afterNext.at(-1)?.sequenceNumber).toBe(next._meta?.["dev.dirac/seq"])
		expect(fs.statSync(journalFilePath(dataDirectory, sessionId)).size).toBeLessThanOrEqual(2048)
	})

	it("keeps a single entry whole even when it alone exceeds the budget", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "single-overshoot-session"
		process.env.DIRAC_ACP_SESSION_UPDATES_MAX_BYTES = "100"
		const journal = await import("./acp-session-updates.js")

		expect(() =>
			journal.recordSessionUpdate(sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "x".repeat(2_000) },
			} as any),
		).not.toThrow()
		expect(journal.getSessionUpdates(sessionId)).toHaveLength(1)
	})

	it("derives the next sequence from the journal tail when the file exceeds the read window", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "tail-session"
		const filePath = journalFilePath(dataDirectory, sessionId)
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
		const padding = "p".repeat(80)
		let contents = ""
		for (let sequenceNumber = 1; sequenceNumber <= 2_000; sequenceNumber += 1) {
			contents +=
				JSON.stringify({
					kind: "session_update",
					sequenceNumber,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: `${padding}-${sequenceNumber}` },
					},
				}) + "\n"
		}
		fs.writeFileSync(filePath, contents)
		expect(fs.statSync(filePath).size).toBeGreaterThan(64 * 1024)

		const journal = await import("./acp-session-updates.js")
		const next = journal.recordSessionUpdate(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "after-tail" },
		} as any)
		expect(next._meta).toEqual({ "dev.dirac/seq": 2_001 })
		expect(journal.getSessionUpdates(sessionId)).toHaveLength(2_001)
	})

	it("discovers the sequence across a torn tail in an oversized journal", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "tail-torn-session"
		const filePath = journalFilePath(dataDirectory, sessionId)
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
		const padding = "p".repeat(80)
		let contents = ""
		for (let sequenceNumber = 1; sequenceNumber <= 2_000; sequenceNumber += 1) {
			contents +=
				JSON.stringify({
					kind: "session_update",
					sequenceNumber,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: `${padding}-${sequenceNumber}` },
					},
				}) + "\n"
		}
		contents += '{"kind":"session_update","sequenceNumber":2001,"update":{"torn'
		fs.writeFileSync(filePath, contents)
		expect(fs.statSync(filePath).size).toBeGreaterThan(64 * 1024)

		const journal = await import("./acp-session-updates.js")
		const next = journal.recordSessionUpdate(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "after-torn" },
		} as any)
		expect(next._meta).toEqual({ "dev.dirac/seq": 2_001 })
	})

	it("reports corruption in the middle of a JSONL journal", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "corrupt-middle-session"
		const filePath = journalFilePath(dataDirectory, sessionId)
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
		fs.writeFileSync(
			filePath,
			[
				JSON.stringify({
					kind: "session_update",
					sequenceNumber: 1,
					update: { sessionUpdate: "current_mode_update" },
				}),
				'{"broken":',
				JSON.stringify({
					kind: "session_update",
					sequenceNumber: 3,
					update: { sessionUpdate: "current_mode_update" },
				}),
			].join("\n") + "\n",
		)

		const journal = await import("./acp-session-updates.js")
		expect(() => journal.getSessionUpdates(sessionId)).toThrow(/Malformed ACP session update journal/)
	})

	it("rejects a journal row with a non-monotonic sequence number", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "nonmonotonic-session"
		const filePath = journalFilePath(dataDirectory, sessionId)
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
		fs.writeFileSync(
			filePath,
			[
				JSON.stringify({
					kind: "session_update",
					sequenceNumber: 1,
					update: { sessionUpdate: "current_mode_update" },
				}),
				JSON.stringify({
					kind: "session_update",
					sequenceNumber: 1,
					update: { sessionUpdate: "current_mode_update" },
				}),
			].join("\n") + "\n",
		)

		const journal = await import("./acp-session-updates.js")
		expect(() => journal.getSessionUpdates(sessionId)).toThrow(/non-monotonic sequenceNumber/)
	})

	it("continues the sequence after a trailing journal row larger than the read window", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "huge-row-session"
		const filePath = journalFilePath(dataDirectory, sessionId)
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
		const huge = "h".repeat(300 * 1024)
		fs.writeFileSync(
			filePath,
			[
				JSON.stringify({
					kind: "session_update",
					sequenceNumber: 1,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "prior" },
					},
				}),
				JSON.stringify({
					kind: "session_update",
					sequenceNumber: 2,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: huge },
					},
				}),
			].join("\n") + "\n",
		)
		expect(fs.statSync(filePath).size).toBeGreaterThan(64 * 1024)

		const journal = await import("./acp-session-updates.js")
		const next = journal.recordSessionUpdate(sessionId, {
			sessionUpdate: "current_mode_update",
		} as any)
		expect(next._meta).toEqual({ "dev.dirac/seq": 3 })
	})

	it("archives a corrupt legacy per-session JSON instead of retrying it on every write", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "corrupt-legacy-session"
		const legacyPath = legacyIsolatedJournalPath(dataDirectory, sessionId)
		fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
		fs.writeFileSync(
			legacyPath,
			'{"version":1,"updates":[{"kind":"session_update","update":{"content":"untermina',
		)
		const journal = await import("./acp-session-updates.js")

		expect(() =>
			journal.recordSessionUpdate(sessionId, {
				sessionUpdate: "current_mode_update",
			} as any),
		).not.toThrow()
		expect(() =>
			journal.recordSessionUpdate(sessionId, {
				sessionUpdate: "current_mode_update",
			} as any),
		).not.toThrow()
		expect(fs.existsSync(legacyPath)).toBe(false)
		expect(journal.getSessionUpdates(sessionId).length).toBeGreaterThan(0)
	})

	it("returns an empty journal for a session that has never been written", async () => {
		const journal = await import("./acp-session-updates.js")
		expect(journal.getSessionUpdates("never-accessed")).toEqual([])
	})

	it("keeps the JSONL journal and archives a legacy per-session JSON when both exist", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "both-formats-session"
		const journal = await import("./acp-session-updates.js")
		journal.recordSessionUpdate(sessionId, {
			sessionUpdate: "current_mode_update",
		} as any)
		const jsonlPath = journalFilePath(dataDirectory, sessionId)
		const jsonlBefore = fs.readFileSync(jsonlPath)
		const legacyPath = legacyIsolatedJournalPath(dataDirectory, sessionId)
		fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
		fs.writeFileSync(
			legacyPath,
			JSON.stringify({
				version: 1,
				sessionId,
				updates: [
					{
						kind: "session_update",
						sequenceNumber: 1,
						update: { sessionUpdate: "current_mode_update" },
					},
				],
			}),
		)

		expect(journal.getSessionUpdates(sessionId).map((entry) => entry.sequenceNumber)).toEqual([1])
		expect(fs.readFileSync(jsonlPath)).toEqual(jsonlBefore)
		expect(fs.existsSync(legacyPath)).toBe(false)
	})

	it("deletes both the JSONL journal and any stale legacy per-session JSON", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sessionId = "delete-session"
		const journal = await import("./acp-session-updates.js")
		journal.recordSessionUpdate(sessionId, {
			sessionUpdate: "current_mode_update",
		} as any)
		const filePath = journalFilePath(dataDirectory, sessionId)
		const legacyPath = legacyIsolatedJournalPath(dataDirectory, sessionId)
		fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
		fs.writeFileSync(legacyPath, JSON.stringify({ version: 1, sessionId, updates: [] }))
		expect(fs.existsSync(filePath)).toBe(true)

		journal.deleteSessionUpdates(sessionId)
		expect(fs.existsSync(filePath)).toBe(false)
		expect(fs.existsSync(legacyPath)).toBe(false)
	})

	it("rejects a non-positive DIRAC_ACP_SESSION_UPDATES_MAX_BYTES", async () => {
		process.env.DIRAC_ACP_SESSION_UPDATES_MAX_BYTES = "abc"
		const journal = await import("./acp-session-updates.js")
		expect(() =>
			journal.recordSessionUpdate("bad-env-session", {
				sessionUpdate: "current_mode_update",
			} as any),
		).toThrow(/DIRAC_ACP_SESSION_UPDATES_MAX_BYTES must be a positive integer/)
	})

	it("copies a compacted session journal to a forked session with contiguous renumbered sequences and _meta", async () => {
		const dataDirectory = process.env.DIRAC_DATA_DIR!
		const sourceSessionId = "compacted-source-session"
		const targetSessionId = "forked-target-session"
		const sourcePath = journalFilePath(dataDirectory, sourceSessionId)
		fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
		// Simulate a compacted journal whose leading entries (1..4) were dropped so sequences start at 5.
		fs.writeFileSync(
			sourcePath,
			[
				JSON.stringify({
					kind: "session_update",
					sequenceNumber: 5,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "retained chunk" },
						_meta: { "dev.dirac/seq": 5 },
					},
				}),
				JSON.stringify({
					kind: "client_annotation",
					sequenceNumber: 6,
					annotation: { note: "pinned", _meta: { "dev.dirac/seq": 6 } },
				}),
			].join("\n") + "\n",
		)

		const journal = await import("./acp-session-updates.js")
		expect(() => journal.copySessionUpdates(sourceSessionId, sourceSessionId)).toThrow(
			/Cannot copy ACP session updates onto the same session/,
		)

		journal.copySessionUpdates(sourceSessionId, targetSessionId)
		const forkedEntries = journal.getSessionUpdates(targetSessionId)
		expect(forkedEntries).toEqual([
			{
				kind: "session_update",
				sequenceNumber: 1,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "retained chunk" },
					_meta: { "dev.dirac/seq": 1 },
				},
			},
			{
				kind: "client_annotation",
				sequenceNumber: 2,
				annotation: { note: "pinned", _meta: { "dev.dirac/seq": 2 } },
			},
		])
	})
})
