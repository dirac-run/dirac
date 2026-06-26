import * as vscode from "vscode"
import * as path from "path"

import { Logger } from "@/shared/services/Logger"

export interface PythonApi {
	environments: {
		getActiveEnvironmentPath(resource?: vscode.Uri): { path: string }
		getEnvironmentVariables(resource?: vscode.Uri): Promise<{ [key: string]: string | undefined }>
	}
}

/**
 * Gets the Python extension API if available.
 */
export async function getPythonApi(): Promise<PythonApi | undefined> {
	const extension = vscode.extensions.getExtension<any>("ms-python.python")
	if (!extension) {
		return undefined
	}

	if (!extension.isActive) {
		await extension.activate()
	}

	return extension.exports
}

/**
 * Gets the environment variables for the active Python environment in the given resource.
 * If the Python extension's API doesn't provide the expected variables (e.g. PATH with venv),
 * this function will attempt to manually construct them based on the active interpreter path.
 */
export async function getPythonEnvironmentVariables(
	resource?: vscode.Uri,
): Promise<{ [key: string]: string | undefined } | undefined> {
	try {
		const api = await getPythonApi()
		if (!api) {
			return undefined
		}

		// Get variables from Python extension
		const env = await api.environments.getEnvironmentVariables(resource)
		const result: { [key: string]: string | undefined } = { ...env }

		// Supplement with manual venv detection if needed
		const activeEnv = api.environments.getActiveEnvironmentPath(resource)
		if (activeEnv?.path) {
			const interpreterPath = activeEnv.path
			const binPath = path.dirname(interpreterPath)

			// Check if the interpreter is in a virtual environment
			// Common patterns: .venv/bin/python, venv/Scripts/python.exe, etc.
			const isVenv =
				interpreterPath.includes(".venv") ||
				interpreterPath.includes("venv") ||
				interpreterPath.includes("env") ||
				// Also check if VIRTUAL_ENV is already set in the returned env
				result.VIRTUAL_ENV !== undefined

			if (isVenv) {
				// Ensure VIRTUAL_ENV is set (points to the parent of bin)
				if (!result.VIRTUAL_ENV) {
					result.VIRTUAL_ENV = path.dirname(binPath)
				}

				// Ensure binPath is in PATH
				const pathKey = process.platform === "win32" ? "Path" : "PATH"
				const currentPath = result[pathKey] || process.env[pathKey] || ""

				if (!currentPath.includes(binPath)) {
					const separator = process.platform === "win32" ? ";" : ":"
					result[pathKey] = `${binPath}${separator}${currentPath}`
				}
			}
		}

		return result
	} catch (error) {
		Logger.error("Error getting Python environment variables:", error)
		return undefined
	}
}
