import { showSystemNotification } from "@integrations/notifications"
import { regexSearchFiles } from "@services/ripgrep"
import { openUrlInBrowser } from "@utils/github-url-utils"
import * as os from "os"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { DiracDefaultTool } from "@/shared/tools"
import type { ISystemTrait, SystemCommandResult } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"

// Builds the system trait — command execution, file search, system info, URL opening.
export function buildSystemTrait(
	config: TaskConfig,
	executeCommandFn: (command: string, options?: { timeout?: number }) => Promise<SystemCommandResult>,
): ISystemTrait {
	return {
		executeCommand: async (command, options) => {
			if (config.mode !== "act") return executeCommandFn(command, options)
			return config.callbacks.withMutationAuthorization(DiracDefaultTool.EXECUTE_COMMAND, async () => {
				const result = await executeCommandFn(command, options)
				if (result.backgroundCompletion) config.callbacks.retainMutationUntil(result.backgroundCompletion)
				return result
			})
		},
		searchFiles: async (directoryPath, regex, options) => {
			if (options?.includeAnchors) await config.context.ensureAnchorState()
			return await regexSearchFiles(
				config.cwd,
				directoryPath,
				regex,
				options?.filePattern,
				config.services.diracIgnoreController,
				config.ulid,
				options?.contextLines,
				options?.excludeFilePatterns,
				options?.includeAnchors,
				(absolutePath) => config.context.markAnchorStateDirty(absolutePath),
				options?.signal,
			)
		},
		getSystemInfo: async () => {
			const operatingSystem = os.platform() + " " + os.release()
			const diracVersion = ExtensionRegistryInfo.version
			const host = await HostProvider.env.getHostVersion({})
			const systemInfo = `${host.platform}: ${host.version}, Node.js: ${process.version}, Architecture: ${os.arch()}`
			const provider = config.providerId
			return {
				operatingSystem,
				diracVersion,
				hostInfo: `${host.platform} ${host.version}`,
				systemInfo,
				providerAndModel: `${provider} / ${config.model.id}`,
			}
		},
		openUrl: async (url) => await openUrlInBrowser(url),
		showNotification: (options) => void showSystemNotification(options),
	}
}
