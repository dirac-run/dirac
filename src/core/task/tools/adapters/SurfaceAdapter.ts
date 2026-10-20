import { IDiracContext } from "../interfaces/IDiracContext"
import {
	CardParams,
	IAnchorTrait,
	IBrowserTrait,
	ICardHandle,
	IDiagnosticsTrait,
	IEditorTrait,
	IInteractionTrait,
	ILoggingTrait,
	IOrchestrationTrait,
	ISkillsTrait,
	ISourceAstTrait,
	IConversationCondensationTrait,
	ISystemTrait,
	SystemCommandResult,
	ITelemetryTrait,
	IUITrait,
	IWorkspaceTrait,
	IResponseObserverTrait,
	TelemetryMetadata,
} from "../interfaces/IToolEnvironment"
import type { ToolExecutionEnvironment, ToolEnvironmentFactory } from "../interfaces/ToolEnvironmentFactory"
import { TaskConfig } from "../types/TaskConfig"
import { CardHandle } from "./CardHandle"
import { buildDiagnosticsTrait } from "./traits/DiagnosticsTraitBuilder"
import { buildEditorTrait } from "./traits/EditorTraitBuilder"
import { buildSourceAstTrait } from "./traits/SourceAstTraitBuilder"
import { buildBrowserTrait } from "./traits/BrowserTraitBuilder"
import { buildLoggingTrait } from "./traits/LoggingTraitBuilder"
import { buildOrchestrationTrait } from "./traits/OrchestrationTraitBuilder"
import { buildSkillsTrait } from "./traits/SkillsTraitBuilder"
import { buildSystemTrait } from "./traits/SystemTraitBuilder"
import {
	buildInteractionTrait,
	buildUiTrait,
	createCardFromMessenger,
	createManualInteractionCardFromMessenger,
} from "./traits/UiTraitBuilder"
import { buildTelemetryTrait } from "./traits/TelemetryTraitBuilder"
import { buildWorkspaceTrait } from "./traits/WorkspaceTraitBuilder"
import { buildConversationCondensationTrait } from "./traits/ConversationCondensationTraitBuilder"

import { AnchorStateManager } from "@utils/AnchorStateManager"
/**
 * SurfaceAdapter provides the standard implementation of IToolEnvironment for the Dirac surface.
 * It connects modular tools to the core services and capabilities of the Dirac application.
 * Trait wiring is delegated to builder functions in ./traits/ for maintainability.
 */
export class SurfaceAdapter implements ToolExecutionEnvironment {
	public readonly ui: IUITrait
	public readonly interaction: IInteractionTrait
	public readonly system: ISystemTrait
	public readonly orchestration: IOrchestrationTrait
	public readonly responseObserver: IResponseObserverTrait
	public readonly conversationCondensation?: IConversationCondensationTrait
	public readonly telemetry: ITelemetryTrait
	public readonly workspace: IWorkspaceTrait
	public readonly sourceAst: ISourceAstTrait
	public readonly anchors: IAnchorTrait
	public readonly diagnostics: IDiagnosticsTrait
	public readonly editor: IEditorTrait
	public readonly browser: IBrowserTrait
	public readonly skills: ISkillsTrait
	public readonly logging: ILoggingTrait
	public readonly context: IDiracContext

	public customMetadata: TelemetryMetadata = {}
	private createdCards: CardHandle[] = []

	constructor(
		public readonly config: TaskConfig,
		public readonly toolName: string = "",
	) {
		this.logging = buildLoggingTrait()
		this.ui = buildUiTrait(
			config,
			this.createCard.bind(this),
			this.createManualInteractionCard.bind(this),
		)
		this.interaction = buildInteractionTrait(config, this.createCard.bind(this))
		this.browser = buildBrowserTrait(config)
		this.skills = buildSkillsTrait(config)
		this.system = buildSystemTrait(config, this.executeCommand.bind(this))
		this.telemetry = buildTelemetryTrait(this, config)
		this.workspace = buildWorkspaceTrait(config)
		this.sourceAst = buildSourceAstTrait(config)
		this.anchors = {
			reconcile: (absolutePath, lines) => {
				const result = AnchorStateManager.reconcileWithChanges(absolutePath, lines, config.ulid)
				if (result.changed) config.context.markAnchorStateDirty(absolutePath)
				return result.anchors
			},
			getDocumentFingerprint: (absolutePath) =>
				AnchorStateManager.getDocumentFingerprint(absolutePath, config.ulid),
			clear: (absolutePath) => {
				AnchorStateManager.clearState(absolutePath, config.ulid)
				config.context.markAnchorStateDirty(absolutePath)
			},
		}
		this.diagnostics = buildDiagnosticsTrait()
		this.editor = buildEditorTrait(config)
		this.context = config.context
		this.orchestration = buildOrchestrationTrait(config)
		this.responseObserver = { recordResponse: async () => undefined }
		this.conversationCondensation = config.isSubagentExecution
			? undefined
			: buildConversationCondensationTrait(config)
	}

	public getCustomMetadata(): TelemetryMetadata {
		return this.customMetadata
	}

	public async createCard(params: CardParams): Promise<ICardHandle> {
		return await createCardFromMessenger(
			this.config,
			{
				...params,
				toolName: params.toolName ?? (this.toolName || undefined),
				locations: params.locations ?? this.locationsForTool(),
			},
			this.createdCards,
		)
	}

	public async createManualInteractionCard(params: CardParams): Promise<ICardHandle> {
		return await createManualInteractionCardFromMessenger(
			this.config,
			{
				...params,
				toolName: params.toolName ?? (this.toolName || undefined),
				locations: params.locations ?? this.locationsForTool(),
			},
			this.createdCards,
		)
	}

	private locationsForTool(): CardParams["locations"] {
		const args = this.config.toolUse?.params
		if (!args) return undefined

		const path = this.pathFromToolArguments(args)
		if (!path) return undefined

		const line = this.lineFromToolArguments(args)
		return [{ path, ...(line === undefined ? {} : { line }) }]
	}

	private pathFromToolArguments(args: Record<string, unknown>): string | undefined {
		for (const key of ["path", "file_path", "filePath"]) {
			const value = args[key]
			if (typeof value === "string" && value.trim()) return value
		}

		for (const key of ["paths", "files"]) {
			const value = args[key]
			if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) return value[0]
		}

		return undefined
	}

	private lineFromToolArguments(args: Record<string, unknown>): number | undefined {
		for (const key of ["start_line", "startLine", "line"]) {
			const value = args[key]
			if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
		}

		return undefined
	}

	public async executeCommand(command: string, options?: { timeout?: number }): Promise<SystemCommandResult> {
		const [userRejected, output, metadata] = await this.config.callbacks.executeCommandTool(command, options?.timeout, {
			suppressUserInteraction: true,
			useBackgroundExecution: true,
		})
		return {
			userRejected,
			output,
			completed: metadata?.completed,
			exitCode: metadata?.exitCode,
			signal: metadata?.signal,
			logFilePath: metadata?.logFilePath,
			backgroundCompletion: metadata?.backgroundCompletion,
		}
	}

	public getCreatedCards(): CardHandle[] {
		return this.createdCards
	}
}

export class SurfaceToolEnvironmentFactory implements ToolEnvironmentFactory {
	create(config: TaskConfig, toolName: string): SurfaceAdapter {
		return new SurfaceAdapter(config, toolName)
	}
}
