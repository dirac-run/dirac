import { strict as assert } from "node:assert"
import * as coreApi from "@core/api"
import * as skills from "@core/context/instructions/user-instructions/skills"
import { DiracToolSet, PromptRegistry } from "@core/prompts/system-prompt"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { ApiFormat } from "@/shared/proto/dirac/models"
import { Logger } from "@/shared/services/Logger"
import { DiracDefaultTool } from "@/shared/tools"
import { TaskState } from "../../../TaskState"
import { list_files_spec, ListFilesTool } from "../../modules/list_files"
import { SubagentRunner } from "../SubagentRunner"
import { SubagentBuilder } from "../SubagentBuilder"
import { DiracAskResponse } from "@shared/WebviewMessage"

function initializeHostProvider() {
    HostProvider.reset()
    HostProvider.initialize(
        "extension",
        () => ({}) as never,
        () => ({}) as never,
        () => ({}) as never,
        () => ({}) as never,
        {
            workspaceClient: {},
            envClient: {
                getHostVersion: async () => ({ platform: "test" }),
            },
            windowClient: {},
            diffClient: {},
        } as never,
        () => undefined,
        async () => "",
        async () => "",
        "",
        "",
        async (_cwd: string) => undefined
    )
}

function createTaskConfig(): TaskConfig {
    return {
        taskId: "task-1",
        ulid: "ulid-1",
        cwd: "/tmp",
        mode: "act",
        strictPlanModeEnabled: false,
        yoloModeToggled: false,
        doubleCheckCompletionEnabled: false,
        vscodeTerminalExecutionMode: "backgroundExec",
        enableParallelToolCalling: false,
        isSubagentExecution: false,
        context: {},
        taskState: new TaskState(),
        messageState: {},
        api: {
            getModel: () => ({
                id: "anthropic/claude-sonnet-4.5",
                info: {
                    contextWindow: 200_000,
                    apiFormat: ApiFormat.ANTHROPIC_CHAT,
                    supportsPromptCache: true,
                },
            }),
            createMessage: sinon.stub().callsFake(async function* () { }),
        },
        services: {
            stateManager: {
                getGlobalSettingsKey: (key: string) => {
                    if (key === "mode") {
                        return "act"
                    }
                    if (key === "customPrompt") {
                        return undefined
                    }
                    return undefined
                },
                getGlobalStateKey: (_key: string) => undefined,
                getApiConfiguration: () => ({
                    actModeApiProvider: "anthropic",
                    planModeApiProvider: "anthropic",
                }),
            },
        },
        browserSettings: {},
        focusChainSettings: {},
        autoApprovalSettings: {
            enableNotifications: false,
            actions: { executeCommands: false },
        },
        autoApprover: { shouldAutoApproveTool: sinon.stub().returns([false, false]) },
        callbacks: {
            say: sinon.stub().resolves(undefined),
            ask: sinon.stub().resolves({ response: DiracAskResponse.APPROVE }),
            saveCheckpoint: sinon.stub().resolves(),
            sayAndCreateMissingParamError: sinon.stub().resolves("missing"),
            removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
            executeCommandTool: sinon.stub().resolves([false, "ok"]),
            cancelRunningCommandTool: sinon.stub().resolves(false),
            doesLatestTaskCompletionHaveNewChanges: sinon.stub().resolves(false),
            updateFCListFromToolResponse: sinon.stub().resolves(),
            shouldAutoApproveTool: sinon.stub().returns([true, true]),
            shouldAutoApproveToolWithPath: sinon.stub().resolves(false),
            postStateToWebview: sinon.stub().resolves(),
            cancelTask: sinon.stub().resolves(),
            applyLatestBrowserSettings: sinon.stub().resolves(undefined),
            switchToActMode: sinon.stub().resolves(false),
            setActiveHookExecution: sinon.stub().resolves(),
            clearActiveHookExecution: sinon.stub().resolves(),
            getActiveHookExecution: sinon.stub().resolves(undefined),
            runUserPromptSubmitHook: sinon.stub().resolves({}),
        },
        coordinator: {
            getHandler: sinon.stub().callsFake((toolName: DiracDefaultTool) => {
                if (toolName === DiracDefaultTool.LIST_FILES) {
                    return {
                        execute: sinon.stub().resolves("ok"),
                        getDescription: sinon.stub().returns("list_files"),
                    }
                }

                return undefined
            }),
        },
    } as unknown as TaskConfig
}

