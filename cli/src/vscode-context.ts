/**
 * VSCode context stub for CLI mode
 * Provides mock implementations of VSCode extension context.
 */

import fs, { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import os from "os"
import path from "path"
import { URI } from "vscode-uri"
import { ExtensionRegistryInfo } from "@/registry"
import { DiracExtensionContext, ExtensionKind, ExtensionMode } from "@/shared/dirac"
import type { DiracMemento } from "@/shared/storage/DiracStorage"
import { createStorageContext, type StorageContext } from "@/shared/storage/storage-context"

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** Safely read and parse a JSON file, returning a default value on failure. */
function readJson<T = any>(filePath: string, defaultValue: T = {} as T): T {
	try {
		if (existsSync(filePath)) {
			return JSON.parse(readFileSync(filePath, "utf8"))
		}
	} catch {
		// Return default if file doesn't exist or is invalid
	}
	return defaultValue
}

/** Mock environment variable collection for non-VSCode environments. */
class EnvironmentVariableCollection {
	private variables = new Map<string, { value: string; type: string }>()
	persistent = true
	description = "CLI Environment Variables"

	entries() {
		return this.variables.entries()
	}

	replace(variable: string, value: string) {
		this.variables.set(variable, { value, type: "replace" })
	}

	append(variable: string, value: string) {
		this.variables.set(variable, { value, type: "append" })
	}

	prepend(variable: string, value: string) {
		this.variables.set(variable, { value, type: "prepend" })
	}

	get(variable: string) {
		return this.variables.get(variable)
	}

	forEach(callback: (variable: string, mutator: { value: string; type: string }, collection: this) => void) {
		this.variables.forEach((mutator, variable) => callback(variable, mutator, this))
	}

	delete(variable: string) {
		return this.variables.delete(variable)
	}

	clear() {
		this.variables.clear()
	}

	getScoped(_scope: unknown) {
		return this
	}
}

/**
 * CLI-specific state overrides.
 * These values are always returned regardless of what's stored,
 * and writes to these keys are silently ignored.
 */
const CLI_STATE_OVERRIDES: Record<string, any> = {
	// CLI always uses background execution, not VSCode terminal
	vscodeTerminalExecutionMode: "backgroundExec",
	backgroundEditEnabled: true,
	multiRootEnabled: false,
	enableCheckpointsSetting: false,
	browserSettings: {
		disableToolUse: true,
	},
}

/**
 * Memento adapter that wraps a DiracFileStorage with optional key overrides.
 * Used for globalState where CLI needs to inject hardcoded overrides.
 */
class MementoAdapter implements DiracMemento {
	constructor(
		private readonly store: DiracMemento,
		private readonly overrides: Record<string, any> = {},
	) {}

	get<T>(key: string): T | undefined
	get<T>(key: string, defaultValue: T): T
	get<T>(key: string, defaultValue?: T): T | undefined {
		if (key in this.overrides) {
			return this.overrides[key] as T
		}
		const value = this.store.get<T>(key)
		return value !== undefined ? value : defaultValue
	}

	update(key: string, value: any): Thenable<void> {
		return this.setBatch({ [key]: value })
	}

	keys(): readonly string[] {
		return this.store.keys()
	}

	setBatch(entries: Record<string, any>): Thenable<void> {
		// Filter out overridden keys and delegate to underlying store
		const filteredEntries: Record<string, any> = {}
		for (const [key, value] of Object.entries(entries)) {
			if (!(key in this.overrides)) {
				filteredEntries[key] = value
			}
		}
		this.store.setBatch(filteredEntries)
		return Promise.resolve()
	}

	setKeysForSync(_keys: readonly string[]): void {
		// No-op for CLI
	}
}

export interface CliContextConfig {
	diracDir?: string
	/** The workspace directory being worked in (used to compute workspace storage hash) */
	workspaceDir?: string
}

export interface CliContextResult {
	extensionContext: DiracExtensionContext
	storageContext: StorageContext
	DATA_DIR: string
	EXTENSION_DIR: string
	WORKSPACE_STORAGE_DIR: string
}

/**
 * Initialize the VSCode-like context for CLI mode.
 *
 * Creates a shared StorageContext (the single source of truth for all storage)
 * and wraps it in a DiracExtensionContext shell for legacy APIs that still
 * expect the VSCode ExtensionContext shape.
 */
export function initializeCliContext(config: CliContextConfig = {}): CliContextResult {
	const DIRAC_DIR = config.diracDir || process.env.DIRAC_DIR || path.join(os.homedir(), ".dirac")

	// Create the shared StorageContext — this owns all DiracFileStorage instances.
	// CLI, JetBrains, and VSCode all share this same file-backed implementation.
	let storageContext = createStorageContext({
		diracDir: DIRAC_DIR,
		workspacePath: config.workspaceDir || process.cwd(),
		workspaceStorageDir: process.env.WORKSPACE_STORAGE_DIR || undefined,
	})
	storageContext = {
		...storageContext,
		// Storage — delegates to storageContext stores (with CLI overrides for globalState)
		globalState: new MementoAdapter(storageContext.globalState, CLI_STATE_OVERRIDES),
	}

	const DATA_DIR = storageContext.dataDir
	const WORKSPACE_STORAGE_DIR = storageContext.workspaceStoragePath

	// For CLI, extension dir is the package root (one level up from dist/)
	let EXTENSION_DIR = path.resolve(__dirname, "..")

	// If we're running from a bundled CLI, __dirname might be inside dist/
	// and we want to make sure we can find the source code.
	if (process.env.IS_CLI === "true" && !fs.existsSync(path.join(EXTENSION_DIR, "package.json"))) {
		// Try to find the repo root or the directory containing 'dist/source'
		if (fs.existsSync(path.join(__dirname, "source"))) {
			EXTENSION_DIR = __dirname
		}
	}
	const EXTENSION_MODE = process.env.IS_DEV === "true" ? ExtensionMode.Development : ExtensionMode.Production

	const extension: DiracExtensionContext["extension"] = {
		id: ExtensionRegistryInfo.id,
		isActive: true,
		extensionPath: EXTENSION_DIR,
		extensionUri: URI.file(EXTENSION_DIR),
		packageJSON: readJson(path.join(EXTENSION_DIR, "package.json")),
		exports: undefined,
		activate: async () => {},
		extensionKind: ExtensionKind.UI,
	}

	// Build the DiracExtensionContext shell. All storage delegates to storageContext —
	// there are NO separate DiracFileStorage instances here.
	const extensionContext: DiracExtensionContext = {
		extension: extension,
		extensionMode: EXTENSION_MODE,

		// URIs / paths
		storageUri: URI.file(WORKSPACE_STORAGE_DIR),
		storagePath: WORKSPACE_STORAGE_DIR,
		globalStorageUri: URI.file(DATA_DIR),
		globalStoragePath: DATA_DIR,
		logUri: URI.file(DATA_DIR),
		logPath: DATA_DIR,
		extensionUri: URI.file(EXTENSION_DIR),
		extensionPath: EXTENSION_DIR,
		asAbsolutePath: (relPath: string) => path.join(EXTENSION_DIR, relPath),

		subscriptions: [],
		environmentVariableCollection: new EnvironmentVariableCollection() as any,
	}

	return {
		extensionContext,
		storageContext,
		DATA_DIR,
		EXTENSION_DIR,
		WORKSPACE_STORAGE_DIR,
	}
}
