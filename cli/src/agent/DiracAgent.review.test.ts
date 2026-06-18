import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type * as acp from "@agentclientprotocol/sdk"
import { DiracAgent } from "./DiracAgent.js"
import { formatReviewFindings } from "./review.js"

const mocks = vi.hoisted(() => {
    let reviewModelText = '{"findings":[]}'

    class MockController {
        static instances: MockController[] = []

        task: unknown
        stateManager = {
            getApiConfiguration: vi.fn(() => ({
                actModeThinkingBudgetTokens: 1024,
                planModeThinkingBudgetTokens: 1024,
            })),
            getGlobalSettingsKey: vi.fn((key: string) => {
                if (key === "mode") {
                    return "act"
                }
                return undefined
            }),
        }
        getStateToPostToWebview = vi.fn(async () => ({ mode: "act" }))
        initTask = vi.fn()
        reinitExistingTaskFromId = vi.fn()
        dispose = vi.fn()

        constructor() {
            this.task = undefined
            MockController.instances.push(this)
        }
    }

    return {
        MockController,
        setReviewModelText(text: string) {
            reviewModelText = text
        },
        buildApiHandler: vi.fn(() => ({
            createMessage: async function* () {
                yield { type: "text", text: reviewModelText }
            },
            abort: vi.fn(),
        })),
        getAvailableSlashCommands: vi.fn(async () => ({
            commands: [
                {
                    name: "/help",
                    description: "Show help",
                    cliCompatible: true,
                },
            ],
        })),
        initializeCliContext: vi.fn(() => ({
            extensionContext: {},
            storageContext: {},
            EXTENSION_DIR: "/tmp/dirac-test",
            DATA_DIR: "/tmp/dirac-test-data",
        })),
        initCoreServices: vi.fn(async () => { }),
        hostProviderInitialize: vi.fn(),
        setRuntimeHooksDir: vi.fn(),
    }
})

vi.mock("@/core/controller", () => ({
    Controller: mocks.MockController,
}))

vi.mock("@/core/controller/slash/getAvailableSlashCommands", () => ({
    getAvailableSlashCommands: mocks.getAvailableSlashCommands,
}))

vi.mock("@/core/storage/disk", () => ({
    setRuntimeHooksDir: mocks.setRuntimeHooksDir,
    getSavedDiracMessages: vi.fn(async () => []),
}))

vi.mock("../vscode-context.js", () => ({
    initializeCliContext: mocks.initializeCliContext,
}))

vi.mock("@/core/api", () => ({
    buildApiHandler: mocks.buildApiHandler,
}))

vi.mock("@shared/slashCommands", () => ({
    CLI_ONLY_COMMANDS: [],
    VSCODE_ONLY_COMMANDS: [],
}))

vi.mock("../initCoreServices.js", () => ({
    initCoreServices: mocks.initCoreServices,
}))

vi.mock("@/hosts/host-provider.js", () => ({
    HostProvider: {
        initialize: mocks.hostProviderInitialize,
    },
}))

vi.mock("@/core/storage/StateManager", () => ({
    StateManager: {
        initialize: vi.fn(async () => { }),
        get: vi.fn(() => ({
            getSessionOverrideCache: vi.fn(() => ({})),
            setSessionOverrideCache: vi.fn(),
            getGlobalSettingsKey: vi.fn((key: string) => {
                if (key === "mode") return "act"
                return undefined
            }),
            getApiConfiguration: vi.fn(() => ({
                actModeThinkingBudgetTokens: 1024,
                planModeThinkingBudgetTokens: 1024,
            })),
            setGlobalState: vi.fn(),
            setSessionOverride: vi.fn(),
            flushPendingState: vi.fn(async () => { }),
        })),
    },
}))

function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    })
}

function createGitRepo(options?: { branchName?: string }): string {
    const repoPath = mkdtempSync(path.join(tmpdir(), "dirac-review-"))
    git(repoPath, ["init", "-b", options?.branchName ?? "main"])
    git(repoPath, ["config", "user.email", "dirac@example.com"])
    git(repoPath, ["config", "user.name", "Dirac Test"])
    return repoPath
}

function commitFile(repoPath: string, relativePath: string, content: string, message: string): void {
    writeFileSync(path.join(repoPath, relativePath), content, "utf8")
    git(repoPath, ["add", relativePath])
    git(repoPath, ["commit", "-m", message])
}

