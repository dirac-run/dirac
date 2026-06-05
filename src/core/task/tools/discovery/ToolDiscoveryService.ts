import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import type { DiscoveredTool, ToolSource } from "./DiscoveredTool"
import { UserToolLoader } from "./UserToolLoader"
import type { IDiracTool } from "../interfaces/IDiracTool"
import type { DiracToolSpec } from "@/shared/tools"

interface ToolManifest {
    spec: DiracToolSpec
    create: (config?: any) => IDiracTool
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
                spec: manifest.spec,
                factory: manifest.create,
                modulePath: `modules/${moduleName}/tool.ts`,
            })

            // Handle dual-export modules (e.g., write_to_file with secondarySpec/createSecondary)
            if (manifest.secondarySpec && manifest.createSecondary) {
                tools.push({
                    id: manifest.secondarySpec.id,
                    name: manifest.secondarySpec.name,
                    source: "builtin",
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
    static async scanUserToolDirectory(
        dirPath: string,
        source: ToolSource,
    ): Promise<DiscoveredTool[]> {
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

            const tool = await UserToolLoader.load(toolDir, source)
            if (tool) {
                tools.push(tool)
            }
        }

        return tools
    }

    static async scanGlobalUserTools(): Promise<DiscoveredTool[]> {
        const globalDir = path.join(
            process.env.DIRAC_DIR || path.join(os.homedir(), ".dirac"),
            "tools",
        )
        return this.scanUserToolDirectory(globalDir, "global")
    }

    static scanWorkspaceTools(workspaceRoot: string): Promise<DiscoveredTool[]> {
        const workspaceDir = path.join(workspaceRoot, ".dirac", "tools")
        return this.scanUserToolDirectory(workspaceDir, "workspace")
    }
}
