import * as path from "node:path"
import type { DiracWebviewProvider } from "@/core/webview"
import { HostProvider } from "@/hosts/host-provider"
import type { DiffViewProvider } from "@/integrations/editor/DiffViewProvider"
import { StandaloneTerminalManager } from "@/integrations/terminal"
import type { DiracExtensionContext } from "@/shared/dirac"
import { log } from "@/standalone/utils"
import { AuthHandler } from "./AuthHandler"
import { ExternalCommentReviewController } from "./ExternalCommentReviewController"
import { ExternalDiffViewProvider } from "./ExternalDiffviewProvider"
import { ExternalDiracWebviewProvider } from "./ExternalWebviewProvider"
import { ExternalHostBridgeClientManager } from "./host-bridge-client-manager"

/** Connects dirac-core to an IDE host implementing the workspace diagnostics RPCs. */
export function initializeExternalHostProvider(
	extensionContext: DiracExtensionContext,
	extensionDir: string,
	dataDir: string,
): void {
	const createWebview = (): DiracWebviewProvider => {
		return new ExternalDiracWebviewProvider(extensionContext)
	}
	const createDiffView = (): DiffViewProvider => {
		return new ExternalDiffViewProvider()
	}
	const createCommentReview = () => new ExternalCommentReviewController()
	const createTerminalManager = () => new StandaloneTerminalManager()
	const getCallbackUrl = (path: string, preferredPort?: number): Promise<string> => {
		return AuthHandler.getInstance().getCallbackUrl(path, preferredPort)
	}
	// dirac-core expects the binaries to be unpacked in the directory where it is running.
	const getBinaryLocation = async (name: string): Promise<string> => path.join(process.cwd(), name)
	const getEnvironmentVariables = async (_cwd: string) => undefined

	HostProvider.initialize(
		"extension",
		createWebview,
		createDiffView,
		createCommentReview,
		createTerminalManager,
		new ExternalHostBridgeClientManager(),
		log,
		getCallbackUrl,
		getBinaryLocation,
		extensionDir,
		dataDir,
		getEnvironmentVariables,
		undefined,
		{ editorDiagnostics: true },
	)
}
