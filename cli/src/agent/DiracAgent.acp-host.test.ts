import type * as acp from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import { DiracAgent } from "./DiracAgent.js"

const getCliBinaryPath = vi.hoisted(() => vi.fn(async (name: string) => `/resolved/${name}`))

vi.mock("../utils/path.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../utils/path.js")>()),
	getCliBinaryPath,
}))

function createAgent() {
	const agent = new DiracAgent({ diracDir: "/tmp/dirac-acp-host-test", cwd: "/workspace" } as any)
		; (agent as any).ctx = {
			extensionContext: {},
			EXTENSION_DIR: "/tmp/dirac-extension",
			DATA_DIR: "/tmp/dirac-data",
		}
	return agent
}

function terminalHandle(id: string) {
	return {
		id,
		currentOutput: vi.fn(),
		waitForExit: vi.fn(),
		kill: vi.fn(),
		release: vi.fn(),
	} as any
}

describe("DiracAgent ACP host composition", () => {
	afterEach(() => {
		HostProvider.reset()
		getCliBinaryPath.mockClear()
	})

	it("resolves ripgrep through the shared CLI binary resolver", async () => {
		const agent = createAgent()
		agent.initializeHostProvider()

		await expect(HostProvider.get().getBinaryLocation("rg")).resolves.toBe("/resolved/rg")
		expect(getCliBinaryPath).toHaveBeenCalledWith("rg")
	})

	it("persists multi-file presentation once and awaits client delivery", async () => {
		const agent = createAgent()
			; (agent as any).promptRunner.activePromptSessionId = "session-a"
		const persistedUpdate = {
			sessionUpdate: "tool_call",
			toolCallId: "persisted-tool-call",
			title: "Persisted",
			_meta: { "dev.dirac/seq": 1 },
		} as any
		const persistSessionUpdate = vi.fn(() => persistedUpdate)
			; (agent as any).updates.persistSessionUpdate = persistSessionUpdate

		let releaseDelivery!: () => void
		const delivery = new Promise<void>((resolve) => {
			releaseDelivery = resolve
		})
		const connection = { sessionUpdate: vi.fn(() => delivery) } as any
		agent.initializeHostProvider({}, connection)

		let settled = false
		const presentation = HostProvider.diff
			.openMultiFileDiff({
				title: "Changes",
				diffs: [{ filePath: "/workspace/a.ts", leftContent: "old", rightContent: "new" }],
			} as any)
			.then(() => {
				settled = true
			})

		await Promise.resolve()
		expect(settled).toBe(false)
		expect(persistSessionUpdate).toHaveBeenCalledOnce()
		expect(connection.sessionUpdate).toHaveBeenCalledWith({
			sessionId: "session-a",
			update: persistedUpdate,
		})

		releaseDelivery()
		await presentation
		expect(settled).toBe(true)
	})

	it("propagates real client presentation delivery failures", async () => {
		const agent = createAgent()
			; (agent as any).promptRunner.activePromptSessionId = "session-a"
			; (agent as any).updates.persistSessionUpdate = vi.fn((_sessionId: string, update: acp.SessionUpdate) => update)
		const connection = { sessionUpdate: vi.fn().mockRejectedValue(new Error("client delivery failed")) } as any
		agent.initializeHostProvider({}, connection)

		await expect(
			HostProvider.diff.openMultiFileDiff({
				title: "Changes",
				diffs: [{ filePath: "/workspace/a.ts", leftContent: "old", rightContent: "new" }],
			} as any),
		).rejects.toThrow("client delivery failed")
	})

	it("shares one operation-time session resolver across files and terminals", async () => {
		const agent = createAgent()
		const connection = {
			sessionUpdate: vi.fn().mockResolvedValue(undefined),
			readTextFile: vi.fn().mockResolvedValue({ content: "original" }),
			writeTextFile: vi.fn().mockResolvedValue(undefined),
			createTerminal: vi.fn().mockResolvedValue(terminalHandle("terminal-b")),
		} as any
		agent.initializeHostProvider({ fs: { readTextFile: true, writeTextFile: true }, terminal: true }, connection)

			; (agent as any).promptRunner.activePromptSessionId = "session-a"
		await expect(
			HostProvider.workspace.saveOpenDocumentIfDirty({ filePath: "/workspace/a.ts" }),
		).resolves.toEqual({})
		const firstProvider = HostProvider.get().createDiffViewProvider()
		await firstProvider.open("/workspace/a.ts", { editType: "modify" })
		await firstProvider.update("changed", true)
		await firstProvider.saveChanges({ skipDiagnostics: true })

			; (agent as any).promptRunner.activePromptSessionId = "session-b"
		const secondProvider = HostProvider.get().createDiffViewProvider()
		await secondProvider.open("/workspace/b.ts", { editType: "modify" })
		const terminalManager = HostProvider.get().createTerminalManager() as any
		await terminalManager.createTerminal({ command: "pwd", cwd: "/workspace" })

			; (agent as any).promptRunner.activePromptSessionId = undefined
		const inactiveProvider = HostProvider.get().createDiffViewProvider()
		await expect(inactiveProvider.open("/workspace/inactive.ts", { editType: "modify" })).rejects.toThrow(
			/No active ACP session.*reading/,
		)

		expect(connection.readTextFile).toHaveBeenNthCalledWith(1, {
			sessionId: "session-a",
			path: "/workspace/a.ts",
		})
		expect(connection.writeTextFile).toHaveBeenCalledWith({
			sessionId: "session-a",
			path: "/workspace/a.ts",
			content: "changed",
		})
		expect(connection.readTextFile).toHaveBeenNthCalledWith(2, {
			sessionId: "session-a",
			path: "/workspace/a.ts",
		})
		expect(connection.readTextFile).toHaveBeenNthCalledWith(3, {
			sessionId: "session-b",
			path: "/workspace/b.ts",
		})
		expect(connection.createTerminal).toHaveBeenCalledWith({
			sessionId: "session-b",
			command: "pwd",
			cwd: "/workspace",
		})
	})
})
