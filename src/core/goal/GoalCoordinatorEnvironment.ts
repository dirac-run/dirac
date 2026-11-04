import { CardStatus } from "@shared/ExtensionMessage"
import type { ICardHandle, IGoalTrait, IInteractionTrait, IUITrait } from "@core/task/tools/interfaces/IToolEnvironment"
import type {
	ToolEnvironmentFactory,
	ToolExecutionEnvironment,
} from "@core/task/tools/interfaces/ToolEnvironmentFactory"
import { DelegatingCardHandle } from "@core/task/tools/adapters/DelegatingCardHandle"
import { SurfaceAdapter } from "@core/task/tools/adapters/SurfaceAdapter"
import { buildInteractionTrait } from "@core/task/tools/adapters/traits/UiTraitBuilder"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"

export interface GoalCoordinatorInteractionOwner {
	duringUserInteraction<T>(operation: () => Promise<T>): Promise<T>
}

class GoalCoordinatorCardHandle extends DelegatingCardHandle {
	constructor(card: ICardHandle, private readonly interactionOwner?: GoalCoordinatorInteractionOwner) {
		super(card)
	}

	override waitForInteraction(): ReturnType<ICardHandle["waitForInteraction"]> {
		if (
			!this.interactionOwner ||
			this.requiresUserInteraction === false ||
			this.status !== CardStatus.WAITING_FOR_INPUT
		) {
			return super.waitForInteraction()
		}
		return this.interactionOwner.duringUserInteraction(() => super.waitForInteraction())
	}
}

class GoalCoordinatorToolEnvironment implements ToolExecutionEnvironment {
	readonly ui: IUITrait
	readonly interaction: IInteractionTrait
	readonly goal: IGoalTrait
	readonly telemetry
	readonly system
	readonly responseObserver
	readonly conversationCondensation
	readonly workspace
	readonly sourceAst
	readonly anchors
	readonly diagnostics
	readonly editor
	readonly browser
	readonly skills
	readonly orchestration
	readonly context
	readonly logging
	readonly config
	readonly toolName

	constructor(
		private readonly base: SurfaceAdapter,
		goal: IGoalTrait,
		interactionOwner?: GoalCoordinatorInteractionOwner,
	) {
		this.goal = goal
		this.telemetry = base.telemetry
		this.system = base.system
		this.responseObserver = base.responseObserver
		this.conversationCondensation = base.conversationCondensation
		this.workspace = base.workspace
		this.sourceAst = base.sourceAst
		this.anchors = base.anchors
		this.diagnostics = base.diagnostics
		this.editor = base.editor
		this.browser = base.browser
		this.skills = base.skills
		this.orchestration = base.orchestration
		this.context = base.context
		this.logging = base.logging
		this.config = base.config
		this.toolName = base.toolName

		const wrapCard = async (card: Promise<ICardHandle>) =>
			new GoalCoordinatorCardHandle(await card, interactionOwner)
		const createCard = (params: Parameters<IUITrait["createCard"]>[0]) => wrapCard(base.ui.createCard(params))
		const createManualInteractionCard = (params: Parameters<IUITrait["createManualInteractionCard"]>[0]) =>
			wrapCard(base.ui.createManualInteractionCard(params))
		this.ui = { ...base.ui, createCard, createManualInteractionCard }
		this.interaction = buildInteractionTrait(base.config, createCard)
	}

	getCustomMetadata(): Record<string, unknown> {
		return this.base.getCustomMetadata()
	}

	getCreatedCards() {
		return this.base.getCreatedCards()
	}
}

export class GoalCoordinatorToolEnvironmentFactory implements ToolEnvironmentFactory {
	constructor(
		private readonly createGoalTrait: (surface: SurfaceAdapter) => IGoalTrait,
		private readonly interactionOwner?: GoalCoordinatorInteractionOwner,
	) { }

	create(config: TaskConfig, toolName: string): ToolExecutionEnvironment {
		const surface = new SurfaceAdapter(config, toolName)
		surface.customMetadata = {
			goalId: config.taskId,
			goalAttribution: "goal",
		}
		return new GoalCoordinatorToolEnvironment(surface, this.createGoalTrait(surface), this.interactionOwner)
	}
}
