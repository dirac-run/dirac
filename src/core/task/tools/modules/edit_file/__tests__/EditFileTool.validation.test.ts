import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DiracDefaultTool } from "@shared/tools"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { ANCHOR_DELIMITER } from "@utils/line-hashing"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import * as getDiagnosticsProvidersModule from "@/integrations/diagnostics/getDiagnosticsProviders"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { TaskState } from "../../../../TaskState"
import { ToolValidator } from "../../../ToolValidator"
import type { TaskConfig } from "../../../types/TaskConfig"
import { EditFileTool } from "../EditFileTool"
import { SurfaceAdapter } from "../../../adapters/SurfaceAdapter"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { createMockContext, createMockTaskMessenger } from "../../../__tests__/helpers/mockTaskConfig"

class EditFileToolHandler {
    private tool = new EditFileTool()
    constructor(_validator: any, _forceSyntaxChecker: boolean) { }
    async execute(config: TaskConfig, block: any) {
        const env = new SurfaceAdapter(config)
        return this.tool.processCall(block.params, env)
    }
}

let tmpDir: string

function createConfig() {
    const taskState = new TaskState()
    let lastPath: string | undefined
    let lastContent: string | undefined
    const diffViewProvider = {
        open: sinon.stub().callsFake(async (path: string) => {
            lastPath = path
        }),
        update: sinon.stub().callsFake(async (content: string) => {
            lastContent = content
        }),
        reset: sinon.stub().resolves(),
        saveChanges: sinon.stub().callsFake(async () => {
            if (lastPath && lastContent !== undefined) {
                await fs.writeFile(lastPath, lastContent)
            }
            return { finalContent: lastContent }
        }),
        applyAndSaveSilently: sinon.stub().callsFake(async (path: string, content: string) => {
            await fs.writeFile(path, content)
            return { finalContent: content }
        }),

        applyAndSaveBatchSilently: sinon.stub().callsFake(async (files: any[]) => {
            const results = new Map()
            for (const file of files) {
                await fs.writeFile(file.path, file.content)
                results.set(file.path, { finalContent: file.content })
            }
            return results
        }),
        showReview: sinon.stub().resolves(),
        scrollToFirstDiff: sinon.stub().resolves(),
        hideReview: sinon.stub().resolves(),
        undoUserEdits: sinon.stub().resolves(),
    }


    const callbacks = {
        say: sinon.stub().resolves(undefined),
        ask: sinon.stub().resolves({ response: DiracAskResponse.APPROVE }),
        saveCheckpoint: sinon.stub().resolves(),
        sayAndCreateMissingParamError: sinon.stub().resolves("missing"),
        removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
        shouldAutoApproveToolWithPath: sinon.stub().resolves(true),
        postStateToWebview: sinon.stub().resolves(),
        cancelTask: sinon.stub().resolves(),
        switchToActMode: sinon.stub().resolves(false),
        setActiveHookExecution: sinon.stub().resolves(),
        clearActiveHookExecution: sinon.stub().resolves(),
        getActiveHookExecution: sinon.stub().resolves(undefined),
        runUserPromptSubmitHook: sinon.stub().resolves({}),
        executeCommandTool: sinon.stub().resolves([false, "ok"]),
        cancelRunningCommandTool: sinon.stub().resolves(false),
        doesLatestTaskCompletionHaveNewChanges: sinon.stub().resolves(false),
        updateFCListFromToolResponse: sinon.stub().resolves(),
        shouldAutoApproveTool: sinon.stub().returns([true, true]),
        applyLatestBrowserSettings: sinon.stub().resolves(undefined),
    }

    const config = {
        taskId: "task-1",
        ulid: "ulid-1",
        cwd: tmpDir,
        mode: "act",
        strictPlanModeEnabled: false,
        yoloModeToggled: true,
        doubleCheckCompletionEnabled: false,
        vscodeTerminalExecutionMode: "backgroundExec",
        enableParallelToolCalling: true,
        isSubagentExecution: true, // skip UI calls and approval flow
        taskState,
        messageState: {
            getApiConversationHistory: sinon.stub().returns([]),
        },
        api: {
            getModel: () => ({ id: "test-model", info: { supportsImages: false } }),
        },
        autoApprovalSettings: {
            enableNotifications: false,
            actions: { executeCommands: false },
        },
        autoApprover: {
            shouldAutoApproveTool: sinon.stub().returns([true, true]),
        },
        browserSettings: {},
        focusChainSettings: {},
        services: {
            stateManager: {
                getGlobalStateKey: () => undefined,
                getGlobalSettingsKey: (key: string) => {
                    if (key === "mode") return "act"
                    if (key === "hooksEnabled") return false
                    return undefined
                },
                getApiConfiguration: () => ({
                    planModeApiProvider: "openai",
                    actModeApiProvider: "openai",
                }),
            },
            fileContextTracker: {
                trackFileContext: sinon.stub().resolves(),
                markFileAsEditedByDirac: sinon.stub(),
            },
            browserSession: {},
            urlContentFetcher: {},
            diffViewProvider,
            diracIgnoreController: { validateAccess: () => true },
            commandPermissionController: {},
            contextManager: {},
        },
        callbacks,
        coordinator: { getHandler: sinon.stub() },
        context: createMockContext(),

        taskMessenger: createMockTaskMessenger(),

    } as unknown as TaskConfig

    const validator = new ToolValidator({ validateAccess: () => true } as any)

    return { config, callbacks, taskState, validator }
}

