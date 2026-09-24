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
