import { execa } from "@packages/execa"
import os from "os"
import * as path from "path"

// Returns the cross-platform Documents path, falling back to ~/Documents.
export async function getDocumentsPath(): Promise<string> {
	const platformPath = process.platform === "win32"
		? await getWindowsDocumentsPath()
		: process.platform === "linux"
			? await getLinuxDocumentsPath()
			: undefined
	return platformPath ?? path.join(os.homedir(), "Documents")
}

// Retrieves the Windows Documents path via PowerShell.
async function getWindowsDocumentsPath(): Promise<string | undefined> {
	try {
		const { stdout: docsPath } = await execa("powershell", [
			"-NoProfile",
			"-Command",
			"[System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::MyDocuments)",
		])
		return docsPath.trim() || undefined
	} catch (_err) {
		return undefined
	}
}

// Retrieves the Linux Documents path via xdg-user-dir.
async function getLinuxDocumentsPath(): Promise<string | undefined> {
	try {
		await execa("which", ["xdg-user-dir"])
		const { stdout } = await execa("xdg-user-dir", ["DOCUMENTS"])
		return stdout.trim() || undefined
	} catch {
		return undefined
	}
}

// Returns the cross-platform path to the Dirac home directory (~/.dirac).
export function getDiracHomePath(): string {
	return path.join(os.homedir(), ".dirac")
}
