import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DiracDefaultTool } from "@shared/tools"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import * as getDiagnosticsProvidersModule from "@/integrations/diagnostics/getDiagnosticsProviders"
import { LinterFeedbackProvider } from "@/integrations/diagnostics/LinterFeedbackProvider"
import { DiagnosticSeverity } from "@/shared/proto/index.dirac"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { TaskState } from "../../../../TaskState"
import { ToolValidator } from "../../../ToolValidator"
import type { TaskConfig } from "../../../types/TaskConfig"
import { RenameSymbolTool } from "../RenameSymbolTool"
import { SurfaceAdapter } from "../../../adapters/SurfaceAdapter"
import { SymbolIndexService } from "@/services/symbol-index/SymbolIndexService"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { createMockContext, createMockTaskMessenger } from "../../../__tests__/helpers/mockTaskConfig"

let tmpDir: string

class RenameSymbolToolHandler {
    private tool = new RenameSymbolTool()
    constructor(_validator: any, _forceSyntaxChecker: boolean) { }
    async execute(config: TaskConfig, block: any) {
        const env = new SurfaceAdapter(config)
        return this.tool.processCall(block.params, env)
    }

    async handlePartialBlock(block: any, uiHelpers: any) {
        return (this.tool as any).handlePartialBlock?.(block, uiHelpers)
    }
}


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

        applyAndSaveBatchSilently: sinon.stub().callsFake(async (files: any[]) => {
            const results = new Map()
            for (const file of files) {
                const absolutePath = path.isAbsolute(file.path) ? file.path : path.join(tmpDir, file.path)
                await fs.writeFile(absolutePath, file.content)
                results.set(file.path, { finalContent: file.content })
            }
            return results
        }),
        applyAndSaveSilently: sinon.stub().callsFake(async (filePath: string, content: string) => {
            const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(tmpDir, filePath)
            await fs.writeFile(absolutePath, content)
            return { finalContent: content }
        }),
        showReview: sinon.stub().resolves(),
        hideReview: sinon.stub().resolves(),
        revertChanges: sinon.stub().resolves(),
        scrollToFirstDiff: sinon.stub().resolves(),
        undoUserEdits: sinon.stub().resolves(),
        format: sinon.stub().resolves(),
        wrap: sinon.stub().resolves(),
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
        isSubagentExecution: false, // allow UI calls and approval flow
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
            institution: {},
            possible: {},
            diffViewProvider,
            diracIgnoreController: { validateAccess: () => true },
            commandPermissionController: {},
            father: {},
            requests: {},
        },
        callbacks,
        coordinator: { getHandler: sinon.stub() },
        workspaceManager: {
            getPrimaryRoot: () => ({ path: tmpDir }),
        },
        context: createMockContext(),

        taskMessenger: createMockTaskMessenger(),

    } as unknown as TaskConfig

    const validator = new ToolValidator({ validateAccess: () => true } as any)

    return { config, callbacks, taskState, validator }
}

