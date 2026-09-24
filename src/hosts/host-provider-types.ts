import {
	DiffServiceClientInterface,
	EnvServiceClientInterface,
	WindowServiceClientInterface,
	WorkspaceServiceClientInterface,
} from "@generated/hosts/host-bridge-client-types"
import type { ApiHandler, CommonApiHandlerOptions } from "@/core/api"
import type { VsCodeNativeModel } from "@/shared/proto-conversions/models/vscode-lm-models-conversion"

/**
 * Interface for host bridge client providers
 */
export interface HostBridgeClientProvider {
	workspaceClient: WorkspaceServiceClientInterface
	envClient: EnvServiceClientInterface
	windowClient: WindowServiceClientInterface
	diffClient: DiffServiceClientInterface
}

/**
 * Options accepted by {@link HostCapabilities.createVsCodeLmHandler}.
 * Mirrors the vscode-lm provider's own options without importing the provider.
 */
export type VsCodeLmHandlerFactoryOptions = CommonApiHandlerOptions & { vsCodeLmModelSelector?: unknown }

/**
 * Optional host-only capabilities that core code consumes through HostProvider.
 * Hosts that cannot provide a capability leave it undefined; callers must
 * handle absence (typically by degrading or throwing a descriptive error).
 */
export interface HostCapabilities {
	/** Opens the product walkthrough UI (VS Code only). */
	openWalkthrough?: () => Promise<void>
	/** Reads the visible contents of the active terminal, when the host exposes them. */
	getLatestTerminalOutput?: () => Promise<string>
	/** Lists chat models offered by the host's built-in language-model API (VS Code `vscode.lm`). */
	listVsCodeLmModels?: () => Promise<VsCodeNativeModel[]>
	/** Builds the vscode-lm API handler — only the VS Code host can create it. */
	createVsCodeLmHandler?: (options: VsCodeLmHandlerFactoryOptions) => ApiHandler
	/** Reads a host workspace-configuration value (VS Code `workspace.getConfiguration`). */
	getWorkspaceConfig?: (section: string, key: string) => unknown
	/** Disposes host-side e2e test-mode watchers; no-op where test mode cannot exist. */
	cleanupTestMode?: () => void
}

/**
 * Callback interface for streaming requests
 */
export interface StreamingCallbacks<T = any> {
	onResponse: (response: T) => void
	onError?: (error: Error) => void
	onComplete?: () => void
}
