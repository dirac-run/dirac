import { HostProvider } from "@hosts/host-provider"
import { ShowMessageType } from "@shared/proto/host/window"
import * as os from "os"
import { Setting } from "@/shared/proto/index.host"
import { Logger } from "@/shared/services/Logger"
import { version as extensionVersion } from "../../../package.json"
import { BrowserTelemetry } from "./BrowserTelemetry"
import { HookTelemetry } from "./HookTelemetry"
import { MentionTelemetry } from "./MentionTelemetry"
import type { ITelemetryProvider, TelemetryProperties } from "./providers/ITelemetryProvider"
import { SubagentTelemetry } from "./SubagentTelemetry"
import { TaskTelemetry } from "./TaskTelemetry"
import { TelemetryCategoryGate } from "./TelemetryCategoryGate"
import { TelemetryContextManager } from "./TelemetryContextManager"
import { TelemetryEventEmitter } from "./TelemetryEventEmitter"
import { TELEMETRY_EVENTS } from "./TelemetryEvents"
import { TELEMETRY_METRICS } from "./TelemetryMetrics"
import { TelemetryProviderFactory } from "./TelemetryProviderFactory"
import { TelemetryProviderManager } from "./TelemetryProviderManager"
import { TelemetrySessionTracker } from "./TelemetrySessionTracker"
import type {
	StandaloneOutputMethod,
	TelemetryCategory,
	TelemetryMetadata,
	TerminalOutputMethod,
	TerminalType,
	VscodeOutputMethod,
} from "./TelemetryTypes"
import { TerminalTelemetry } from "./TerminalTelemetry"
import { ToolTelemetry } from "./ToolTelemetry"
import { UiTelemetry } from "./UiTelemetry"
import { UserTelemetry } from "./UserTelemetry"
import { WorkspaceTelemetry } from "./WorkspaceTelemetry"

// Re-export types for backward compatibility — definitions live in TelemetryTypes.ts
export type {
	StandaloneOutputMethod,
	TelemetryCategory,
	TelemetryMetadata,
	TerminalOutputMethod,
	TerminalType,
	TokenUsage,
	VscodeOutputMethod,
} from "./TelemetryTypes"
export { TerminalHangStage, TerminalOutputFailureReason, TerminalUserInterventionAction } from "./TelemetryTypes"

/** Thin orchestrator: delegates domain capture calls to per-domain modules, retains core infra. */
export class TelemetryService {
	private contextManager: TelemetryContextManager
	private providerManager: TelemetryProviderManager
	private eventEmitter: TelemetryEventEmitter
	private sessionTracker: TelemetrySessionTracker
	private categoryGate: TelemetryCategoryGate
	private grpcResponseCount = 0
	public static readonly METRICS = TELEMETRY_METRICS
	private static readonly EVENTS = TELEMETRY_EVENTS

	private browser: BrowserTelemetry
	private hooks: HookTelemetry
	private mention: MentionTelemetry
	private subagents: SubagentTelemetry
	private task: TaskTelemetry
	private terminal: TerminalTelemetry
	private tool: ToolTelemetry
	private ui: UiTelemetry
	private user: UserTelemetry
	private workspace: WorkspaceTelemetry

	public static async create(): Promise<TelemetryService> {
		const providers = await TelemetryProviderFactory.createProviders()
		const v = await HostProvider.env.getHostVersion({})
		return new TelemetryService(providers, {
			extension_version: extensionVersion,
			platform: v.platform || "unknown",
			platform_version: v.version || "unknown",
			dirac_type: v.diracType || "unknown",
			os_type: os.platform(),
			os_version: os.version(),
			is_dev: process.env.IS_DEV,
		})
	}

