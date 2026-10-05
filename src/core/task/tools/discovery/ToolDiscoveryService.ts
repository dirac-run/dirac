import * as fs from "fs"
import * as path from "path"
import { CONFIGURABLE_TOOL_EXPOSURE, type DiscoveredTool, type ToolExposure, type ToolSource } from "./DiscoveredTool"
import { UserToolLoader } from "./UserToolLoader"
import type { IDiracTool } from "../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"
import { approvedWorkspaceCode } from "@/core/security/WorkspaceCodeApproval"
import { diracHomeDir } from "@/shared/config/environment"

interface ToolManifest {
	spec: DiracToolSpec
	create: (config?: any) => IDiracTool
	exposure?: ToolExposure
}

interface DualToolManifest extends ToolManifest {
	secondarySpec?: DiracToolSpec
	createSecondary?: (config?: any) => IDiracTool
}

export class ToolDiscoveryService {
	/**
	 * Scan built-in tools via the generated barrel file.
	 * Called once during application initialization.
	 */
	static scanBuiltinTools(): DiscoveredTool[] {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const barrel = require("./builtin-tools")
		const tools: DiscoveredTool[] = []

		for (const [moduleName, mod] of Object.entries(barrel)) {
			const manifest = mod as DualToolManifest

			if (!manifest.spec || !manifest.create) {
				continue
			}

			tools.push({
				id: manifest.spec.id,
				name: manifest.spec.name,
				source: "builtin",
				exposure: manifest.exposure ?? CONFIGURABLE_TOOL_EXPOSURE,
				spec: manifest.spec,
				factory: manifest.create,
				modulePath: `modules/${moduleName}/tool.ts`,
			})

			// Handle modules that expose an optional second built-in tool.
			if (manifest.secondarySpec && manifest.createSecondary) {
				tools.push({
					id: manifest.secondarySpec.id,
					name: manifest.secondarySpec.name,
					source: "builtin",
					exposure: manifest.exposure ?? CONFIGURABLE_TOOL_EXPOSURE,
					spec: manifest.secondarySpec,
					factory: manifest.createSecondary,
					modulePath: `modules/${moduleName}/tool.ts`,
				})
			}
		}

		return tools
	}

	/**
	 * Scan a user tool directory for Dirac-managed tool manifests.
	 * Each subdirectory must contain dirac-tool.json and tool.ts.
	 */
	static async scanUserToolDirectory(dirPath: string, source: ToolSource, toggles: Record<string, boolean> = {}, workspaceRoot?: string): Promise<DiscoveredTool[]> {
		if (!fs.existsSync(dirPath)) {
			return []
		}

		const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
		const tools: DiscoveredTool[] = []

		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue
			}

			const toolDir = path.join(dirPath, entry.name)
			const manifestPath = path.join(toolDir, "dirac-tool.json")
			if (!fs.existsSync(manifestPath)) {
				continue
			}

			const metadata = source === "workspace" ? await UserToolLoader.describe(toolDir, source) : undefined
			if (source === "workspace" && !metadata) continue
			let tool = metadata
			if (source !== "workspace") tool = await UserToolLoader.load(toolDir, source)
			else if (toggles[metadata!.id]) {
				const approved = await approvedWorkspaceCode(workspaceRoot!, metadata!.modulePath, manifestPath, true)
				if (approved) tool = await UserToolLoader.loadWithDiagnostics(toolDir, source, approved).then((result) => result.tool) ?? metadata
			}
			if (tool) {
				tools.push(tool)
			}
		}

		return tools
	}

	static async scanGlobalUserTools(): Promise<DiscoveredTool[]> {
		const globalDir = path.join(diracHomeDir(), "tools")
		return this.scanUserToolDirectory(globalDir, "global")
	}

	static scanWorkspaceTools(workspaceRoot: string, toggles: Record<string, boolean> = {}): Promise<DiscoveredTool[]> {
		const workspaceDir = path.join(workspaceRoot, ".dirac", "tools")
		return this.scanUserToolDirectory(workspaceDir, "workspace", toggles, workspaceRoot)
	}
}
