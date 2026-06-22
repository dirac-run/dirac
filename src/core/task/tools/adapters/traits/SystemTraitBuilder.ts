import type { ISystemTrait } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"
import { regexSearchFiles } from "@services/ripgrep"
import { openUrlInBrowser } from "@utils/github-url-utils"
import { ExtensionRegistryInfo } from "@/registry"
import { HostProvider } from "@/hosts/host-provider"
import * as os from "os"

// Builds the system trait — command execution, file search, system info, URL opening.
export function buildSystemTrait(config: TaskConfig, executeCommandFn: (command: string, options?: { timeout?: number; onOutput?: (chunk: string) => void }) => Promise<[boolean, any]>): ISystemTrait {
	return {
		executeCommand: executeCommandFn,
		searchFiles: async (directoryPath, regex, options) => {
			await options?.debugLog?.({
				info: "SurfaceAdapter.searchFiles called",
				cwd: config.cwd,
				directoryPath,
				regex,
				filePattern: options?.filePattern,
				taskId: config.ulid,
				contextLines: options?.contextLines,
				excludeFilePatterns: options?.excludeFilePatterns,
			})
			return await regexSearchFiles(
				config.cwd, directoryPath, regex, options?.filePattern,
				config.services.diracIgnoreController, config.ulid,
				options?.contextLines, options?.excludeFilePatterns,
				options?.debugLog, options?.includeAnchors,
			)
		},
		getSystemInfo: async () => {
			const operatingSystem = os.platform() + " " + os.release()
			const diracVersion = ExtensionRegistryInfo.version
			const host = await HostProvider.env.getHostVersion({})
			const systemInfo = `${host.platform}: ${host.version}, Node.js: ${process.version}, Architecture: ${os.arch()}`
			const apiConfig = config.services.stateManager.getApiConfiguration()
			const provider = config.mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider
			return { operatingSystem, diracVersion, hostInfo: `${host.platform} ${host.version}`, systemInfo, providerAndModel: `${provider} / ${config.api.getModel().id}` }
		},
		openUrl: async (url) => await openUrlInBrowser(url),
	}
}