	constructor(providers: ITelemetryProvider[], telemetryMetadata: TelemetryMetadata) {
		this.contextManager = new TelemetryContextManager(telemetryMetadata)
		this.providerManager = new TelemetryProviderManager(providers)
		this.sessionTracker = new TelemetrySessionTracker()
		this.eventEmitter = new TelemetryEventEmitter(this.providerManager, this.contextManager)
		this.categoryGate = new TelemetryCategoryGate()
		this.browser = new BrowserTelemetry(this.eventEmitter, this.categoryGate)
		this.hooks = new HookTelemetry(this.eventEmitter, this.categoryGate)
		this.mention = new MentionTelemetry(this.eventEmitter)
		this.subagents = new SubagentTelemetry(this.eventEmitter, this.categoryGate)
		this.task = new TaskTelemetry(this.eventEmitter, this.sessionTracker)
		this.terminal = new TerminalTelemetry(this.eventEmitter)
		this.tool = new ToolTelemetry(this.eventEmitter, this.sessionTracker, this.categoryGate)
		this.ui = new UiTelemetry(this.eventEmitter)
		this.user = new UserTelemetry(this.eventEmitter, this.contextManager, this.providerManager)
		this.workspace = new WorkspaceTelemetry(this.eventEmitter)

		this.capture({ event: TelemetryService.EVENTS.USER.TELEMETRY_ENABLED })
		Logger.info(`[TelemetryService] Initialized with ${providers.length} telemetry provider(s)`)
	}

	// ── Domain delegation — explicit one-line methods, statically verified via Parameters<> ──

