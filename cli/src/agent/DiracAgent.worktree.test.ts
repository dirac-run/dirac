import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DiracAgent } from "./DiracAgent.js"

const mocks = vi.hoisted(() => {
	const controllerOptions: Array<{ workspaceCwd?: string } | undefined> = []

	const taskHistory: any[] = []
	class MockController {
		stateManager = {
			getApiConfiguration: vi.fn(() => ({
				actModeApiProvider: "anthropic",
				planModeApiProvider: "anthropic",
				actModeThinkingBudgetTokens: 1024,
				planModeThinkingBudgetTokens: 1024,
			})),
			getGlobalSettingsKey: vi.fn(() => "act"),
			getSystemDefaultSettingsKey: vi.fn((key: string) => {
				if (key === "mode") return "act"
				if (key === "actModeApiProvider" || key === "planModeApiProvider") return "anthropic"
				return undefined
			}),
		}
		getStateToPostToWebview = vi.fn(async () => ({ mode: "act" }))
		dispose = vi.fn()
		getTaskWithId = vi.fn(async (taskId: string) => ({
			historyItem: mocks.taskHistory.find((item) => item.id === taskId),
		}))
		constructor(
			_: unknown,
			readonly options?: { workspaceCwd?: string },
		) {
			controllerOptions.push(options)
		}
	}

	return {
		MockController,
		controllerOptions,
		taskHistory,
		initializeCliContext: vi.fn(() => ({
			extensionContext: {},
			storageContext: {},
			EXTENSION_DIR: "/tmp/dirac-test",
			DATA_DIR: "/tmp/dirac-test-data",
		})),
		initCoreServices: vi.fn(async () => { }),
		setRuntimeHooksDir: vi.fn(),
		hostProviderInitialize: vi.fn(),
	}
})

vi.mock("@/core/controller", () => ({ Controller: mocks.MockController }))
vi.mock("../vscode-context.js", () => ({ initializeCliContext: mocks.initializeCliContext }))
vi.mock("../initCoreServices.js", () => ({ initCoreServices: mocks.initCoreServices }))
vi.mock("@/core/storage/disk", () => ({ setRuntimeHooksDir: mocks.setRuntimeHooksDir }))
vi.mock("@/core/storage/taskHistory", () => ({
	withTaskHistoryInventoryLock: vi.fn(async (action: () => Promise<unknown>) => await action()),
}))
vi.mock("@/hosts/host-provider.js", () => ({ HostProvider: { initialize: mocks.hostProviderInitialize } }))
vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		initialize: vi.fn(async () => { }),
		get: vi.fn(() => ({
			getGlobalSettingsKey: vi.fn(() => "act"),
			getSystemDefaultSettingsKey: vi.fn((key: string) => {
				if (key === "mode") return "act"
				if (key === "actModeApiProvider" || key === "planModeApiProvider") return "anthropic"
				return undefined
			}),
			getApiConfiguration: vi.fn(() => ({
				actModeApiProvider: "anthropic",
				planModeApiProvider: "anthropic",
				actModeThinkingBudgetTokens: 1024,
				planModeThinkingBudgetTokens: 1024,
			})),
			captureEffectiveTaskConfiguration: vi.fn((overrides: Record<string, unknown>) => ({
				apiConfiguration: {
					actModeApiProvider: "anthropic",
					planModeApiProvider: "anthropic",
					actModeThinkingBudgetTokens: 1024,
					planModeThinkingBudgetTokens: 1024,
					...overrides,
				},
			})),
			getGlobalStateKey: vi.fn((key: string) => (key === "taskHistory" ? mocks.taskHistory : undefined)),
			upsertTaskHistoryItem: vi.fn((item: any) => {
				const index = mocks.taskHistory.findIndex((candidate) => candidate.id === item.id)
				if (index === -1) mocks.taskHistory.push(item)
				else mocks.taskHistory[index] = item
			}),
			removeTaskHistoryItems: vi.fn((ids: string[]) => {
				const idSet = new Set(ids)
				for (let index = mocks.taskHistory.length - 1; index >= 0; index -= 1) {
					if (idSet.has(mocks.taskHistory[index].id)) mocks.taskHistory.splice(index, 1)
				}
			}),
			setGlobalState: vi.fn(),
			flushPendingState: vi.fn(async () => { }),
			subscribe: vi.fn(() => () => { }),
		})),
	},
}))

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function createRepository(): string {
	const repository = mkdtempSync(path.join(tmpdir(), "dirac-acp-worktree-"))
	git(repository, ["init", "-b", "main"])
	git(repository, ["config", "user.email", "dirac@example.com"])
	git(repository, ["config", "user.name", "Dirac Test"])
	git(repository, ["commit", "--allow-empty", "-m", "initial"])
	return repository
}

async function createAgent(repository: string): Promise<DiracAgent> {
	const agent = new DiracAgent({ cwd: repository })
	await agent.initialize({ clientCapabilities: {} } as any)
	return agent
}

