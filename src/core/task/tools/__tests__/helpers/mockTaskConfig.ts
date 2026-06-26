/**
 * Shared mock factory for creating TaskConfig objects in tests.
 *
 * Usage:
 *   const { config, taskState } = createMockTaskConfig({ cwd: tmpDir })
 *
 * Pass overrides to customise any field. Nested objects (services, callbacks, …)
 * are shallow-merged so you can override a single service without replacing the
 * whole block.
 */

import { DiracAskResponse } from "@shared/WebviewMessage"
import sinon from "sinon"
import { TaskState } from "../../../TaskState"
import type { IDiracContext } from "../../interfaces/IDiracContext"
import type { TaskCallbacks, TaskConfig, TaskServices } from "../../types/TaskConfig"

/* ------------------------------------------------------------------ */
/*  Default mock implementations                                      */
/* ------------------------------------------------------------------ */

export function createMockContext(): IDiracContext {
	const taskData: Record<string, any> = {}
	return {
		load: async () => {},
		save: async () => {},
		task: {
			get: <T>(key: string): T | undefined => taskData[key] as T,
			set: <T>(key: string, value: T): void => {
				taskData[key] = value
			},
		},
		workspace: {
			get: <T>(_key: string): T | undefined => undefined as any,
			set: <T>(_key: string, _value: T): void => {},
		},
		global: {
			get: <T>(_key: string): T | undefined => undefined as any,
			set: <T>(_key: string, _value: T): void => {},
		},
		resetTaskContext: async () => {},
	}
}

export function createMockTaskMessenger() {
	return {
		upsertText: sinon.stub().resolves(),
		streamText: sinon.stub().resolves({
			appendMarkdown: sinon.stub().resolves(),
			appendReasoning: sinon.stub().resolves(),
			close: sinon.stub().resolves(),
		}),
		createCard: sinon.stub().resolves({
			id: "mock-card-id",
			update: sinon.stub().resolves(),
			appendBody: sinon.stub().resolves(),
			finalize: sinon.stub().resolves(),
			waitForInteraction: sinon.stub().resolves({
				action: DiracAskResponse.APPROVE,
				value: undefined,
				text: undefined,
				images: undefined,
				files: undefined,
				userEdits: undefined,
			}),
		}),
	}
}

export function createMockCallbacks(): TaskCallbacks {
	return {
		saveCheckpoint: sinon.stub().resolves(),
		executeCommandTool: sinon.stub().resolves([false, "ok"]),
		cancelRunningCommandTool: sinon.stub().resolves(false),
		doesLatestTaskCompletionHaveNewChanges: sinon.stub().resolves(false),
		shouldAutoApproveToolWithPath: sinon.stub().resolves(true),
		shouldAutoApproveTool: sinon.stub().returns([true, true]),
		postStateToWebview: sinon.stub().resolves(),
		cancelTask: sinon.stub().resolves(),
		getDiracMessages: sinon.stub().returns([]),
		updateDiracMessage: sinon.stub().resolves(),
		applyLatestBrowserSettings: sinon.stub().resolves({}),
		switchToActMode: sinon.stub().resolves(false),
		setActiveHookExecution: sinon.stub().resolves(),
		clearActiveHookExecution: sinon.stub().resolves(),
		getActiveHookExecution: sinon.stub().resolves(undefined),
		runUserPromptSubmitHook: sinon.stub().resolves({}),
		resetTransientState: sinon.stub().resolves(),
	}
}

export function createMockServices(overrides?: Partial<TaskServices>): TaskServices {
	const base: TaskServices = {
		browserSession: {} as any,
		urlContentFetcher: {} as any,
		diffViewProvider: {
			open: sinon.stub().resolves(),
			update: sinon.stub().resolves(),
			reset: sinon.stub().resolves(),
			saveChanges: sinon.stub().resolves({ finalContent: "" }),
			applyAndSaveSilently: sinon.stub().resolves({ finalContent: "" }),
			applyAndSaveBatchSilently: sinon.stub().resolves(new Map()),
			showReview: sinon.stub().resolves(),
			hideReview: sinon.stub().resolves(),
			scrollToFirstDiff: sinon.stub().resolves(),
			undoUserEdits: sinon.stub().resolves(),
		} as any,
		fileContextTracker: {
			trackFileContext: sinon.stub().resolves(),
			markFileAsEditedByDirac: sinon.stub(),
		} as any,
		diracIgnoreController: {
			validateAccess: () => true,
			filterPaths: (paths: string[]) => paths,
		} as any,
		commandPermissionController: {} as any,
		contextManager: {} as any,
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
		} as any,
	}

	return { ...base, ...overrides }
}

/* ------------------------------------------------------------------ */
/*  Main factory                                                      */
/* ------------------------------------------------------------------ */

export interface MockTaskConfigOptions {
	cwd?: string
	overrides?: Partial<TaskConfig>
	serviceOverrides?: Partial<TaskServices>
	callbackOverrides?: Partial<TaskCallbacks>
}

export function createMockTaskConfig(options: MockTaskConfigOptions = {}) {
	const { cwd = process.cwd(), overrides, serviceOverrides, callbackOverrides } = options

	const taskState = new TaskState()
	const callbacks = { ...createMockCallbacks(), ...callbackOverrides }
	const services = createMockServices(serviceOverrides)
	const context = createMockContext()
	const taskMessenger = createMockTaskMessenger()

	const config = {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd,
		mode: "act" as const,
		strictPlanModeEnabled: false,
		yoloModeToggled: true,
		doubleCheckCompletionEnabled: false,
		vscodeTerminalExecutionMode: "backgroundExec" as const,
		enableParallelToolCalling: true,
		isSubagentExecution: true,
		backgroundEditEnabled: false,
		taskState,
		messageState: {
			getApiConversationHistory: sinon.stub().returns([]),
			getDiracMessages: sinon.stub().returns([]),
			addToDiracMessages: sinon.stub().resolves(),
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
		services,
		callbacks,
		coordinator: { getHandler: sinon.stub(), has: sinon.stub().returns(false) },
		taskMessenger,
		context,
		...overrides,
	} as unknown as TaskConfig

	return {
		config: config as unknown as TaskConfig & {
			taskMessenger: ReturnType<typeof createMockTaskMessenger>
			callbacks: ReturnType<typeof createMockCallbacks>
			messageState: any
			services: TaskServices & {
				diracIgnoreController: any
				contextManager: any
			}
			taskState: any
		},
		taskState,
		callbacks,
		services,
		context,
		taskMessenger,
	}
}