	// User
	public captureUserOptOut(...a: Parameters<UserTelemetry["captureUserOptOut"]>) {
		return this.user.captureUserOptOut(...a)
	}
	public captureUserOptIn(...a: Parameters<UserTelemetry["captureUserOptIn"]>) {
		return this.user.captureUserOptIn(...a)
	}
	public captureExtensionActivated(...a: Parameters<UserTelemetry["captureExtensionActivated"]>) {
		return this.user.captureExtensionActivated(...a)
	}
	public captureExtensionStorageError(...a: Parameters<UserTelemetry["captureExtensionStorageError"]>) {
		return this.user.captureExtensionStorageError(...a)
	}
	public captureAuthStarted(...a: Parameters<UserTelemetry["captureAuthStarted"]>) {
		return this.user.captureAuthStarted(...a)
	}
	public captureAuthSucceeded(...a: Parameters<UserTelemetry["captureAuthSucceeded"]>) {
		return this.user.captureAuthSucceeded(...a)
	}
	public captureAuthFailed(...a: Parameters<UserTelemetry["captureAuthFailed"]>) {
		return this.user.captureAuthFailed(...a)
	}
	public captureAuthLoggedOut(...a: Parameters<UserTelemetry["captureAuthLoggedOut"]>) {
		return this.user.captureAuthLoggedOut(...a)
	}
	public captureOnboardingProgress(...a: Parameters<UserTelemetry["captureOnboardingProgress"]>) {
		return this.user.captureOnboardingProgress(...a)
	}
	public identifyAccount(...a: Parameters<UserTelemetry["identifyAccount"]>) {
		return this.user.identifyAccount(...a)
	}
	// Task
	public captureTaskCreated(...a: Parameters<TaskTelemetry["captureTaskCreated"]>) {
		return this.task.captureTaskCreated(...a)
	}
	public captureTaskRestarted(...a: Parameters<TaskTelemetry["captureTaskRestarted"]>) {
		return this.task.captureTaskRestarted(...a)
	}
	public captureTaskCompleted(...a: Parameters<TaskTelemetry["captureTaskCompleted"]>) {
		return this.task.captureTaskCompleted(...a)
	}
	public captureConversationTurnEvent(...a: Parameters<TaskTelemetry["captureConversationTurnEvent"]>) {
		return this.task.captureConversationTurnEvent(...a)
	}
	public captureTokenUsage(...a: Parameters<TaskTelemetry["captureTokenUsage"]>) {
		return this.task.captureTokenUsage(...a)
	}
	public captureModeSwitch(...a: Parameters<TaskTelemetry["captureModeSwitch"]>) {
		return this.task.captureModeSwitch(...a)
	}
	public captureSummarizeTask(...a: Parameters<TaskTelemetry["captureSummarizeTask"]>) {
		return this.task.captureSummarizeTask(...a)
	}
	public captureTaskFeedback(...a: Parameters<TaskTelemetry["captureTaskFeedback"]>) {
		return this.task.captureTaskFeedback(...a)
	}
	public captureTaskInitialization(...a: Parameters<TaskTelemetry["captureTaskInitialization"]>) {
		return this.task.captureTaskInitialization(...a)
	}
	public captureOptionSelected(...a: Parameters<TaskTelemetry["captureOptionSelected"]>) {
		return this.task.captureOptionSelected(...a)
	}
	public captureOptionsIgnored(...a: Parameters<TaskTelemetry["captureOptionsIgnored"]>) {
		return this.task.captureOptionsIgnored(...a)
	}
	public captureSlashCommandUsed(...a: Parameters<TaskTelemetry["captureSlashCommandUsed"]>) {
		return this.task.captureSlashCommandUsed(...a)
	}
	public captureFeatureToggle(...a: Parameters<TaskTelemetry["captureFeatureToggle"]>) {
		return this.task.captureFeatureToggle(...a)
	}
	public captureDiracRuleToggled(...a: Parameters<TaskTelemetry["captureDiracRuleToggled"]>) {
		return this.task.captureDiracRuleToggled(...a)
	}
	public captureAutoCondenseToggle(...a: Parameters<TaskTelemetry["captureAutoCondenseToggle"]>) {
		return this.task.captureAutoCondenseToggle(...a)
	}
	public captureYoloModeToggle(...a: Parameters<TaskTelemetry["captureYoloModeToggle"]>) {
		return this.task.captureYoloModeToggle(...a)
	}
	public captureDiracWebToolsToggle(...a: Parameters<TaskTelemetry["captureDiracWebToolsToggle"]>) {
		return this.task.captureDiracWebToolsToggle(...a)
	}
	// Tool
	public captureToolUsage(...a: Parameters<ToolTelemetry["captureToolUsage"]>) {
		return this.tool.captureToolUsage(...a)
	}
	public captureSkillUsed(...a: Parameters<ToolTelemetry["captureSkillUsed"]>) {
		return this.tool.captureSkillUsed(...a)
	}
	public captureCheckpointUsage(...a: Parameters<ToolTelemetry["captureCheckpointUsage"]>) {
		return this.tool.captureCheckpointUsage(...a)
	}
	public captureProviderApiError(...a: Parameters<ToolTelemetry["captureProviderApiError"]>) {
		return this.tool.captureProviderApiError(...a)
	}
	public captureGeminiApiPerformance(...a: Parameters<ToolTelemetry["captureGeminiApiPerformance"]>) {
		return this.tool.captureGeminiApiPerformance(...a)
	}
	public captureAiOutputAccepted(...a: Parameters<ToolTelemetry["captureAiOutputAccepted"]>) {
		return this.tool.captureAiOutputAccepted(...a)
	}
	public captureAiOutputRejected(...a: Parameters<ToolTelemetry["captureAiOutputRejected"]>) {
		return this.tool.captureAiOutputRejected(...a)
	}
	// UI
	public captureModelSelected(...a: Parameters<UiTelemetry["captureModelSelected"]>) {
		return this.ui.captureModelSelected(...a)
	}
	public captureModelFavoritesUsage(...a: Parameters<UiTelemetry["captureModelFavoritesUsage"]>) {
		return this.ui.captureModelFavoritesUsage(...a)
	}
	public captureButtonClick(...a: Parameters<UiTelemetry["captureButtonClick"]>) {
		return this.ui.captureButtonClick(...a)
	}
	public captureRulesMenuOpened(...a: Parameters<UiTelemetry["captureRulesMenuOpened"]>) {
		return this.ui.captureRulesMenuOpened(...a)
	}
	// Browser
	public captureBrowserToolStart(...a: Parameters<BrowserTelemetry["captureBrowserToolStart"]>) {
		return this.browser.captureBrowserToolStart(...a)
	}
	public captureBrowserToolEnd(...a: Parameters<BrowserTelemetry["captureBrowserToolEnd"]>) {
		return this.browser.captureBrowserToolEnd(...a)
	}
	public captureBrowserError(...a: Parameters<BrowserTelemetry["captureBrowserError"]>) {
		return this.browser.captureBrowserError(...a)
	}
	// Mention
	public captureMentionUsed(...a: Parameters<MentionTelemetry["captureMentionUsed"]>) {
		return this.mention.captureMentionUsed(...a)
	}
	public captureMentionFailed(...a: Parameters<MentionTelemetry["captureMentionFailed"]>) {
		return this.mention.captureMentionFailed(...a)
	}
	public captureMentionSearchResults(...a: Parameters<MentionTelemetry["captureMentionSearchResults"]>) {
		return this.mention.captureMentionSearchResults(...a)
	}
	// Workspace
	public captureWorkspaceInitialized(...a: Parameters<WorkspaceTelemetry["captureWorkspaceInitialized"]>) {
		return this.workspace.captureWorkspaceInitialized(...a)
	}
	public captureWorkspaceInitError(...a: Parameters<WorkspaceTelemetry["captureWorkspaceInitError"]>) {
		return this.workspace.captureWorkspaceInitError(...a)
	}
	public captureMultiRootCheckpoint(...a: Parameters<WorkspaceTelemetry["captureMultiRootCheckpoint"]>) {
		return this.workspace.captureMultiRootCheckpoint(...a)
	}
	public captureWorkspacePathResolved(...a: Parameters<WorkspaceTelemetry["captureWorkspacePathResolved"]>) {
		return this.workspace.captureWorkspacePathResolved(...a)
	}
	public captureWorkspaceSearchPattern(...a: Parameters<WorkspaceTelemetry["captureWorkspaceSearchPattern"]>) {
		return this.workspace.captureWorkspaceSearchPattern(...a)
	}
	public captureWorktreeViewOpened(...a: Parameters<WorkspaceTelemetry["captureWorktreeViewOpened"]>) {
		return this.workspace.captureWorktreeViewOpened(...a)
	}
	public captureWorktreeCreated(...a: Parameters<WorkspaceTelemetry["captureWorktreeCreated"]>) {
		return this.workspace.captureWorktreeCreated(...a)
	}
	public captureWorktreeMergeAttempted(...a: Parameters<WorkspaceTelemetry["captureWorktreeMergeAttempted"]>) {
		return this.workspace.captureWorktreeMergeAttempted(...a)
	}
	// Terminal
	public captureTerminalOutputFailure(...a: Parameters<TerminalTelemetry["captureTerminalOutputFailure"]>) {
		return this.terminal.captureTerminalOutputFailure(...a)
	}
	public captureTerminalUserIntervention(...a: Parameters<TerminalTelemetry["captureTerminalUserIntervention"]>) {
		return this.terminal.captureTerminalUserIntervention(...a)
	}
	public captureTerminalHang(...a: Parameters<TerminalTelemetry["captureTerminalHang"]>) {
		return this.terminal.captureTerminalHang(...a)
	}
	// Subagent
	public captureSubagentToggle(...a: Parameters<SubagentTelemetry["captureSubagentToggle"]>) {
		return this.subagents.captureSubagentToggle(...a)
	}
	public captureSubagentExecution(...a: Parameters<SubagentTelemetry["captureSubagentExecution"]>) {
		return this.subagents.captureSubagentExecution(...a)
	}
	// Hook
	public captureHookCacheAccess(...a: Parameters<HookTelemetry["captureHookCacheAccess"]>) {
		return this.hooks.captureHookCacheAccess(...a)
	}
	public captureHookExecution(...a: Parameters<HookTelemetry["captureHookExecution"]>) {
		return this.hooks.captureHookExecution(...a)
	}
	public captureHookDiscovery(...a: Parameters<HookTelemetry["captureHookDiscovery"]>) {
		return this.hooks.captureHookDiscovery(...a)
	}