async function createAgentForRepo(repoPath: string): Promise<{ agent: DiracAgent; sessionId: string }> {
    const agent = new DiracAgent({ cwd: repoPath })
        ; (agent as any).getSessionModelState = vi.fn(async () => [])
        ; (agent as any).getSessionConfigOptions = vi.fn(async () => [])
        ; (agent as any).getSessionModeState = vi.fn(() => [])

    await agent.initialize({ clientCapabilities: {} } as any)

    const response = await agent.newSession({
        cwd: repoPath,
        mcpServers: [],
    } as any)

    return { agent, sessionId: response.sessionId }
}

function subscribeToReviewUpdates(agent: DiracAgent, sessionId: string) {
    const emitter = agent.emitterForSession(sessionId)
    const toolCalls: Array<acp.ToolCall & { sessionUpdate: "tool_call" }> = []
    const messages: string[] = []
    emitter.on("tool_call", (payload) => {
        toolCalls.push(payload as acp.ToolCall & { sessionUpdate: "tool_call" })
    })
    emitter.on("agent_message_chunk", (payload) => {
        const chunk = payload as acp.ContentChunk & { sessionUpdate: "agent_message_chunk" }
        if (chunk.content.type === "text") {
            messages.push(chunk.content.text)
        }
    })
    return { toolCalls, messages }
}