describe("RenameSymbolToolHandler", () => {
    let sandbox: sinon.SinonSandbox
    let getDiagnosticsStub: sinon.SinonStub
    let symbolIndexServiceStub: sinon.SinonStubbedInstance<SymbolIndexService>

    beforeEach(async () => {
        sandbox = sinon.createSandbox()
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-rename-test-"))
        getDiagnosticsStub = sandbox.stub().resolves({ fileDiagnostics: [] })

        // Mock getDiagnosticsProviders
        sandbox.stub(getDiagnosticsProvidersModule, "getDiagnosticsProviders").callsFake((useLinter) => {
            return [new LinterFeedbackProvider(200, 50)]
        })

        setVscodeHostProviderMock({
            hostBridgeClient: {
                workspaceClient: {
                    getDiagnostics: getDiagnosticsStub,
                    prepareDiagnostics: sandbox.stub().resolves({}),
                    getWorkspacePaths: sandbox.stub().resolves({ paths: [tmpDir] }),
                    saveOpenDocumentIfDirty: sandbox.stub().resolves({ wasSaved: false }),
                },
            } as any,
        })

        // Mock SymbolIndexService
        symbolIndexServiceStub = sandbox.createStubInstance(SymbolIndexService)
        symbolIndexServiceStub.getProjectRoot.returns(tmpDir)
        sandbox.stub(SymbolIndexService, "getInstance").returns(symbolIndexServiceStub as any)
    })

    afterEach(async () => {
        sandbox.restore()
        HostProvider.reset()
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { })
    })

    it("renames a symbol in a single file", async () => {
        const { config, validator } = createConfig()
        const handler = new RenameSymbolToolHandler(validator, false)

        const fileName = "test.ts"
        const filePath = path.join(tmpDir, fileName)
        const originalContent = "function oldName() {\n  console.log('hello');\n}\noldName();"
        await fs.writeFile(filePath, originalContent)

        symbolIndexServiceStub.getSymbols.withArgs("oldName").returns([
            { path: path.join(tmpDir, fileName), startLine: 0, startColumn: 9, endLine: 0, endColumn: 16, type: "definition" },
            { path: path.join(tmpDir, fileName), startLine: 3, startColumn: 0, endLine: 3, endColumn: 7, type: "reference" },
        ])

        const block = {
            type: "tool_use" as const,
            name: DiracDefaultTool.RENAME_SYMBOL,
            params: {
                existing_symbol: "oldName",
                new_symbol: "newName",
                paths: [fileName],
            },

            call_id: "call-1",
        }

        const result = await handler.execute(config, block)
        assert.ok(typeof result === "string")
        assert.ok(result.includes("Successfully renamed symbol 'oldName' to 'newName' (2 occurrences in 1 files)"))

        const finalContent = await fs.readFile(filePath, "utf8")
        assert.strictEqual(finalContent, "function newName() {\n  console.log('hello');\n}\nnewName();")
    })

    it("renames a symbol across multiple files", async () => {
        const { config, validator } = createConfig()
        const handler = new RenameSymbolToolHandler(validator, false)

        const file1 = "file1.ts"
        const file2 = "file2.ts"
        const path1 = path.join(tmpDir, file1)
        const path2 = path.join(tmpDir, file2)

        await fs.writeFile(path1, "export const myVar = 1;")
        await fs.writeFile(path2, "import { myVar } from './file1';\nconsole.log(myVar);")

        symbolIndexServiceStub.getSymbols.withArgs("myVar").returns([
            { path: path1, startLine: 0, startColumn: 13, endLine: 0, endColumn: 18, type: "definition" },
            { path: path2, startLine: 0, startColumn: 9, endLine: 0, endColumn: 14, type: "reference" },
            { path: path2, startLine: 1, startColumn: 12, endLine: 1, endColumn: 17, type: "reference" },
        ])

        const block = {
            type: "tool_use" as const,
            name: DiracDefaultTool.RENAME_SYMBOL,
            params: {
                existing_symbol: "myVar",
                new_symbol: "newVar",
                paths: [file1, file2],
            },

            call_id: "call-2",
        }

        const result = await handler.execute(config, block)
        assert.strictEqual(typeof result, "string")
        assert.ok((result as string).includes("3 occurrences in 2 files"))

        const content1 = await fs.readFile(path1, "utf8")
        const content2 = await fs.readFile(path2, "utf8")
        assert.strictEqual(content1, "export const newVar = 1;")
        assert.strictEqual(content2, "import { newVar } from './file1';\nconsole.log(newVar);")
    })

    it("only replaces exact matches of the symbol name", async () => {
        const { config, validator } = createConfig()
        const handler = new RenameSymbolToolHandler(validator, false)

        const fileName = "test.ts"
        const filePath = path.join(tmpDir, fileName)
        // oldName is the target, oldNameSuffix and prefixOldName should not be touched even if index is slightly off
        const originalContent = "const oldName = 1;\nconst oldNameSuffix = 2;\nconst prefixOldName = 3;"
        await fs.writeFile(filePath, originalContent)

        symbolIndexServiceStub.getSymbols.withArgs("oldName").returns([
            { path: filePath, startLine: 0, startColumn: 6, endLine: 0, endColumn: 13, type: "definition" },
        ])

        const block = {
            type: "tool_use" as const,
            name: DiracDefaultTool.RENAME_SYMBOL,
            params: {
                existing_symbol: "oldName",
                new_symbol: "newName",
                paths: [fileName],
            },

            call_id: "call-3",
        }

        const result = await handler.execute(config, block)
        assert.strictEqual(typeof result, "string")
        assert.ok((result as string).includes("1 occurrences in 1 files")) // Only 1 should be replaced

        const finalContent = await fs.readFile(filePath, "utf8")
        assert.strictEqual(finalContent, "const newName = 1;\nconst oldNameSuffix = 2;\nconst prefixOldName = 3;")
    })

    it("handles cases where the symbol is not found gracefully", async () => {
        const { config, validator } = createConfig()
        const handler = new RenameSymbolToolHandler(validator, false)

        symbolIndexServiceStub.getSymbols.returns([])

        const block = {
            type: "tool_use" as const,
            name: DiracDefaultTool.RENAME_SYMBOL,
            params: {
                existing_symbol: "nonExistent",
                new_symbol: "newName",
                paths: ["."],
            },

            call_id: "call-4",
        }

        const result = await handler.execute(config, block)
        assert.strictEqual(result, "No occurrences of symbol 'nonExistent' found in the specified paths.")
    })

    it("asks for approval when not auto-approved", async () => {
        const { config, callbacks, validator } = createConfig()
        const handler = new RenameSymbolToolHandler(validator, false)

        // Mock not auto-approved
        callbacks.shouldAutoApproveToolWithPath.resolves(false)
        callbacks.ask.resolves({ response: DiracAskResponse.APPROVE })

        const fileName = "test.ts"
        const filePath = path.join(tmpDir, fileName)
        await fs.writeFile(filePath, "const x = 1;")

        symbolIndexServiceStub.getSymbols.returns([
            { path: filePath, startLine: 0, startColumn: 6, endLine: 0, endColumn: 7, type: "definition" },
        ])

        const block = {
            type: "tool_use" as const,
            name: DiracDefaultTool.RENAME_SYMBOL,
            params: {
                existing_symbol: "x",
                new_symbol: "y",
                paths: [fileName],
            },

            call_id: "call-5",
        }

        await handler.execute(config, block)
        const createCardStub = config.taskMessenger.createCard as sinon.SinonStub
        const hasApprovalCard = createCardStub.args.some((args: any[]) => args[0]?.requireApproval === true)
        assert.ok(hasApprovalCard, "Expected approval to be requested via card")
    })

    it("handles denial of approval", async () => {
        const { config, callbacks, validator } = createConfig()
        const handler = new RenameSymbolToolHandler(validator, false)

        callbacks.shouldAutoApproveToolWithPath.resolves(false)
        callbacks.ask.resolves({ response: DiracAskResponse.REJECT })
        // Override card to return REJECT instead of the default APPROVE
        const createCardStub = config.taskMessenger.createCard as sinon.SinonStub
        createCardStub.resolves({
            id: "mock-card-id",
            update: sinon.stub().resolves(),
            appendBody: sinon.stub().resolves(),
            finalize: sinon.stub().resolves(),
            waitForInteraction: sinon.stub().resolves({
                action: DiracAskResponse.REJECT,
                response: DiracAskResponse.REJECT,
            }),
        })

        const fileName = "test.ts"
        const filePath = path.join(tmpDir, fileName)
        await fs.writeFile(filePath, "const x = 1;")

        symbolIndexServiceStub.getSymbols.returns([
            { path: filePath, startLine: 0, startColumn: 6, endLine: 0, endColumn: 7, type: "definition" },
        ])

        const block = {
            type: "tool_use" as const,
            name: DiracDefaultTool.RENAME_SYMBOL,
            params: {
                existing_symbol: "x",
                new_symbol: "y",
                paths: [fileName],
            },

            call_id: "call-6",
        }

        const result = await handler.execute(config, block)
        assert.strictEqual(result, "The user denied this operation.")

        const content = await fs.readFile(filePath, "utf8")
        assert.strictEqual(content, "const x = 1;") // No change
    })

    it("reports new problems detected after renaming", async () => {
        const { config, validator } = createConfig()
        const handler = new RenameSymbolToolHandler(validator, false)

        const fileName = "test.ts"
        const filePath = path.join(tmpDir, fileName)
        await fs.writeFile(filePath, "const x = 1;")

        symbolIndexServiceStub.getSymbols.returns([
            { path: filePath, startLine: 0, startColumn: 6, endLine: 0, endColumn: 7, type: "definition" },
        ])

        // Mock post-diagnostics with a new error
        getDiagnosticsStub.onCall(0).resolves({
            fileDiagnostics: [
                {
                    filePath,
                    diagnostics: [{ severity: DiagnosticSeverity.DIAGNOSTIC_ERROR, message: "New Error", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 11 } } }],
                },
            ],
        })

        const block = {
            type: "tool_use" as const,
            name: DiracDefaultTool.RENAME_SYMBOL,
            params: {
                existing_symbol: "x",
                new_symbol: "y",
                paths: [fileName],
            },

            call_id: "call-7",
        }

        const result = await handler.execute(config, block)
        assert.strictEqual(typeof result, "string")
        const resultStr = result as string
        assert.ok(resultStr.includes("error(s) detected after rename"))
        assert.ok(resultStr.includes("New Error"))
    })


    it("handles empty paths array by returning a missing param error", async () => {
        const { config, callbacks, validator } = createConfig()
        const handler = new RenameSymbolToolHandler(validator, false)

        const block = {
            type: "tool_use" as const,
            name: DiracDefaultTool.RENAME_SYMBOL,
            params: {
                existing_symbol: "old",
                new_symbol: "new",
                paths: [],
            },

            call_id: "call-9",
        }

        try {
            await handler.execute(config, block)
            assert.fail("Expected an error to be thrown")
        } catch (error) {
            assert.ok(error instanceof Error)
            assert.ok((error as Error).message.includes("Missing required parameter: paths"))
        }
    })

    it("skips paths that do not exist", async () => {
        const { config, validator } = createConfig()
        const handler = new RenameSymbolToolHandler(validator, false)

        const block = {
            type: "tool_use" as const,
            name: DiracDefaultTool.RENAME_SYMBOL,
            params: {
                existing_symbol: "old",
                new_symbol: "new",
                paths: ["non-existent.ts"],
            },

            call_id: "call-10",
        }

        symbolIndexServiceStub.getSymbols.returns([])

        const result = await handler.execute(config, block)
        assert.strictEqual(result, "No occurrences of symbol 'old' found in the specified paths.")
    })
})