	// ── Core infrastructure ──────────────────────────────────────────

	public addProvider(provider: ITelemetryProvider) {
		this.providerManager.addProvider(provider)
	}

	public removeProvider(name: string) {
		this.providerManager.removeProvider(name)
	}

	public async updateTelemetryState(didUserOptIn: boolean): Promise<void> {
		const { isEnabled } = await HostProvider.env.getTelemetrySettings({})
		if (isEnabled !== Setting.DISABLED || !didUserOptIn) return
		void HostProvider.window
			.showMessage({
				type: ShowMessageType.WARNING,
				message:
					"Anonymous Dirac error and usage reporting is enabled, but IDE telemetry is disabled. To enable error and usage reporting for this extension, enable telemetry in IDE settings.",
				options: { items: ["Open Settings"] },
			})
			.then((r: { selectedOption?: string }) => {
				if (r.selectedOption === "Open Settings")
					void HostProvider.window.openSettings({ query: "telemetry.telemetryLevel" })
			})
	}

	public capture(event: { event: string; properties?: TelemetryProperties }): void {
		this.eventEmitter.capture(event)
	}

	public captureRequired(event: string, properties?: TelemetryProperties): void {
		this.eventEmitter.captureRequired(event, properties)
	}

	public isCategoryEnabled(category: TelemetryCategory): boolean {
		return this.categoryGate.isEnabled(category)
	}

