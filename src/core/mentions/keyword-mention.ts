import { diagnosticsToProblemsString } from "@integrations/diagnostics"
import { telemetryService } from "@services/telemetry"
import { getCommitInfo, getWorkingState } from "@utils/git"
import { HostProvider } from "@/hosts/host-provider"
import { getLatestTerminalOutput } from "@/hosts/vscode/terminal/get-latest-output"
import { DiagnosticSeverity } from "@/shared/proto/index.dirac"
import { isGitCommitHash } from "./mention-parsers"

export async function expandProblemsMention(parsedText: string): Promise<string> {
	try {
		const problems = await getWorkspaceProblems()
		telemetryService.captureMentionUsed("problems", problems.length)
		return `${parsedText}\n\n<workspace_diagnostics>\n${problems}\n</workspace_diagnostics>`
	} catch (error) {
		telemetryService.captureMentionFailed("problems", "unknown", error.message)
		return `${parsedText}\n\n<workspace_diagnostics>\nError fetching diagnostics: ${error.message}\n</workspace_diagnostics>`
	}
}

export async function expandTerminalMention(parsedText: string): Promise<string> {
	try {
		const terminalOutput = await getLatestTerminalOutput()
		telemetryService.captureMentionUsed("terminal", terminalOutput.length)
		return `${parsedText}\n\n<terminal_output>\n${terminalOutput}\n</terminal_output>`
	} catch (error) {
		telemetryService.captureMentionFailed("terminal", "unknown", error.message)
		return `${parsedText}\n\n<terminal_output>\nError fetching terminal output: ${error.message}\n</terminal_output>`
	}
}

export async function expandGitChangesMention(parsedText: string, cwd: string): Promise<string> {
	try {
		const workingState = await getWorkingState(cwd)
		telemetryService.captureMentionUsed("git-changes", workingState.length)
		return `${parsedText}\n\n<git_working_state>\n${workingState}\n</git_working_state>`
	} catch (error) {
		telemetryService.captureMentionFailed("git-changes", "unknown", error.message)
		return `${parsedText}\n\n<git_working_state>\nError fetching working state: ${error.message}\n</git_working_state>`
	}
}

export async function expandGitCommitMention(parsedText: string, mention: string, cwd: string): Promise<string> {
	try {
		const commitInfo = await getCommitInfo(mention, cwd)
		telemetryService.captureMentionUsed("commit", commitInfo.length)
		return `${parsedText}\n\n<git_commit hash="${mention}">\n${commitInfo}\n</git_commit>`
	} catch (error) {
		telemetryService.captureMentionFailed("commit", "unknown", error.message)
		return `${parsedText}\n\n<git_commit hash="${mention}">\nError fetching commit info: ${error.message}\n</git_commit>`
	}
}

export function isGitCommitMention(mention: string): boolean {
	return isGitCommitHash(mention)
}

async function getWorkspaceProblems(): Promise<string> {
	const response = await HostProvider.workspace.getDiagnostics({ filePaths: [] })
	if (response.fileDiagnostics.length === 0) return "No errors or warnings detected."
	return diagnosticsToProblemsString(response.fileDiagnostics, [
		DiagnosticSeverity.DIAGNOSTIC_ERROR,
		DiagnosticSeverity.DIAGNOSTIC_WARNING,
	])
}