function createTaskConfigWithListFilesSnapshot(): TaskConfig {
    const config = createTaskConfig()
    config.activeToolSnapshot = {
        inventoryVersion: 1,
        requestId: "test-main-snapshot",
        promptVisibleSpecs: [list_files_spec],
        inventoryEnabledTools: [
            {
                id: DiracDefaultTool.LIST_FILES,
                name: DiracDefaultTool.LIST_FILES,
                source: "builtin",
                spec: list_files_spec,
                factory: () => new ListFilesTool(),
                modulePath: "modules/list_files/tool.ts",
            },
        ],
        nativeTools: [{ name: "list_files" } as any],
        coordinator: config.coordinator as any,
        executableToolNames: new Set([DiracDefaultTool.LIST_FILES]),
        dynamicSubagentToolNames: new Set(),
    }
    return config
}

function stubApiHandler(createMessage: sinon.SinonStub) {
    sinon.stub(coreApi, "buildApiHandler").returns({
        abort: sinon.stub(),
        getModel: () => ({
            id: "anthropic/claude-sonnet-4.5",
            info: {
                contextWindow: 200_000,
                apiFormat: ApiFormat.ANTHROPIC_CHAT,
                supportsPromptCache: true,
            },
        }),
        createMessage,
    } as never)
}

