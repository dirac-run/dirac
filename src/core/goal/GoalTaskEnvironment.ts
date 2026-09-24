import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import type { ResponseArguments } from "@shared/responseTool"
import type { GoalChildRole } from "@shared/goal"
import type {
	CardParams,
	ICardHandle,
	IInteractionTrait,
	IResponseObserverTrait,
	ISystemTrait,
	ITelemetryTrait,
	IUITrait,
} from "@core/task/tools/interfaces/IToolEnvironment"
import type {
	ToolEnvironmentFactory,
	ToolExecutionEnvironment,
} from "@core/task/tools/interfaces/ToolEnvironmentFactory"
import { SurfaceAdapter } from "@core/task/tools/adapters/SurfaceAdapter"
import { DelegatingCardHandle } from "@core/task/tools/adapters/DelegatingCardHandle"
import { askPermissionOnCard } from "@core/task/tools/adapters/traits/UiTraitBuilder"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"

export interface GoalChildInteractionResult {
	action: DiracAskResponse | string
	response: DiracAskResponse
	value?: string
	text?: string
	images?: string[]
	files?: string[]
	userEdits?: Record<string, string>
}

export interface GoalChildSurfaceOwner {
	readonly goalId: string
	recordActivity(taskId: string): Promise<void>
	recordResponse(taskId: string, response: ResponseArguments): Promise<void>
	waitForInteraction(
		taskId: string,
		params: CardParams,
		card: ICardHandle,
	): Promise<GoalChildInteractionResult>
}

class GoalChildCardHandle extends DelegatingCardHandle {
	constructor(
		private readonly taskId: string,
		private readonly params: CardParams,
		card: ICardHandle,
		private readonly owner: GoalChildSurfaceOwner,
	) {
		super(card)
	}

	override async update(patch: Parameters<ICardHandle["update"]>[0]): Promise<void> {
		await this.card.update(patch)
		Object.assign(this.params, patch)
		await this.owner.recordActivity(this.taskId)
	}

	override waitForInteraction(): Promise<GoalChildInteractionResult> {
		if (this.requiresUserInteraction === false || this.status !== CardStatus.WAITING_FOR_INPUT) {
			return this.card.waitForInteraction()
		}
		return this.owner.waitForInteraction(this.taskId, this.currentParams(), this.card)
	}

	override async appendBody(chunk: string): Promise<void> {
		await this.card.appendBody(chunk)
		this.params.body = this.card.body
		await this.owner.recordActivity(this.taskId)
	}

	override async finalize(status: CardStatus, doNotAutoCollapse?: boolean): Promise<void> {
		await this.card.finalize(status, doNotAutoCollapse)
		await this.owner.recordActivity(this.taskId)
	}

	private currentParams(): CardParams {
		return {
			...this.params,
			header: this.card.header,
			icon: this.card.icon,
			renderType: this.card.renderType,
			body: this.card.body,
			rawInput: this.card.rawInput,
			rawOutput: this.card.rawOutput,
			locations: this.card.locations,
			requireApproval: this.card.requireApproval,
			requireFeedback: this.card.requireFeedback,
			feedbackPlaceholder: this.card.feedbackPlaceholder,
			actions: this.card.actions,
			maxHeight: this.card.maxHeight,
			cleanupStrategy: this.card.cleanupStrategy,
			collapsed: this.card.collapsed,
		}
	}
}

class GoalChildToolEnvironment implements ToolExecutionEnvironment {
	readonly telemetry: ITelemetryTrait
	readonly ui: IUITrait
	readonly interaction: IInteractionTrait
	readonly system: ISystemTrait
	readonly responseObserver: IResponseObserverTrait
	readonly goal = undefined
	readonly workspace
	readonly sourceAst
	readonly diagnostics
	readonly anchors
	readonly editor
	readonly browser
	readonly skills
	readonly orchestration
	readonly conversationCondensation
	readonly context
	readonly logging
	readonly config
	readonly toolName

	constructor(
		private readonly base: SurfaceAdapter,
		private readonly taskId: string,
		private readonly owner: GoalChildSurfaceOwner,
		observeResponses: boolean,
	) {
		this.config = base.config
		this.toolName = base.toolName
		this.workspace = base.workspace
		this.sourceAst = base.sourceAst
		this.diagnostics = base.diagnostics
		this.anchors = base.anchors
		this.editor = base.editor
		this.browser = base.browser
		this.skills = base.skills
		this.orchestration = base.orchestration
		this.conversationCondensation = base.conversationCondensation
		this.context = base.context
		this.logging = base.logging

		this.telemetry = { ...base.telemetry, captureTaskCompleted: () => undefined }
		this.system = { ...base.system, showNotification: () => undefined }
		this.ui = {
			...base.ui,
			createCard: async (params) => {
				const card = await base.ui.createCard(params)
				await owner.recordActivity(taskId)
				return new GoalChildCardHandle(taskId, params, card, owner)
			},
			createManualInteractionCard: async (params) => {
				const card = await base.ui.createManualInteractionCard(params)
				await owner.recordActivity(taskId)
				return new GoalChildCardHandle(taskId, params, card, owner)
			},
			publishState: async () => undefined,
		}
		this.interaction = {
			askPermission: (message, preview) => askPermissionOnCard((params) => this.ui.createCard(params), message, preview),
		}
		this.responseObserver = observeResponses
			? {
				recordResponse: async (response) => {
					const card = await base.ui.createCard({
						header: "Goal Task Response",
						toolName: "goal_child_response",
						body: response.text,
						rawInput: { tool: "respond", ...response },
						status: CardStatus.RUNNING,
						renderType: "markdown",
						collapsed: true,
					})
					await card.finalize(CardStatus.SUCCESS)
					await base.config.messageState.flushPendingWrites()
					await owner.recordResponse(taskId, response)
				},
			}
			: base.responseObserver
	}

	getCustomMetadata(): Record<string, unknown> {
		return this.base.getCustomMetadata()
	}

	getCreatedCards() {
		return this.base.getCreatedCards()
	}
}

export class GoalChildToolEnvironmentFactory implements ToolEnvironmentFactory {
	constructor(
		private readonly taskId: string,
		private readonly role: GoalChildRole,
		private readonly owner: GoalChildSurfaceOwner,
	) { }

	create(config: TaskConfig, toolName: string): ToolExecutionEnvironment {
		const surface = new SurfaceAdapter(config, toolName)
		const baseAttribution =
			this.role === "verification" ? `goal/verification:${this.taskId}` : `goal/child:${this.taskId}`
		surface.customMetadata = {
			goalId: this.owner.goalId,
			goalAttribution: config.isSubagentExecution
				? `${baseAttribution}/subagent:${config.agentIdentity?.id ?? "unknown"}`
				: baseAttribution,
		}
		return new GoalChildToolEnvironment(surface, this.taskId, this.owner, !config.isSubagentExecution)
	}
}
