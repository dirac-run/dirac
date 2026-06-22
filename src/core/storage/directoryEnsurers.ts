import fs from "fs/promises"
import os from "os"
import * as path from "path"
import { getDocumentsPath } from "./paths"
import { getGlobalStorageDir } from "./globalStorageDir"

// Ensures the per-task directory exists and returns its path.
export async function ensureTaskDirectoryExists(taskId: string): Promise<string> {
	return getGlobalStorageDir("tasks", taskId)
}

// Ensures the global Rules directory exists, falling back to ~/Documents/Dirac/Rules.
export async function ensureRulesDirectoryExists(): Promise<string> {
	const userDocumentsPath = await getDocumentsPath()
	const diracRulesDir = path.join(userDocumentsPath, "Dirac", "Rules")
	try {
		await fs.mkdir(diracRulesDir, { recursive: true })
	} catch (_error) {
		return path.join(os.homedir(), "Documents", "Dirac", "Rules")
	}
	return diracRulesDir
}

// Ensures the global Workflows directory exists, falling back to ~/Documents/Dirac/Workflows.
export async function ensureWorkflowsDirectoryExists(): Promise<string> {
	const userDocumentsPath = await getDocumentsPath()
	const diracWorkflowsDir = path.join(userDocumentsPath, "Dirac", "Workflows")
	try {
		await fs.mkdir(diracWorkflowsDir, { recursive: true })
	} catch (_error) {
		return path.join(os.homedir(), "Documents", "Dirac", "Workflows")
	}
	return diracWorkflowsDir
}

// Ensures the global Hooks directory exists, falling back to ~/Documents/Dirac/Hooks.
export async function ensureHooksDirectoryExists(): Promise<string> {
	const userDocumentsPath = await getDocumentsPath()
	const diracHooksDir = path.join(userDocumentsPath, "Dirac", "Hooks")
	try {
		await fs.mkdir(diracHooksDir, { recursive: true })
	} catch (_error) {
		return path.join(os.homedir(), "Documents", "Dirac", "Hooks")
	}
	return diracHooksDir
}

// Ensures the global settings directory exists and returns its path.
export async function ensureSettingsDirectoryExists(): Promise<string> {
	return getGlobalStorageDir("settings")
}

// Ensures the global state directory exists and returns its path.
export async function ensureStateDirectoryExists(): Promise<string> {
	return getGlobalStorageDir("state")
}

// Ensures the global cache directory exists and returns its path.
export async function ensureCacheDirectoryExists(): Promise<string> {
	return getGlobalStorageDir("cache")
}