describe("DiracAgent ACP worktrees", () => {
	const directories: string[] = []

	afterEach(() => {
		for (const directory of directories.splice(0)) {
			rmSync(directory, { recursive: true, force: true })
		}
	})

	it("advertises only implemented ACP capabilities and session configuration surfaces", async () => {
		const repository = createRepository()
		directories.push(repository)
		const agent = await createAgent(repository)

		const initialized = await agent.initialize({ clientCapabilities: {} } as any)
		const capabilities = initialized.agentCapabilities as any

		expect(Object.keys(capabilities).sort()).toEqual([
			"_meta",
			"auth",
			"loadSession",
			"promptCapabilities",
			"providers",
			"sessionCapabilities",
		])
		expect(capabilities.loadSession).toBe(true)
		expect(capabilities.providers).toEqual({})
		expect(capabilities.sessionCapabilities).toEqual({ list: {}, resume: {}, close: {}, delete: {}, fork: {} })
		expect(capabilities.promptCapabilities).toEqual({ image: true, audio: false, embeddedContext: true })
		expect(Object.keys(capabilities._meta).sort()).toEqual([
			"dev.dirac/auth.logout",
			"dev.dirac/checkpoints.list",
			"dev.dirac/checkpoints.restore",
			"dev.dirac/client_annotation",
			"dev.dirac/messages.pin",
			"dev.dirac/messages.pinned",
			"dev.dirac/messages.unpin",
			"dev.dirac/permission.effect_previews",
			"dev.dirac/permissions.delete",
			"dev.dirac/permissions.list",
			"dev.dirac/pinned_messages_update",
			"dev.dirac/seq",
			"dev.dirac/session.close",
			"dev.dirac/session.delete",
			"dev.dirac/steering_status",
			"dev.dirac/whisper",
			"dev.dirac/worktree.integrate",
			"dev.dirac/worktree.provision",
		])

		const session = await agent.newSession({ cwd: repository, mcpServers: [] } as any)
		expect(Object.keys(session).sort()).toEqual(["configOptions", "modes", "sessionId"])
	})

	it("provisions a branch-backed worktree requested at session creation and integrates it", async () => {
		const repository = createRepository()
		directories.push(repository)
		const agent = await createAgent(repository)

		const session = await agent.newSession({
			cwd: repository,
			mcpServers: [],
			_meta: { "dev.dirac/worktree": true },
		} as any)
		const worktree = (session as any)._meta["dev.dirac/worktree"]

		expect(worktree.path).not.toBe(repository)
		expect(existsSync(worktree.path)).toBe(true)
		expect(git(worktree.path, ["branch", "--show-current"]).trim()).toBe(worktree.branch)

		const integrated = await agent.integrateSessionWorktree(session.sessionId)
		expect(integrated.targetBranch).toBe("main")
		expect(existsSync(worktree.path)).toBe(false)
		expect(git(repository, ["branch", "--list", worktree.branch]).trim()).toBe("")
	})

	it("binds a worktree session controller to the provisioned worktree", async () => {
		const repository = createRepository()
		directories.push(repository)
		const agent = await createAgent(repository)

		const session = await agent.newSession({
			cwd: repository,
			mcpServers: [],
			_meta: { "dev.dirac/worktree": true },
		} as any)
		const worktree = (session as any)._meta["dev.dirac/worktree"]
		expect(mocks.controllerOptions.at(-1)).toEqual({ workspaceCwd: worktree.path })
	})

	it("keeps a loaded worktree session bound to its owned path", async () => {
		const repository = createRepository()
		directories.push(repository)
		const agent = await createAgent(repository)
		const session = await agent.newSession({
			cwd: repository,
			mcpServers: [],
			_meta: { "dev.dirac/worktree": true },
		} as any)
		const worktree = (session as any)._meta["dev.dirac/worktree"]
		mocks.taskHistory.push({
			id: session.sessionId,
			cwdOnTaskInitialization: worktree.path,
		})

		await agent.closeSession({ sessionId: session.sessionId })
		await agent.loadSession({
			sessionId: session.sessionId,
			cwd: repository,
			mcpServers: [],
		} as any)

		expect(mocks.controllerOptions.at(-1)).toEqual({ workspaceCwd: worktree.path })
	})

	it("retains a Dirac-managed worktree and uncommitted edits when the source session is deleted after forking", async () => {
		const repository = createRepository()
		const dataDir = mkdtempSync(path.join(tmpdir(), "dirac-acp-worktree-data-"))
		directories.push(repository, dataDir)
		mocks.initializeCliContext.mockReturnValueOnce({
			extensionContext: {},
			storageContext: {},
			EXTENSION_DIR: "/tmp/dirac-test",
			DATA_DIR: dataDir,
		})
		const agent = await createAgent(repository)

		const sourceSession = await agent.newSession({
			cwd: repository,
			mcpServers: [],
			_meta: { "dev.dirac/worktree": true },
		} as any)
		const worktree = (sourceSession as any)._meta["dev.dirac/worktree"]
		directories.push(path.dirname(worktree.path))

		const forkedSession = await agent.unstable_forkSession({
			sessionId: sourceSession.sessionId,
			cwd: worktree.path,
			mcpServers: [],
		})

		const uncommittedFile = path.join(worktree.path, "uncommitted.txt")
		writeFileSync(uncommittedFile, "fork uncommitted work\n", "utf8")

		await agent.deleteSession({ sessionId: sourceSession.sessionId })

		expect(agent.sessions.has(sourceSession.sessionId)).toBe(false)
		expect(agent.sessions.has(forkedSession.sessionId)).toBe(true)
		expect(existsSync(worktree.path)).toBe(true)
		expect(readFileSync(uncommittedFile, "utf8")).toBe("fork uncommitted work\n")
		expect(git(worktree.path, ["status", "--porcelain"]).trim()).toContain("uncommitted.txt")

		await agent.closeSession({ sessionId: forkedSession.sessionId })
		await agent.loadSession({
			sessionId: forkedSession.sessionId,
			cwd: repository,
			mcpServers: [],
		} as any)
		expect(mocks.controllerOptions.at(-1)).toEqual({ workspaceCwd: worktree.path })

		await agent.deleteSession({ sessionId: forkedSession.sessionId })
		expect(existsSync(worktree.path)).toBe(false)
	})
})