	public getProviders(): ITelemetryProvider[] {
		return this.providerManager.getProviders()
	}

	public isEnabled(): boolean {
		return this.providerManager.isEnabled()
	}

	public getSettings() {
		return this.providerManager.getSettings()
	}

	public captureHostEvent(name: string, content: string) {
		this.capture({ event: TelemetryService.EVENTS.HOST.DETECTED, properties: { name, content } })
	}

	public captureGrpcResponseSize(sizeUtf8Bytes: number, service: string, method: string, requestId?: string): void {
		this.grpcResponseCount++
		if (this.grpcResponseCount % 100 !== 0 && !process.env.MOCHA && !process.env.TS_NODE_PROJECT) return
		this.eventEmitter.recordHistogram(
			TelemetryService.METRICS.GRPC.RESPONSE_SIZE_BYTES,
			sizeUtf8Bytes,
			{ service, method, ...(requestId && { request_id: requestId }) },
			"Size of gRPC response messages in bytes",
		)
		if (sizeUtf8Bytes <= 4 * 1024 * 1024) return
		Logger.warn(
			`[TelemetryService] Large gRPC response: ${service}.${method} ` +
				`size=${(sizeUtf8Bytes / (1024 * 1024)).toFixed(1)}MB` +
				(requestId ? ` request_id=${requestId}` : ""),
		)
	}

	public safeCapture(telemetryFn: () => void, context?: string): void {
		try {
			telemetryFn()
		} catch (error) {
			Logger.error(`[Telemetry] Failed to capture telemetry${context ? ` [Context: ${context}]` : ""}:`, error)
		}
	}

	public async dispose(): Promise<void> {
		await this.providerManager.dispose()
	}

	// ── Terminal execution (overloaded — cannot use declare) ─────────

	public captureTerminalExecution(success: boolean, terminalType: "vscode", method: VscodeOutputMethod): void
	public captureTerminalExecution(
		success: boolean,
		terminalType: "standalone",
		method: StandaloneOutputMethod,
		exitCode?: number | null,
	): void
	public captureTerminalExecution(
		success: boolean,
		terminalType: TerminalType,
		method: TerminalOutputMethod,
		exitCode?: number | null,
	): void {
		this.terminal.captureTerminalExecution(success, terminalType, method, exitCode)
	}
}