describe("Dirac ACP review commands", () => {
    const reposToCleanup: string[] = []

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.MockController.instances.length = 0
        mocks.setReviewModelText(
            '{"findings":[{"severity":"high","path":"app.ts","line":2,"title":"Broken edge case","explanation":"The new branch returns the wrong result for empty input."}]}',
        )
    })

    afterEach(() => {
        for (const repoPath of reposToCleanup.splice(0)) {
            rmSync(repoPath, { recursive: true, force: true })
        }
    })

    it("adds ACP review commands to available_commands_update", async () => {
        const repoPath = createGitRepo()
        reposToCleanup.push(repoPath)
        const { agent, sessionId } = await createAgentForRepo(repoPath)
        const availableCommandsUpdates: acp.SessionUpdate[] = []
        agent.emitterForSession(sessionId).on("available_commands_update", (payload) => {
            availableCommandsUpdates.push(payload as acp.SessionUpdate)
        })

        await agent.publishSessionSetupUpdates(sessionId)

        expect(availableCommandsUpdates).toHaveLength(1)
        const update = availableCommandsUpdates[0] as acp.AvailableCommandsUpdate & {
            sessionUpdate: "available_commands_update"
        }
        expect(update.availableCommands.map((command) => command.name)).toEqual(
            expect.arrayContaining(["/help", "/review", "/review-branch", "/review-commit"]),
        )
    })

    it("intercepts /review and emits a diff tool call without starting a task", async () => {
        const repoPath = createGitRepo()
        reposToCleanup.push(repoPath)
        commitFile(repoPath, "app.ts", "export function value() {\n\treturn 1\n}\n", "initial")
        writeFileSync(path.join(repoPath, "app.ts"), "export function value() {\n\treturn 2\n}\n", "utf8")

        const { agent, sessionId } = await createAgentForRepo(repoPath)
        const updates = subscribeToReviewUpdates(agent, sessionId)

        const response = await agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "/review Focus on correctness issues" }],
        } as any)

        expect(response).toEqual({ stopReason: "end_turn" })
        expect(mocks.MockController.instances[0].initTask).not.toHaveBeenCalled()
        expect(updates.toolCalls).toHaveLength(1)
        expect(updates.toolCalls[0].title).toBe("Review changes")
        expect(updates.toolCalls[0].kind).toBe("edit")
        expect(updates.toolCalls[0].content?.[0]).toMatchObject({
            type: "diff",
            path: "app.ts",
        })
        expect(updates.toolCalls[0].locations).toEqual([{ path: "app.ts" }])
        expect(updates.messages.join("\n")).toContain("app.ts:2 [high] Broken edge case")
        expect(mocks.buildApiHandler).toHaveBeenCalled()
    })

    it("includes untracked files in /review", async () => {
        const repoPath = createGitRepo()
        reposToCleanup.push(repoPath)
        commitFile(repoPath, "app.ts", "export const count = 1\n", "initial")
        writeFileSync(path.join(repoPath, "new-file.ts"), "export const added = true\n", "utf8")

        const { agent, sessionId } = await createAgentForRepo(repoPath)
        const updates = subscribeToReviewUpdates(agent, sessionId)

        const response = await agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "/review" }],
        } as any)

        expect(response).toEqual({ stopReason: "end_turn" })
        expect(mocks.MockController.instances[0].initTask).not.toHaveBeenCalled()
        expect(updates.toolCalls).toHaveLength(1)
        expect(updates.toolCalls[0].content?.[0]).toMatchObject({
            type: "diff",
            path: "new-file.ts",
            oldText: "",
            newText: "export const added = true\n",
        })
    })

    it("supports /review before the first commit exists", async () => {
        const repoPath = createGitRepo()
        reposToCleanup.push(repoPath)
        writeFileSync(path.join(repoPath, "initial.ts"), "export const initial = true\n", "utf8")

        const { agent, sessionId } = await createAgentForRepo(repoPath)
        const updates = subscribeToReviewUpdates(agent, sessionId)

        const response = await agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "/review" }],
        } as any)

        expect(response).toEqual({ stopReason: "end_turn" })
        expect(mocks.MockController.instances[0].initTask).not.toHaveBeenCalled()
        expect(updates.toolCalls).toHaveLength(1)
        expect(updates.toolCalls[0].content?.[0]).toMatchObject({
            type: "diff",
            path: "initial.ts",
            oldText: "",
            newText: "export const initial = true\n",
        })
    })

    it("intercepts /review-branch and keeps controller.initTask untouched", async () => {
        const repoPath = createGitRepo()
        reposToCleanup.push(repoPath)
        commitFile(repoPath, "app.ts", "export const count = 1\n", "initial")
        git(repoPath, ["checkout", "-b", "feature/review"])
        commitFile(repoPath, "app.ts", "export const count = 2\n", "update")

        const { agent, sessionId } = await createAgentForRepo(repoPath)
        const updates = subscribeToReviewUpdates(agent, sessionId)

        const response = await agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "/review-branch main" }],
        } as any)

        expect(response).toEqual({ stopReason: "end_turn" })
        expect(mocks.MockController.instances[0].initTask).not.toHaveBeenCalled()
        expect(updates.toolCalls).toHaveLength(1)
        expect(updates.toolCalls[0].content?.[0]).toMatchObject({
            type: "diff",
            path: "app.ts",
        })
    })

    it("intercepts /review-commit and keeps controller.initTask untouched", async () => {
        const repoPath = createGitRepo()
        reposToCleanup.push(repoPath)
        commitFile(repoPath, "app.ts", "export const count = 1\n", "initial")
        commitFile(repoPath, "app.ts", "export const count = 2\n", "second")

        const { agent, sessionId } = await createAgentForRepo(repoPath)

        const response = await agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "/review-commit HEAD" }],
        } as any)

        expect(response).toEqual({ stopReason: "end_turn" })
        expect(mocks.MockController.instances[0].initTask).not.toHaveBeenCalled()
    })

    it("returns a clear message when /review-branch is missing its target", async () => {
        const repoPath = createGitRepo()
        reposToCleanup.push(repoPath)
        const { agent, sessionId } = await createAgentForRepo(repoPath)
        const updates = subscribeToReviewUpdates(agent, sessionId)

        const response = await agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "/review-branch" }],
        } as any)

        expect(response).toEqual({ stopReason: "end_turn" })
        expect(updates.messages).toContain("Error: /review-branch requires a branch argument.")
    })

    it("returns a clear message when /review-commit is missing its target", async () => {
        const repoPath = createGitRepo()
        reposToCleanup.push(repoPath)
        const { agent, sessionId } = await createAgentForRepo(repoPath)
        const updates = subscribeToReviewUpdates(agent, sessionId)

        const response = await agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "/review-commit" }],
        } as any)

        expect(response).toEqual({ stopReason: "end_turn" })
        expect(updates.messages).toContain("Error: /review-commit requires a commit argument.")
    })

    it("returns a no-op message when /review has no diff to inspect", async () => {
        const repoPath = createGitRepo()
        reposToCleanup.push(repoPath)
        commitFile(repoPath, "app.ts", "export const count = 1\n", "initial")

        const { agent, sessionId } = await createAgentForRepo(repoPath)
        const updates = subscribeToReviewUpdates(agent, sessionId)

        const response = await agent.prompt({
            sessionId,
            prompt: [{ type: "text", text: "/review" }],
        } as any)

        expect(response).toEqual({ stopReason: "end_turn" })
        expect(updates.toolCalls).toHaveLength(0)
        expect(updates.messages).toContain("No reviewable text changes found.")
    })

    it("formats review findings as stable path:line markdown entries", () => {
        expect(
            formatReviewFindings([
                {
                    severity: "medium",
                    path: "b.ts",
                    line: 8,
                    title: "Second finding",
                    explanation: "Explanation two.",
                },
                {
                    severity: "high",
                    path: "a.ts",
                    line: 3,
                    title: "First finding",
                    explanation: "Explanation one.",
                },
            ]),
        ).toBe(
            "- a.ts:3 [high] First finding\nExplanation one.\n\n- b.ts:8 [medium] Second finding\nExplanation two.",
        )
    })
})
