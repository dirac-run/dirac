import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { pathToFileURL } from "url"
import * as ts from "typescript"
import type { DiracToolSpec } from "@/shared/tools"
import { Logger } from "@/shared/services/Logger"
import type { IDiracTool } from "../interfaces/IDiracTool"
import type { DiscoveredTool, ToolSource } from "./DiscoveredTool"

export interface UserToolLoadResult {
	tool?: DiscoveredTool
	error?: string
}

const LOADER_VERSION = "user-tool-loader-v1"
const TOOL_ID_PATTERN = /^[a-z][a-z0-9_]*$/

interface UserToolManifest {
	schemaVersion: number
	id: string
	name: string
	scope: "global" | "workspace" | "task"
	entry: "tool.ts"
	createdBy: "dirac"
	createdAt?: string
}

interface UserToolModule {
	spec?: DiracToolSpec
	create?: (config?: any) => IDiracTool
}

export class UserToolLoader {
	static async load(toolDir: string, source: ToolSource): Promise<DiscoveredTool | undefined> {
		const result = await this.loadWithDiagnostics(toolDir, source)
		return result.tool
	}

	static async loadWithDiagnostics(toolDir: string, source: ToolSource): Promise<UserToolLoadResult> {
		try {
			const manifest = await this.readManifest(toolDir, source)

			const sourcePath = path.join(toolDir, manifest.entry)
			const sourceCode = await fs.readFile(sourcePath, "utf8")
			const sourceHash = this.hashToolSource(sourcePath, sourceCode)
			const compiledPath = await this.compileTool(manifest.id, sourceCode, sourceHash)

			let mod: Required<UserToolModule>
			try {
				mod = await this.importCompiledTool(compiledPath)
			} catch (importError) {
				if (importError instanceof SyntaxError) {
					try {
						const compiledContent = await fs.readFile(compiledPath, "utf8")
						const nonAscii = [...compiledContent].filter((c) => c.charCodeAt(0) > 127)
						Logger.warn(`[UserToolLoader] SyntaxError importing compiled tool. Non-ASCII chars: ${nonAscii.length}`)
						if (nonAscii.length > 0) {
							Logger.warn(`[UserToolLoader] Non-ASCII codepoints: ${nonAscii.map((c) => `U+${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(", ")}`)
						}
						Logger.verbose(`[UserToolLoader] Compiled output (first 500 chars):\n${compiledContent.substring(0, 500)}`)
					} catch {
						// Best-effort logging; swallow if we can't read the file
					}
				}
				throw importError
			}

			this.validateModule(manifest, mod)

			return {
				tool: {
					id: manifest.id,
					name: manifest.name,
					source,
					spec: mod.spec,
					factory: mod.create,
					modulePath: sourcePath,
					sourceHash,
				},
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			Logger.warn(`[UserToolLoader] Skipping invalid user tool at '${toolDir}'.`, error)
			return { error: message }
		}
	}

	private static async readManifest(toolDir: string, source: ToolSource): Promise<UserToolManifest> {
		const manifestPath = path.join(toolDir, "dirac-tool.json")
		const raw = await fs.readFile(manifestPath, "utf8")
		const parsed = JSON.parse(raw) as Partial<UserToolManifest>

		if (!parsed.schemaVersion || typeof parsed.schemaVersion !== "number" || parsed.schemaVersion < 1) {
			throw new Error("Unsupported or missing schemaVersion. Expected 1.")
		}
		if (parsed.schemaVersion > 1) {
			Logger.warn(`[UserToolLoader] Tool at '${toolDir}' declares schemaVersion ${parsed.schemaVersion}. Expected 1. Proceeding with caution.`)
		}
		if (parsed.createdBy !== "dirac") {
			throw new Error("User tool manifest must include createdBy: 'dirac'.")
		}
		if (parsed.entry !== "tool.ts") {
			throw new Error("User tool manifest entry must be 'tool.ts'.")
		}
		const validScopes: Record<string, string[]> = {
			global: ["global"],
			workspace: ["workspace"],
			task: ["task"]
		}
		if (!validScopes[parsed.scope!]?.includes(source)) {
			throw new Error(`Manifest scope '${parsed.scope}' does not match discovered source '${source}'.`)
		}
		if (!this.isValidToolName(parsed.id)) {
			throw new Error("Manifest id must be a snake_case identifier.")
		}
		if (!this.isValidToolName(parsed.name)) {
			throw new Error("Manifest name must be a snake_case identifier.")
		}

		return parsed as UserToolManifest
	}

	private static async compileTool(toolId: string, sourceCode: string, sourceHash: string): Promise<string> {
		const hash = sourceHash
		const cacheDir = path.join(this.getDiracHomePath(), "cache", "tools")
		await fs.mkdir(cacheDir, { recursive: true })

		const compiledPath = path.join(cacheDir, `${toolId}-${hash}.mjs`)
		try {
			await fs.access(compiledPath)
			return compiledPath
		} catch {
			// Compile below when the content-addressed output is missing.
		}

		const result = ts.transpileModule(sourceCode, {
			compilerOptions: {
				module: ts.ModuleKind.ESNext,
				target: ts.ScriptTarget.ES2020,
				moduleResolution: ts.ModuleResolutionKind.Node10,
			},
			fileName: `${toolId}.ts`,
			reportDiagnostics: true,
		})

		// Reject output that would produce invalid JavaScript
		const diagnostics = result.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error) ?? []
		if (diagnostics.length > 0) {
			const messages = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
			throw new Error(`TypeScript transpile produced ${diagnostics.length} error(s): ${messages.join("; ")}`)
		}
		await fs.writeFile(compiledPath, result.outputText, "utf8")

		// Evict stale cache entries for this tool (different hash, same id)
		const stalePrefix = `${toolId}-`
		const cacheEntries = await fs.readdir(cacheDir)
		for (const entry of cacheEntries) {
			if (entry.startsWith(stalePrefix) && entry.endsWith(".mjs") && entry !== path.basename(compiledPath)) {
				await fs.unlink(path.join(cacheDir, entry)).catch(() => { })
			}
		}
		return compiledPath
	}

	private static async importCompiledTool(compiledPath: string): Promise<Required<UserToolModule>> {
		const dynamicImport = new Function("specifier", "return import(specifier)") as (
			specifier: string,
		) => Promise<UserToolModule>
		const mod = await dynamicImport(pathToFileURL(compiledPath).href)
		if (!mod.spec || typeof mod.spec !== "object") {
			throw new Error("User tool module must export object 'spec'.")
		}
		if (typeof mod.create !== "function") {
			throw new Error("User tool module must export function 'create'.")
		}
		return mod as Required<UserToolModule>
	}

	private static validateModule(manifest: UserToolManifest, mod: Required<UserToolModule>): void {
		if (mod.spec.id !== manifest.id) {
			throw new Error(`Manifest id '${manifest.id}' does not match spec id '${mod.spec.id}'.`)
		}
		if (mod.spec.name !== manifest.name) {
			throw new Error(`Manifest name '${manifest.name}' does not match spec name '${mod.spec.name}'.`)
		}
		if (typeof mod.spec.description !== "string" || mod.spec.description.trim().length === 0) {
			throw new Error("User tool spec must include a non-empty description.")
		}
	}

	private static hashToolSource(sourcePath: string, sourceCode: string): string {
		return crypto
			.createHash("sha256")
			.update(LOADER_VERSION)
			.update("\0")
			.update(sourcePath)
			.update("\0")
			.update(sourceCode)
			.digest("hex")
			.slice(0, 16)
	}

	private static isValidToolName(value: unknown): value is string {
		return typeof value === "string" && TOOL_ID_PATTERN.test(value)
	}

	/**
	 * Remove compiled cache files whose toolId is not in the active set.
	 * Called after tool discovery to clean up files for deleted tools.
	 */
	static async purgeStaleCache(activeToolIds: string[]): Promise<void> {
		const cacheDir = path.join(this.getDiracHomePath(), "cache", "tools")
		let entries: string[]
		try {
			entries = await fs.readdir(cacheDir)
		} catch {
			return // Cache dir doesn't exist yet
		}

		const activeSet = new Set(activeToolIds)
		for (const entry of entries) {
			if (!entry.endsWith(".mjs")) continue
			// Filename format: <toolId>-<hash>.mjs — toolId cannot contain hyphens (enforced by TOOL_ID_PATTERN)
			const dashIndex = entry.lastIndexOf("-")
			const toolId = dashIndex > 0 ? entry.slice(0, dashIndex) : entry.replace(/\.mjs$/, "")
			if (!activeSet.has(toolId)) {
				await fs.unlink(path.join(cacheDir, entry)).catch(() => { })
			}
		}
	}

	private static getDiracHomePath(): string {
		return process.env.DIRAC_DIR || path.join(os.homedir(), ".dirac")
	}
}