describe("SubagentRunner", () => {
    afterEach(() => {
        sinon.restore()
        HostProvider.reset()
    })

    it("emits native tool_use blocks with matching tool_result tool_use_id across turns", async () => {
        const createMessage = sinon.stub()
        createMessage.onFirstCall().callsFake(async function* () {
            yield {
                type: "tool_calls",
                tool_call: {
                    function: {
                        id: "toolu_subagent_1",
                        name: DiracDefaultTool.LIST_FILES,
                        arguments: JSON.stringify({ path: ".", recursive: false }),
                    },
                },
            }
        })
        createMessage.onSecondCall().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
            const assistantMessage = conversation[1] as {
                role: string
                content: Array<{ type?: string;[key: string]: unknown }>
            }
            assert.equal(assistantMessage.role, "assistant")

            const toolUse = assistantMessage.content.find((block) => block.type === "tool_use")
            assert.ok(toolUse)
            assert.equal(toolUse.id, "toolu_subagent_1")
            assert.equal(toolUse.name, DiracDefaultTool.LIST_FILES)

            const userMessage = conversation[2] as { role: string; content: Array<{ type?: string;[key: string]: unknown }> }
            assert.equal(userMessage.role, "user")
            const toolResult = userMessage.content.find((block) => block.type === "tool_result")
            assert.ok(toolResult)
            assert.equal(toolResult.tool_use_id, "toolu_subagent_1")

            yield {
                type: "tool_calls",
                tool_call: {
                    function: {
                        id: "toolu_subagent_complete_1",
                        name: DiracDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })

        const promptRegistry = PromptRegistry.getInstance()
        sinon.stub(promptRegistry, "get").callsFake(async () => {
            promptRegistry.nativeTools = [{ name: "list_files" } as any]
            return "system prompt"
        })
        sinon.stub(skills, "getOrDiscoverSkills").resolves([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
        const result = await runner.run("List files", () => { })

        assert.equal(result.status, "completed")
        assert.equal(result.result, "done")
        assert.equal(createMessage.callCount, 2)
    })

    it("passes prior request token totals into the next-turn compaction check", async () => {
        const createMessage = sinon.stub()
        createMessage.onFirstCall().callsFake(async function* () {
            yield {
                type: "usage",
                inputTokens: 11,
                outputTokens: 7,
                cacheWriteTokens: 3,
                cacheReadTokens: 2,
            }
            yield {
                type: "tool_calls",
                tool_call: {
                    function: {
                        id: "toolu_subagent_previous_tokens_1",
                        name: DiracDefaultTool.LIST_FILES,
                        arguments: JSON.stringify({ path: ".", recursive: false }),
                    },
                },
            }
        })
        createMessage.onSecondCall().callsFake(async function* () {
            yield {
                type: "tool_calls",
                tool_call: {
                    function: {
                        id: "toolu_subagent_previous_tokens_complete_1",
                        name: DiracDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })

        const promptRegistry = PromptRegistry.getInstance()
        sinon.stub(promptRegistry, "get").callsFake(async () => {
            promptRegistry.nativeTools = [{ name: "list_files" } as any]
            return "system prompt"
        })
        sinon.stub(skills, "getOrDiscoverSkills").resolves([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
        const shouldCompactStub = sinon.stub(runner as any, "shouldCompactBeforeNextRequest").callsFake((...args: unknown[]) => {
            const [previousRequestTotalTokens] = args
            assert.equal(previousRequestTotalTokens, 23)
            return false
        })

        const result = await runner.run("List files", () => { })

        assert.equal(result.status, "completed")
        assert.equal(result.result, "done")
        assert.equal(createMessage.callCount, 2)
        assert.equal(shouldCompactStub.callCount, 1)
    })

    it("falls back to non-native result blocks if structured tool calls appear while native mode is disabled", async () => {
        const createMessage = sinon.stub()
        createMessage.onFirstCall().callsFake(async function* () {
            yield {
                type: "tool_calls",
                tool_call: {
                    function: {
                        id: "toolu_subagent_2",
                        name: DiracDefaultTool.LIST_FILES,
                        arguments: JSON.stringify({ path: ".", recursive: false }),
                    },
                },
            }
        })
        createMessage.onSecondCall().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
            const lastMessage = conversation[conversation.length - 1] as {
                role: string
                content: Array<{ type?: string;[key: string]: unknown }>
            }

            assert.equal(lastMessage.role, "user")
            assert.ok(lastMessage.content.every((block) => block.type === "text"))
            assert.equal(
                lastMessage.content.some((block) => block.type === "tool_result"),
                false,
            )

            yield {
                type: "tool_calls",
                tool_call: {
                    function: {
                        id: "toolu_subagent_complete_2",
                        name: DiracDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })

        sinon.stub(DiracToolSet, "convertSpecsToNativeTools").returns([])
        const promptRegistry = PromptRegistry.getInstance()
        sinon.stub(promptRegistry, "get").callsFake(async () => {
            return "system prompt"
        })
        sinon.stub(skills, "getOrDiscoverSkills").resolves([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
        const result = await runner.run("List files", () => { })

        assert.equal(result.status, "completed")
        assert.equal(result.result, "done")
        assert.equal(createMessage.callCount, 2)
    })

    it("retries empty assistant turns with a no-tools-used nudge before failing", async () => {
        let apiCallCount = 0
        const createMessage = sinon.stub().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
            apiCallCount++
            if (apiCallCount === 1) {
                // First call: empty response (yields nothing)
                return
            }

            // Second call: verify nudge was added, then succeed
            const lastAssistant = conversation[1] as {
                role: string
                content: Array<{ type?: string; text?: string }>
            }
            assert.equal(lastAssistant.role, "assistant")
            assert.equal(lastAssistant.content[0]?.type, "text")
            assert.equal(lastAssistant.content[0]?.text, "Failure: I did not provide a response.")

            const lastUser = conversation[2] as {
                role: string
                content: Array<{ type?: string; text?: string }>
            }
            assert.equal(lastUser.role, "user")
            assert.equal(lastUser.content[0]?.type, "text")
            assert.match(lastUser.content[0]?.text || "", /did not include any tool calls/i)

            yield {
                type: "tool_calls",
                tool_call: {
                    function: {
                        id: "toolu_subagent_complete_3",
                        name: DiracDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })

        sinon.stub(DiracToolSet, "convertSpecsToNativeTools").returns([])
        const promptRegistry = PromptRegistry.getInstance()
        sinon.stub(promptRegistry, "get").callsFake(async () => {
            promptRegistry.nativeTools = undefined
            return "system prompt"
        })
        sinon.stub(skills, "getOrDiscoverSkills").resolves([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
        const result = await runner.run("List files", () => { })

        assert.equal(result.status, "completed")
        assert.equal(result.result, "done")
        assert.equal(createMessage.callCount, 2)
    })

    it("retries initial stream failures before failing", async () => {
        const createMessage = sinon.stub()
        createMessage.onFirstCall().callsFake(async function* () {
            yield* []
            throw new Error(
                '{"code":"stream_initialization_failed","message":"Failed to create stream: failed to generate stream from Vercel: failed to send request"}',
            )
        })
        createMessage.onSecondCall().callsFake(async function* () {
            yield* []
            throw new Error(
                '{"code":"stream_initialization_failed","message":"Failed to create stream: failed to generate stream from Vercel: failed to send request"}',
            )
        })
        createMessage.onThirdCall().callsFake(async function* () {
            yield* []
            throw new Error(
                '{"code":"stream_initialization_failed","message":"Failed to create stream: failed to generate stream from Vercel: failed to send request"}',
            )
        })

        const promptRegistry = PromptRegistry.getInstance()
        sinon.stub(promptRegistry, "get").callsFake(async () => {
            promptRegistry.nativeTools = undefined
            return "system prompt"
        })
        sinon.stub(skills, "getOrDiscoverSkills").resolves([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
        const runner = new SubagentRunner(createTaskConfig())
        const runPromise = runner.run("List files", () => { })
        await clock.runAllAsync()
        const result = await runPromise
        clock.restore()

        assert.equal(result.status, "failed")
        assert.equal(createMessage.callCount, 3)
        assert.match(result.error || "", /stream_initialization_failed/i)
    })

    it("fails context window errors", async () => {
        const createMessage = sinon.stub()
        createMessage.onFirstCall().callsFake(async function* () {
            yield* []
            const contextError = new Error("context length exceeded")
                ; (contextError as Error & { status: number }).status = 400
            throw contextError
        })

        const promptRegistry = PromptRegistry.getInstance()
        sinon.stub(promptRegistry, "get").callsFake(async () => {
            promptRegistry.nativeTools = undefined
            return "system prompt"
        })
        sinon.stub(skills, "getOrDiscoverSkills").resolves([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
        const result = await runner.run("Huge prompt", () => { })

        assert.equal(result.status, "failed")
        assert.equal(createMessage.callCount, 1)
        assert.match(result.error || "", /context length exceeded/i)
    })

    it("uses the configured task api handler for subagent requests", async () => {
        const createMessage = sinon.stub().callsFake(async function* () {
            yield {
                type: "tool_calls",
                tool_call: {
                    function: {
                        id: "toolu_subagent_complete_4",
                        name: DiracDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })

        const promptRegistry = PromptRegistry.getInstance()
        sinon.stub(promptRegistry, "get").callsFake(async () => {
            promptRegistry.nativeTools = [{ name: "list_files" } as any]
            return "system prompt"
        })
        sinon.stub(skills, "getOrDiscoverSkills").resolves([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
        const result = await runner.run("List files", () => { })

        assert.equal(result.status, "completed")
        assert.equal(createMessage.callCount, 1)
    })

    it("filters available skills to configured skills when subagent skills are configured", async () => {
        const createMessage = sinon.stub().callsFake(async function* () {
            yield {
                type: "tool_calls",
                tool_call: {
                    function: {
                        id: "toolu_subagent_skills_filtered_1",
                        name: DiracDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })

        const promptRegistry = PromptRegistry.getInstance()
        sinon.stub(promptRegistry, "get").callsFake(async (context) => {
            assert.ok(context.skills)
            assert.deepEqual(
                context.skills.map((skill) => skill.name),
                ["allowed-skill"],
            )
            promptRegistry.nativeTools = undefined
            return "system prompt"
        })
        sinon.stub(SubagentBuilder.prototype, "getConfiguredSkills").returns(["allowed-skill"])
        sinon.stub(skills, "getOrDiscoverSkills").resolves([
            { name: "allowed-skill", description: "Allowed", path: "/skills/allowed/SKILL.md", source: "project" },
            { name: "other-skill", description: "Other", path: "/skills/other/SKILL.md", source: "project" },
        ])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
        const result = await runner.run("Run task", () => { })

        assert.equal(result.status, "completed")
        assert.equal(createMessage.callCount, 1)
    })

    it("uses all available skills when subagent skills are not configured", async () => {
        const createMessage = sinon.stub().callsFake(async function* () {
            yield {
                type: "tool_calls",
                tool_call: {
                    function: {
                        id: "toolu_subagent_skills_unconfigured_1",
                        name: DiracDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })

        const promptRegistry = PromptRegistry.getInstance()
        sinon.stub(promptRegistry, "get").callsFake(async (context) => {
            assert.ok(context.skills)
            assert.deepEqual(
                context.skills.map((skill) => skill.name),
                ["alpha-skill", "beta-skill"],
            )
            promptRegistry.nativeTools = undefined
            return "system prompt"
        })
        sinon.stub(SubagentBuilder.prototype, "getConfiguredSkills").returns(undefined)
        sinon.stub(skills, "getOrDiscoverSkills").resolves([
            { name: "alpha-skill", description: "Alpha", path: "/skills/alpha/SKILL.md", source: "project" },
            { name: "beta-skill", description: "Beta", path: "/skills/beta/SKILL.md", source: "project" },
        ])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const runner = new SubagentRunner(createTaskConfig())
        const result = await runner.run("Run task", () => { })

        assert.equal(result.status, "completed")
        assert.equal(createMessage.callCount, 1)
    })

    it("logs a warning when a configured skill is not available", async () => {
        const createMessage = sinon.stub().callsFake(async function* () {
            yield {
                type: "tool_calls",
                tool_call: {
                    function: {
                        id: "toolu_subagent_skills_missing_1",
                        name: DiracDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })

        const warnStub = sinon.stub(Logger, "warn")
        const promptRegistry = PromptRegistry.getInstance()
        sinon.stub(promptRegistry, "get").callsFake(async (context) => {
            assert.ok(context.skills)
            assert.deepEqual(
                context.skills.map((skill) => skill.name),
                ["present-skill"],
            )
            promptRegistry.nativeTools = undefined
            return "system prompt"
        })
        sinon.stub(SubagentBuilder.prototype, "getConfiguredSkills").returns(["present-skill", "missing-skill"])
        sinon
            .stub(skills, "getOrDiscoverSkills")
            .resolves([{ name: "present-skill", description: "Present", path: "/skills/present/SKILL.md", source: "project" }])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const runner = new SubagentRunner(createTaskConfig())
        const result = await runner.run("Run task", () => { })

        assert.equal(result.status, "completed")
        assert.equal(createMessage.callCount, 1)
        sinon.assert.calledWith(warnStub, "[SubagentRunner] Configured skill 'missing-skill' not found for subagent run.")
    })

    it("includes workspace metadata only in the initial user message", async () => {
        const createMessage = sinon.stub()
        createMessage.onFirstCall().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
            const initialUser = conversation[0] as {
                role: string
                content: Array<{ type?: string; text?: string }>
            }
            assert.equal(initialUser.role, "user")
            const initialTexts = initialUser.content
                .filter((block) => block.type === "text")
                .map((block) => block.text || "")
                .join("\n")
            assert.match(initialTexts, /# Workspace Configuration/)

            yield {
                type: "tool_calls",
                tool_call: {
                    function: {
                        id: "toolu_subagent_workspace_1",
                        name: DiracDefaultTool.LIST_FILES,
                        arguments: JSON.stringify({ path: ".", recursive: false }),
                    },
                },
            }
        })
        createMessage.onSecondCall().callsFake(async function* (_systemPrompt: string, conversation: unknown[]) {
            const followUpUser = conversation[2] as {
                role: string
                content: Array<{ type?: string; text?: string }>
            }
            assert.equal(followUpUser.role, "user")
            const followUpTexts = followUpUser.content
                .filter((block) => block.type === "text")
                .map((block) => block.text || "")
                .join("\n")
            assert.equal(followUpTexts.includes("# Workspace Configuration"), false)

            yield {
                type: "tool_calls",
                tool_call: {
                    function: {
                        id: "toolu_subagent_workspace_complete_1",
                        name: DiracDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })

        const promptRegistry = PromptRegistry.getInstance()
        sinon.stub(promptRegistry, "get").callsFake(async () => {
            promptRegistry.nativeTools = [{ name: "list_files" } as any]
            return "system prompt"
        })
        sinon.stub(skills, "getOrDiscoverSkills").resolves([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const runner = new SubagentRunner(createTaskConfigWithListFilesSnapshot())
        const result = await runner.run("List files", () => { })

        assert.equal(result.status, "completed")
        assert.equal(result.result, "done")
        assert.equal(createMessage.callCount, 2)
    })
})
