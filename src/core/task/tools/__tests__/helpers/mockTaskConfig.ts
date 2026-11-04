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

import { CardKind, CardStatus, isFinalStatus } from "@shared/ExtensionMessage"
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
		load: async () => { },
		save: async () => { },
		ensureAnchorState: async () => { },
		markAnchorStateDirty: () => { },
		task: {
			get: async <T>(key: string): Promise<T | undefined> => taskData[key] as T,
			getEntry: async <T>(key: string, entryKey: string): Promise<T | undefined> => taskData[key]?.[entryKey] as T,
			getEntries: async <T>(key: string, entryKeys: readonly string[]): Promise<Record<string, T>> =>
				Object.fromEntries(entryKeys.filter((entryKey) => taskData[key]?.[entryKey] !== undefined).map((entryKey) => [entryKey, taskData[key][entryKey]])),
			set: async <T>(key: string, value: T): Promise<void> => {
				taskData[key] = value
			},
			update: async <T>(key: string, updater: (value: T | undefined) => T): Promise<void> => {
				taskData[key] = updater(taskData[key] as T | undefined)
			},
			updateEntries: async <T>(key: string, updates: Record<string, T>, deletions: readonly string[] = []) => {
				const current = (taskData[key] ?? {}) as Record<string, T>
				Object.assign(current, updates)
				for (const entryKey of deletions) delete current[entryKey]
				taskData[key] = current
			},
		},
		workspace: {
			get: <T>(_key: string): T | undefined => undefined as any,
			set: <T>(_key: string, _value: T): void => { },
		},
		global: {
			get: <T>(_key: string): T | undefined => undefined as any,
			set: <T>(_key: string, _value: T): void => { },
		},
		resetTaskContext: async () => { },
	}
}

export function createMockTaskMessenger() {
	let nextCardId = 0
	return {
		upsertText: sinon.stub().resolves(),
		streamText: sinon.stub().resolves({
			appendMarkdown: sinon.stub().resolves(),
			appendReasoning: sinon.stub().resolves(),
			close: sinon.stub().resolves(),
		}),
		createCard: sinon.stub().callsFake(async (params: any) => {
			const id = `mock-card-${++nextCardId}`
			const now = Date.now()
			let card: any = {
				id,
				kind: params.kind ?? CardKind.GENERIC,
				header: params.header,
				status:
					params.status ??
					(params.requireApproval || params.requireFeedback ? CardStatus.WAITING_FOR_INPUT : CardStatus.RUNNING),
				renderType: params.renderType ?? "text",
				collapsed: params.collapsed,
				startTime: now,
				...params,
			}
			return {
				id,
				getCard: () => card,
				update: sinon.stub().callsFake(async (patch: any) => {
					card = { ...card, ...patch }
				}),
				appendBody: sinon.stub().callsFake(async (chunk: string) => {
					card = { ...card, body: `${card.body ?? ""}${chunk}` }
				}),
				finalize: sinon.stub().callsFake(async (status: CardStatus) => {
					card = { ...card, status, ...(isFinalStatus(status) ? { endTime: Date.now() } : {}) }
				}),
				waitForInteraction: sinon.stub().resolves({
					action: DiracAskResponse.APPROVE,
					value: undefined,
					text: undefined,
					images: undefined,
					files: undefined,
					userEdits: undefined,
				}),
			}
		}),
	}
}

export function createMockCallbacks(): TaskCallbacks {
	return {
		assertMutationAuthorized: sinon.stub(),
		withMutationAuthorization: async <T>(_toolName: unknown, mutation: () => Promise<T>) => await mutation(),
		transitionFromMutation: async <T>(transition: () => Promise<T>) => transition(),
		retainMutationUntil: sinon.stub(),
		commitEnabledToolToggles: sinon.stub().callsFake(async (_toolIds, finalize) => finalize?.()),
		saveCheckpoint: sinon.stub().resolves(),
		commitAttemptCompletion: sinon.stub().resolves({ committed: true }),
		executeCommandTool: sinon.stub().resolves([false, "ok"]),
		cancelRunningCommandTool: sinon.stub().resolves(false),
		doesLatestTaskCompletionHaveNewChanges: sinon.stub().resolves(false),
		shouldAutoApproveToolWithPath: sinon.stub().resolves(true),
		resolveToolPathPermission: sinon.stub().resolves("auto_approve"),
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
		notifyContextCompacted: sinon.stub(),
		createUtilityModelRunner: sinon.stub(),
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
		lowVerbosityEnabled: true,
		vscodeTerminalExecutionMode: "backgroundExec" as const,
		enableParallelToolCalling: true,
		backgroundEditEnabled: false,
		providerId: "test-provider",
		customPrompt: undefined,
		hooksEnabled: false,
		subagentsEnabled: false,
		useAutoCondense: true,
		utilityModelEnabled: false,
		utilityModelUseCondense: true,
		utilityModelSelection: undefined,
		globalSkillsToggles: {},
		localSkillsToggles: {},
		taskState,
		messageState: {
			getApiConversationHistory: sinon.stub().returns([]),
			getDiracMessages: sinon.stub().returns([]),
			addToDiracMessages: sinon.stub().resolves(),
			flushPendingWrites: sinon.stub().resolves(),
		},
		model: { id: "test-model", info: { supportsImages: false } },
		supportsNativeWebSearch: false,
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
