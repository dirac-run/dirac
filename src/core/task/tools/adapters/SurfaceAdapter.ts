import { IDiracContext } from "../interfaces/IDiracContext"
import {
	CardParams,
	IASTTrait,
	IBrowserTrait,
	ICardHandle,
	IDiagnosticsTrait,
	IEditorTrait,
	IInteractionTrait,
	ILoggingTrait,
	IOrchestrationTrait,
	ISkillsTrait,
	ISymbolTrait,
	ISystemTrait,
	ITelemetryTrait,
	IToolEnvironment,
	IUITrait,
	IWorkspaceTrait,
} from "../interfaces/IToolEnvironment"
import { TaskConfig } from "../types/TaskConfig"
import { CardHandle } from "./CardHandle"
import { buildAstTrait, buildDiagnosticsTrait, buildEditorTrait, buildSymbolTrait } from "./traits/AstEditorSymbolTraitBuilder"
import { buildBrowserTrait } from "./traits/BrowserTraitBuilder"
import { buildLoggingTrait } from "./traits/LoggingTraitBuilder"
import { buildOrchestrationTrait } from "./traits/OrchestrationTraitBuilder"
import { buildSkillsTrait } from "./traits/SkillsTraitBuilder"
import { buildSystemTrait } from "./traits/SystemTraitBuilder"
import { buildInteractionTrait, buildUiTrait, createCardFromMessenger } from "./traits/UiTraitBuilder"
import { buildTelemetryTrait, buildWorkspaceTrait } from "./traits/WorkspaceTraitBuilder"

/**
 * SurfaceAdapter provides the standard implementation of IToolEnvironment for the Dirac surface.
 * It connects modular tools to the core services and capabilities of the Dirac application.
 * Trait wiring is delegated to builder functions in ./traits/ for maintainability.
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

	public customMetadata: Record<string, any> = {}
	private createdCards: CardHandle[] = []

	constructor(
		public readonly config: TaskConfig,
		public readonly toolName: string = "",
	) {
		this.logging = buildLoggingTrait()
		this.ui = buildUiTrait(config, this.createCard.bind(this))
		this.interaction = buildInteractionTrait(config, this.createCard.bind(this))
		this.browser = buildBrowserTrait(config)
		this.skills = buildSkillsTrait(config)
		this.system = buildSystemTrait(config, this.executeCommand.bind(this))
		this.telemetry = buildTelemetryTrait(this)
		this.workspace = buildWorkspaceTrait(config)
		this.ast = buildAstTrait(config)
		this.diagnostics = buildDiagnosticsTrait()
		this.editor = buildEditorTrait(config)
		this.symbol = buildSymbolTrait()
		this.context = config.context
		this.orchestration = buildOrchestrationTrait(config)
	}

	public getCustomMetadata(): Record<string, any> {
		return this.customMetadata
	}

	public async createCard(params: CardParams): Promise<ICardHandle> {
		return await createCardFromMessenger(
			this.config,
			{ ...params, locations: params.locations ?? this.locationsForTool() },
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
