import { DiracAskResponse } from "../../../../shared/WebviewMessage"


import { SkillMetadata } from "../../../../shared/skills"
import {
    IToolEnvironment,
    ICardHandle,
    ILoggingTrait,
    IUITrait,
    IInteractionTrait,
    ISystemTrait,
    ITelemetryTrait,
    IWorkspaceTrait,
    IASTTrait,
    IDiagnosticsTrait,
    IBrowserTrait,
    ISkillsTrait,
    IEditorTrait,
    ISymbolTrait,
    IOrchestrationTrait,
    SaveResult
} from "../interfaces/IToolEnvironment"

import { CardHandle } from "./CardHandle"
import { TaskConfig } from "../types/TaskConfig"
import { IDiracContext } from "../interfaces/IDiracContext"
import { resolveWorkspacePath } from "@core/workspace"
import { Logger } from "@/shared/services/Logger"
import { ASTAnchorBridge } from "@utils/ASTAnchorBridge"
import { HostProvider } from "@/hosts/host-provider"
import { listFiles } from "@services/glob/list-files"
import { regexSearchFiles } from "@services/ripgrep"
import { extractFileContent } from "@integrations/misc/extract-file-content"

import { openUrlInBrowser } from "@utils/github-url-utils"
import { ExtensionRegistryInfo } from "@/registry"
import * as os from "os"
import {
    getOrDiscoverSkills,
    getSkillContent,
    listSupportingFiles
} from "@core/context/instructions/user-instructions/skills"

import * as fs from "fs/promises"
import { SymbolIndexService } from "@/services/symbol-index/SymbolIndexService"
import { SubagentRunner } from "../subagent/SubagentRunner"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { DiracMessage } from "@shared/ExtensionMessage"



/**
 * SurfaceAdapter provides the standard implementation of IToolEnvironment for the Dirac surface.
 * It connects modular tools to the core services and capabilities of the Dirac application.
 */
export class SurfaceAdapter implements IToolEnvironment {
    public readonly ui: IUITrait
    public readonly interaction: IInteractionTrait
    public readonly system: ISystemTrait
    public readonly orchestration: IOrchestrationTrait
    public readonly telemetry: ITelemetryTrait
    public readonly workspace: IWorkspaceTrait
    public readonly ast: IASTTrait
    public readonly diagnostics: IDiagnosticsTrait
    public readonly editor: IEditorTrait
    public readonly symbol: ISymbolTrait

