import * as vscode from "vscode"
import type { HostCapabilities } from "@/hosts/host-provider-types"
import { ExtensionRegistryInfo } from "@/registry"
import { getLatestTerminalOutput } from "./terminal/get-latest-output"
import { cleanupTestMode } from "./test/TestMode"
import { VsCodeLmHandler } from "./vscode-lm"

/**
 * VS Code implementations of the optional HostProvider capabilities.
 * Keeps every `vscode.*` API call inside the hosts layer — core never imports vscode.
 */
export const vscodeHostCapabilities: HostCapabilities = {
	editorDiagnostics: true,
	architectureViewer: {
		openSelection: async (selection) => {
			const { DiracWebviewProvider } = await import("@core/webview")
			const boards = await DiracWebviewProvider.getInstance().controller.getArchitectureBoards()
			await boards.open(selection)
		},
		prepare: async () => (await import("./architecture-board/ArchitectureBoardPanel")).prepareArchitectureBoard(),
		createPanel: async (options) =>
			(await import("./architecture-board/ArchitectureBoardPanel")).createArchitectureBoardPanel(options),
		openCode: async (absolutePath, line, symbol, assertCurrent) =>
			(await import("./architecture-board/openArchitectureCode")).openArchitectureCode(
				absolutePath,
				line,
				symbol,
				assertCurrent,
			),
	},
	openWalkthrough: async () => {
		await vscode.commands.executeCommand(
			"workbench.action.openWalkthrough",
			`dirac-run.${ExtensionRegistryInfo.name}#DiracWalkthrough`,
		)
	},
	getLatestTerminalOutput,
	listVsCodeLmModels: async () => vscode.lm.selectChatModels({}),
	createVsCodeLmHandler: (options) => new VsCodeLmHandler(options),
	getWorkspaceConfig: (section, key) => vscode.workspace.getConfiguration(section).get(key),
	cleanupTestMode,
}
