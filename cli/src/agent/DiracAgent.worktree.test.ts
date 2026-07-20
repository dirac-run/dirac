import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DiracAgent } from "./DiracAgent.js"

const mocks = vi.hoisted(() => {
	const controllerOptions: Array<{ workspaceCwd?: string } | undefined> = []

	const taskHistory: any[] = []
	class MockController {
		stateManager = {
			getApiConfiguration: vi.fn(() => ({ actModeThinkingBudgetTokens: 1024, planModeThinkingBudgetTokens: 1024 })),
			getGlobalSettingsKey: vi.fn(() => "act"),
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
		initCoreServices: vi.fn(async () => {}),
		setRuntimeHooksDir: vi.fn(),
		hostProviderInitialize: vi.fn(),
	}
})

vi.mock("@/core/controller", () => ({ Controller: mocks.MockController }))
vi.mock("../vscode-context.js", () => ({ initializeCliContext: mocks.initializeCliContext }))
vi.mock("../initCoreServices.js", () => ({ initCoreServices: mocks.initCoreServices }))
vi.mock("@/core/storage/disk", () => ({ setRuntimeHooksDir: mocks.setRuntimeHooksDir }))
vi.mock("@/hosts/host-provider.js", () => ({ HostProvider: { initialize: mocks.hostProviderInitialize } }))
vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		initialize: vi.fn(async () => {}),
		get: vi.fn(() => ({
			getSessionOverrideCache: vi.fn(() => ({})),
			setSessionOverrideCache: vi.fn(),
			getGlobalSettingsKey: vi.fn(() => "act"),
			getApiConfiguration: vi.fn(() => ({ actModeThinkingBudgetTokens: 1024, planModeThinkingBudgetTokens: 1024 })),
			getGlobalStateKey: vi.fn((key: string) => (key === "taskHistory" ? mocks.taskHistory : undefined)),
			setGlobalState: vi.fn(),
			flushPendingState: vi.fn(async () => {}),
			subscribe: vi.fn(() => () => {}),
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
			"loadSession",
			"promptCapabilities",
			"providers",
			"sessionCapabilities",
		])
		expect(capabilities.loadSession).toBe(true)
		expect(capabilities.providers).toEqual({})
		expect(capabilities.sessionCapabilities).toEqual({ resume: {}, close: {}, delete: {} })
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
			"dev.dirac/usage_update",
			"dev.dirac/whisper",
			"dev.dirac/worktree.integrate",
			"dev.dirac/worktree.provision",
		])

		const session = await agent.newSession({ cwd: repository, mcpServers: [] } as any)
		expect(Object.keys(session).sort()).toEqual(["configOptions", "models", "modes", "sessionId"])
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
})