    public readonly browser: IBrowserTrait
    public readonly skills: ISkillsTrait
    public readonly logging: ILoggingTrait
    public readonly context: IDiracContext
    constructor(
        public readonly config: TaskConfig,
        public readonly toolName: string = "",
    ) {
        this.logging = {
            error: (message: string, ...args: any[]) => Logger.error(message, ...args),
            warn: (message: string, ...args: any[]) => Logger.warn(message, ...args),
            info: (message: string, ...args: any[]) => Logger.info(message, ...args),
            debug: (message: string, ...args: any[]) => Logger.debug(message, ...args),
            log: (message: string, ...args: any[]) => Logger.log(message, ...args),
            trace: (message: string, ...args: any[]) => Logger.trace(message, ...args),
        }
        this.ui = {
            createCard: this.createCard.bind(this),
            upsertText: async (text: string, isReasoning?: boolean, role?: "user" | "assistant") => {
                await this.config.taskMessenger.upsertText(text, isReasoning, undefined, undefined, role)
            },
            streamText: async (type: "markdown" | "reasoning") => {
                return await this.config.taskMessenger.streamText(type)
            },
        }
        this.interaction = {

            askPermission: async (message: string) => {
                const card = await this.createCard({
                    header: "Permission Request",
                    body: message,
                    requireApproval: true,
                    collapsed: false,
                })
                const result = await card.waitForInteraction()
                return {
                    approved: result.action === DiracAskResponse.APPROVE,
                    action: result.action,
                    value: result.value,
                    text: result.text,
                    images: result.images as string[] | undefined,
                    files: result.files as string[] | undefined,
                    userEdits: result.userEdits,
                    card,
                }
            },
        }

        this.browser = {
            launch: async (url: string) => {
                this.config.services.browserSession = await this.config.callbacks.applyLatestBrowserSettings()
                await this.config.services.browserSession.launchBrowser()
                return await this.config.services.browserSession.navigateToUrl(url)
            },
            click: async (coordinate: string) => {
                return await this.config.services.browserSession.click(coordinate)
            },
            type: async (text: string) => {
                return await this.config.services.browserSession.type(text)
            },
            scroll: async (direction: "up" | "down") => {
                if (direction === "up") {
                    return await this.config.services.browserSession.scrollUp()
                } else {
                    return await this.config.services.browserSession.scrollDown()
                }
            },
            close: async () => {
                return await this.config.services.browserSession.closeBrowser()
            },
        }

        this.skills = {
            getAvailableSkills: async () => {
                const resolvedSkills = await getOrDiscoverSkills(this.config.cwd, this.config.taskState)
                const stateManager = this.config.services.stateManager
                const globalSkillsToggles = stateManager.getGlobalSettingsKey("globalSkillsToggles") ?? {}
                const localSkillsToggles = stateManager.getWorkspaceStateKey("localSkillsToggles") ?? {}
                return resolvedSkills.filter((skill) => {
                    const toggles = skill.source === "global" ? globalSkillsToggles : localSkillsToggles
                    return toggles[skill.path] !== false
                })
            },
            getSkillContent: async (name: string, availableSkills: SkillMetadata[]) => {
                const content = await getSkillContent(name, availableSkills)
                return content || undefined
            },
            listSupportingFiles: async (path: string) => {
                return await listSupportingFiles(path)
            },
        }

        this.system = {
            executeCommand: this.executeCommand.bind(this),
            searchFiles: async (
                directoryPath: string,
                regex: string,
                options?: {
                    filePattern?: string
                    contextLines?: number
                    excludeFilePatterns?: string[]
                    debugLog?: (info: Record<string, any>) => Promise<void>
                },
            ) => {
                await options?.debugLog?.({
                    info: "SurfaceAdapter.searchFiles called",
                    cwd: this.config.cwd,
                    directoryPath,
                    regex,
                    filePattern: options?.filePattern,
                    taskId: this.config.taskId,
                    contextLines: options?.contextLines,
                    excludeFilePatterns: options?.excludeFilePatterns,
                })
                return await regexSearchFiles(
                    this.config.cwd,
                    directoryPath,
                    regex,
                    options?.filePattern,
                    this.config.services.diracIgnoreController,
                    this.config.taskId,
                    options?.contextLines,
                    options?.excludeFilePatterns,
                    options?.debugLog,
                )
            },
            getSystemInfo: async () => {
                const operatingSystem = os.platform() + " " + os.release()
                const diracVersion = ExtensionRegistryInfo.version
                const host = await HostProvider.env.getHostVersion({})
                const systemInfo = `${host.platform}: ${host.version}, Node.js: ${process.version}, Architecture: ${os.arch()}`
                const apiConfig = this.config.services.stateManager.getApiConfiguration()
                const provider =
                    this.config.mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider
                const providerAndModel = `${provider} / ${this.config.api.getModel().id}`
                return {
                    operatingSystem,
                    diracVersion,
                    hostInfo: `${host.platform} ${host.version}`,
                    systemInfo,
                    providerAndModel,
                }
            },
            openUrl: async (url: string) => {
                await openUrlInBrowser(url)
            },
        }
        this.telemetry = {
            captureCustomMetadata: (metadata: Record<string, any>) => {
                this.customMetadata = { ...this.customMetadata, ...metadata }
            },
        }
        this.workspace = {
            resolvePath: async (relPath: string) => {
                const result = resolveWorkspacePath(this.config, relPath, "SurfaceAdapter.resolvePath")
                return typeof result === "string" ? { absolutePath: result, displayPath: relPath } : result
            },
            readFile: async (path: string) => {
                return await fs.readFile(path, "utf8")
            },
            readRichFile: async (path: string) => {
                const supportsImages = this.config.api.getModel().info.supportsImages ?? false
                return await extractFileContent(path, supportsImages)
            },
            getFileInfo: async (path: string) => {
                try {
                    const stats = await fs.stat(path)
                    return { size: stats.size, isFile: stats.isFile(), exists: true }
                } catch {
                    return { size: 0, isFile: false, exists: false }
                }
            },


            listFiles: async (path: string, recursive: boolean, limit: number) => {
                return await listFiles(path, recursive, limit)
            },
            writeFile: async (path: string, content: string) => {
                await fs.writeFile(path, content, "utf8")
            },
            saveOpenDocumentIfDirty: async (options: { filePath: string }) => {
                await HostProvider.workspace.saveOpenDocumentIfDirty(options)
            },

        }
        this.ast = {
            getSkeleton: async (path: string, options?: { showCallGraph?: boolean }) => {
                const skeleton = await ASTAnchorBridge.getFileSkeleton(
                    path,
                    this.config.services.diracIgnoreController,
                    this.config.ulid,
                    options || { showCallGraph: true },
                )
                return skeleton || ""
            },

            getFunctions: async (absolutePath: string, relPath: string, functionNames: string[]) => {
                return await ASTAnchorBridge.getFunctions(
                    absolutePath,
                    relPath,
                    functionNames,
                    this.config.services.diracIgnoreController,
                    this.config.ulid,
                )
            },
        }
        this.diagnostics = {
            prepare: async (paths: string[]) => {
                await HostProvider.workspace.prepareDiagnostics({ filePaths: paths })
            },
            getRaw: async (paths: string[]) => {
                const response = await HostProvider.workspace.getDiagnostics({ filePaths: paths })
                return response.fileDiagnostics || []
            },
        }
        this.editor = {
            showReview: async (files) => {
                await this.config.services.diffViewProvider.showReview(files)
            },
            hideReview: async () => {
                await this.config.services.diffViewProvider.hideReview()
            },
            open: async (path, options) => {
                await this.config.services.diffViewProvider.open(path, options)
            },
            update: async (content, finalize) => {
                await this.config.services.diffViewProvider.update(content, finalize)
            },
            saveChanges: async (options) => {
                const result = await this.config.services.diffViewProvider.saveChanges(options)
                return {
                    content: result.finalContent || "",
                    userEdits: !!result.userEdits,
                    autoFormatting: !!result.autoFormattingEdits,
                }
            },
            applyAndSaveSilently: async (path, content) => {
                const result = await this.config.services.diffViewProvider.applyAndSaveSilently(path, content)
                return {
                    content: result.finalContent || "",
                    userEdits: !!result.userEdits,
                    autoFormatting: !!result.autoFormattingEdits,
                }
            },

            applyAndSaveBatchSilently: async (files) => {
                const results = await this.config.services.diffViewProvider.applyAndSaveBatchSilently(files)
                const mappedResults = new Map<string, SaveResult>()
                for (const [path, result] of results.entries()) {
                    mappedResults.set(path, {
                        content: result.finalContent || "",
                        userEdits: !!result.userEdits,
                        autoFormatting: !!result.autoFormattingEdits,
                    })
                }
                return mappedResults
            },
            revertChanges: async () => {
                await this.config.services.diffViewProvider.revertChanges()
            },
            reset: async () => {
                await this.config.services.diffViewProvider.reset()
            },
            scrollToFirstDiff: async () => {
                await this.config.services.diffViewProvider.scrollToFirstDiff()
            },
            undoUserEdits: async () => {
                await this.config.services.diffViewProvider.undoUserEdits()
            },
            format: async (path: string) => {
                return await this.config.services.diffViewProvider.format(path)
            },
        }

        this.symbol = {
            getSymbolRange: async (path, symbol, type) => {
                return (await ASTAnchorBridge.getSymbolRange(path, symbol, type)) || undefined
            },
            getDefinitions: async (symbol) => {
                return SymbolIndexService.getInstance().getDefinitions(symbol)
            },
            getReferences: async (symbol) => {
                return SymbolIndexService.getInstance().getReferences(symbol)
            },
            getSymbols: async (symbol) => {
                return SymbolIndexService.getInstance().getSymbols(symbol)
            },
            updateIndex: async (path) => {
                await SymbolIndexService.getInstance().updateFile(path)
            },
            initializeIndex: async (root) => {
                await SymbolIndexService.getInstance().initialize(root)
            },
        }


        this.context = config.context
        this.orchestration = {
            runSubagent: async (prompt, options) => {
                const runner = new SubagentRunner(this.config, options?.subagentName)
                return await runner.run(
                    prompt,
                    options?.onUpdate || (() => { }),
                    options?.timeout,
                    options?.maxTurns,
                    options?.includeHistory
                )
            },
            runHook: async (name, input, options) => {
                const { executeHook } = await import("@core/hooks/hook-executor")
                return await executeHook({
                    hookName: name as any,
                    hookInput: input,
                    messenger: this.config.taskMessenger,
                    isCancellable: options?.isCancellable ?? false,
                    setActiveHookExecution: this.config.callbacks.setActiveHookExecution,
                    clearActiveHookExecution: this.config.callbacks.clearActiveHookExecution,
                    messageStateHandler: this.config.messageState,
                    taskId: this.config.taskId,
                    hooksEnabled: this.config.services.stateManager.getGlobalSettingsKey("hooksEnabled") ?? false,
                    model: getHookModelContext(this.config.api, this.config.services.stateManager),
                })
            },
            switchToActMode: () => this.config.callbacks.switchToActMode(),
            saveCheckpoint: (isTaskComplete, messageTs) => this.config.callbacks.saveCheckpoint(isTaskComplete, messageTs),
            getHistory: () => this.config.messageState.getDiracMessages(),
            setTruncationRange: (range) => {
                this.config.taskState.conversationHistoryDeletedRange = range
            },
            getNextTruncationRange: (strategy: "none" | "half" | "quarter" | "lastTwo") => {
                return this.config.services.contextManager.getNextTruncationRange(
                    this.config.messageState.getApiConversationHistory(),
                    this.config.taskState.conversationHistoryDeletedRange,
                    strategy
                )
            },
            getTaskState: (key) => this.config.taskState[key],
            setTaskState: (key, value) => {
                ; (this.config.taskState as any)[key] = value
            },
            doesLatestTaskCompletionHaveNewChanges: () => this.config.callbacks.doesLatestTaskCompletionHaveNewChanges(),
            updateMessage: (index: number, updates: Partial<DiracMessage>) => this.config.callbacks.updateDiracMessage(index, updates),
            resetTransientState: () => this.config.callbacks.resetTransientState(),
        }


    }

    private customMetadata: Record<string, any> = {}

    public getCustomMetadata(): Record<string, any> {
        return this.customMetadata
    }

    private createdCards: CardHandle[] = []


    public async createCard(params: import("../interfaces/IToolEnvironment").CardParams): Promise<ICardHandle> {
        const handle = await this.config.taskMessenger.createCard(params)
        const adapterHandle = new CardHandle(handle, params)
        this.createdCards.push(adapterHandle)
        return adapterHandle
    }




    public async executeCommand(
        command: string,
        options?: { timeout?: number; onOutput?: (chunk: string) => void },
    ): Promise<[boolean, any]> {
        return this.config.callbacks.executeCommandTool(command, options?.timeout, {
            onOutputLine: options?.onOutput,
            suppressUserInteraction: true,
            useBackgroundExecution: true,
        })
    }


    public getCreatedCards(): CardHandle[] {
        return this.createdCards
    }
}