describe("EditFileTool.execute – validation", () => {
    let sandbox: sinon.SinonSandbox

    beforeEach(async () => {
        sandbox = sinon.createSandbox()
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-edit-val-test-"))

        sandbox.stub(getDiagnosticsProvidersModule, "getDiagnosticsProviders").returns([
            {
                capturePreSaveState: sandbox.stub().resolves([]),
                getDiagnosticsFeedback: sandbox.stub().resolves({ newProblemsMessage: "", fixedCount: 0 }),
                getDiagnosticsFeedbackForFiles: sandbox.stub().callsFake(async (data) => data.map(() => ({ newProblemsMessage: "", fixedCount: 0 }))),
            } as any,
        ])

        setVscodeHostProviderMock({
            hostBridgeClient: {
                workspaceClient: {
                    getDiagnostics: sandbox.stub().resolves({ fileDiagnostics: [] }),
                    prepareDiagnostics: sandbox.stub().resolves({}),
                    getWorkspacePaths: sandbox.stub().resolves({ paths: [tmpDir] }),
                    saveOpenDocumentIfDirty: sandbox.stub().resolves({ wasSaved: false }),
                },
            } as any,
        })
    })

    afterEach(async () => {
        sandbox.restore()
        HostProvider.reset()
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { })
    })

    it("successfully parses stringified edits array", async () => {
        const { config, taskState, validator } = createConfig()
        const handler = new EditFileToolHandler(validator, false)

        const fileName = "test.txt"
        const filePath = path.join(tmpDir, fileName)
        const originalContent = "line 1\nline 2\nline 3"
        await fs.writeFile(filePath, originalContent)

        const lines = originalContent.split("\n")
        const anchors = AnchorStateManager.reconcile(filePath, lines, config.ulid).map(
            (a, i) => `${a}${ANCHOR_DELIMITER}${lines[i]}`,
        )

        const edits = [{ edit_type: "replace", anchor: anchors[1], end_anchor: anchors[1], text: "new line 2" }]
        const block = {
            type: "tool_use" as const,
            name: DiracDefaultTool.EDIT_FILE,
            params: {
                files: [
                    {
                        path: fileName,
                        edits: edits,
                    },
                ],
            },

            call_id: "call-1",
        }

        taskState.assistantMessageContent = [block]

        const result = await handler.execute(config, block)

        // Verify disk content
        const finalContent = await fs.readFile(filePath, "utf8")
        assert.equal(finalContent, "line 1\nnew line 2\nline 3")

        // Verify tool response indicates success
        assert.ok(typeof result === "string")
        assert.ok(result.includes("Applied 1 edit(s) successfully"))
    })

    it("rejects non-array edits if parsing fails", async () => {
        const { config, taskState, validator } = createConfig()
        const handler = new EditFileToolHandler(validator, false)

        await fs.writeFile(path.join(tmpDir, "test.txt"), "some content")

        const block = {
            type: "tool_use" as const,
            name: DiracDefaultTool.EDIT_FILE,
            params: {
                files: [
                    {
                        path: "test.txt",
                        edits: "not-json",
                    },
                ],
            },

            call_id: "call-2",
        }

        taskState.assistantMessageContent = [block]

        const result = await handler.execute(config, block)

        // Verify tool response indicates error
        assert.ok(typeof result === "string")
        assert.ok(result.includes("The 'edits' parameter must be a valid JSON array of objects. If you provided a string, ensure it is valid JSON."))
    })

    it("rejects non-array edits if string parsing fails", async () => {
        const { config, taskState, validator } = createConfig()
        const handler = new EditFileToolHandler(validator, false)

        await fs.writeFile(path.join(tmpDir, "test.txt"), "some content")

        const block = {
            type: "tool_use" as const,
            name: DiracDefaultTool.EDIT_FILE,
            params: {
                files: [
                    {
                        path: "test.txt",
                        edits: "not-json",
                    },
                ],
            },

            call_id: "call-3",
        }

        taskState.assistantMessageContent = [block]

        const result = await handler.execute(config, block)

        // Verify tool response indicates error
        assert.ok(typeof result === "string")
        assert.ok(result.includes("The \'edits\' parameter must be a valid JSON array of objects"))
    })
})
