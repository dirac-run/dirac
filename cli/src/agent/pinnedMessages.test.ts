import { afterEach, describe, expect, it, vi } from "vitest"
import { rmSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const mockStateManager = {
	getGlobalSettingsKey: vi.fn(() => "act"),
	getApiConfiguration: vi.fn(() => ({ actModeThinkingBudgetTokens: 1024, planModeThinkingBudgetTokens: 1024 })),
	subscribe: vi.fn(() => () => undefined),
	getGlobalStateKey: vi.fn(() => []),
	setGlobalState: vi.fn(),
	flushPendingState: vi.fn(async () => undefined),
}
let sessionOverrideCache: Record<string, unknown> = {}
Object.assign(mockStateManager, {
	getSessionOverrideCache: vi.fn(() => sessionOverrideCache),
	setSessionOverrideCache: vi.fn((overrides: Record<string, unknown>) => {
		sessionOverrideCache = overrides
	}),
})

const controllerInstances: any[] = []

vi.mock("@/core/controller", () => ({
	Controller: class {
		task: any
		getStateToPostToWebview = vi.fn(async () => ({ mode: "act" }))
		dispose = vi.fn()
		initTask = vi.fn(async (...args: any[]) => {
			this.task = {
				taskState: { pinnedContext: args[7]?.pinnedContext },
				setContextCompactionObserver: vi.fn(),
			}
		})
		reinitExistingTaskFromId = vi.fn(async (...args: any[]) => {
			this.task = {
				taskState: { pinnedContext: args[1]?.pinnedContext },
				setContextCompactionObserver: vi.fn(),
			}
		})
		constructor() {
			controllerInstances.push(this)
		}
	},
	controllerInstances,
}))
vi.mock("@/core/storage/disk", () => ({ setRuntimeHooksDir: vi.fn() }))
vi.mock("@/core/storage/StateManager", () => ({ StateManager: { get: vi.fn(() => mockStateManager) } }))

vi.mock("../acp/acp-session-pins.js", () => {
	const pinsBySession = new Map<string, Array<{ messageId: string; content: string; pinnedAt: string }>>()
	return {
		pinSessionMessage: (sessionId: string, message: { messageId: string; content: string; pinnedAt: string }) => {
			const pins = pinsBySession.get(sessionId) ?? []
			pinsBySession.set(sessionId, [...pins.filter((pin) => pin.messageId !== message.messageId), message])
		},
		unpinSessionMessage: (sessionId: string, messageId: string) => {
			const pins = pinsBySession.get(sessionId) ?? []
			const updatedPins = pins.filter((pin) => pin.messageId !== messageId)
			if (updatedPins.length === pins.length) return false
			pinsBySession.set(sessionId, updatedPins)
			return true
		},
		getPinnedSessionMessages: (sessionId: string) => pinsBySession.get(sessionId) ?? [],
		deletePinnedSessionMessages: (sessionId: string) => pinsBySession.delete(sessionId),
	}
})

const { DiracAgent } = await import("./DiracAgent.js")
const { pinSessionMessage } = await import("../acp/acp-session-pins.js")


describe("pinned ACP messages", () => {
	const directories: string[] = []

	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
	})


	it("passes persisted pins into fresh, replacement, and resumed task construction", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "dirac-pinned-initialization-"))
		directories.push(cwd)
		const agent = new DiracAgent({ cwd })
			; (agent as any).ctx = { DATA_DIR: cwd }
			; (agent as any).sendAvailableCommands = vi.fn(async () => undefined)
			; (agent as any).setSessionTitleFromFirstExchange = vi.fn(async () => undefined)

		const session = await agent.newSession({ cwd, mcpServers: [] } as any)
		pinSessionMessage(session.sessionId, {
			messageId: "message-1",
			content: "Use the pinned requirement.",
			pinnedAt: new Date().toISOString(),
		})

		const controller = controllerInstances.at(-1)
		await (agent as any).prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "start" }],
		})
		expect(controller.initTask.mock.calls[0][7].pinnedContext).toContain("Use the pinned requirement.")
		expect(controller.task.taskState.pinnedContext).toContain("Use the pinned requirement.")

		controller.task.messageStateHandler = { getDiracMessages: () => [] }
		await (agent as any).prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "replacement" }],
		})
		expect(controller.initTask.mock.calls[1][7].pinnedContext).toContain("Use the pinned requirement.")

		const loadedSession = await agent.newSession({ cwd, mcpServers: [] } as any)
		const loadedController = controllerInstances.at(-1)
		const loadedRecord = (agent as any).sessions.get(loadedSession.sessionId)
		loadedRecord.isLoadedFromHistory = true
		loadedRecord.loadedTaskId = "saved-task"
		pinSessionMessage(loadedSession.sessionId, {
			messageId: "message-2",
			content: "Use the resumed pin.",
			pinnedAt: new Date().toISOString(),
		})
		await (agent as any).prompt({
			sessionId: loadedSession.sessionId,
			prompt: [{ type: "text", text: "resume" }],
		})
		expect(loadedController.reinitExistingTaskFromId.mock.calls[0][1].pinnedContext).toContain("Use the resumed pin.")
	})

	it("persists a pin, injects it into compaction context, and reports state changes", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "dirac-pinned-message-"))
		directories.push(cwd)
		const agent = new DiracAgent({ cwd })
			; (agent as any).ctx = { DATA_DIR: cwd }

		const task = {
			messageStateHandler: {
				getDiracMessages: vi.fn(() => [
					{ id: "message-1", content: { type: "markdown", content: "Keep this requirement." } },
				]),
			},
			taskState: {} as { pinnedContext?: string },
			setContextCompactionObserver: vi.fn(),
		}
		const session = { sessionId: "session-1", cwd, mode: "act", createdAt: 0, lastActivityAt: 0, controller: { task } }
			; (agent as any).sessions.set(session.sessionId, session)

		const updates: Array<Record<string, unknown>> = []
		agent.emitterForSession(session.sessionId).on("pinned_messages_update", (payload) => updates.push(payload))

		await agent.pinMessage(session.sessionId, "message-1")

		expect(task.taskState.pinnedContext).toContain("Keep this requirement.")
		expect(task.setContextCompactionObserver).toHaveBeenCalledOnce()
		expect(agent.listPinnedMessages(session.sessionId)).toEqual([
			expect.objectContaining({ messageId: "message-1", content: "Keep this requirement." }),
		])
		expect(updates).toEqual([expect.objectContaining({ event: "pinned" })])

		await agent.unpinMessage(session.sessionId, "message-1")
		expect(task.taskState.pinnedContext).toBeUndefined()
		expect(updates).toEqual(expect.arrayContaining([expect.objectContaining({ event: "unpinned" })]))
	})
})
