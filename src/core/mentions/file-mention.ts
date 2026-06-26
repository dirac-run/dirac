import { extractTextFromFile } from "@integrations/misc/extract-text"
import { telemetryService } from "@services/telemetry"
import { WorkspaceRoot } from "@shared/multi-root/types"
import fs from "fs/promises"
import { isBinaryFile } from "isbinaryfile"
import * as path from "path"
import { FileContextTracker } from "../context/context-tracking/FileContextTracker"
import type { WorkspaceRootManager } from "../workspace"
import { getFilePathFromMention, getWorkspaceHintFromMention } from "./mention-parsers"

export interface FileMentionContext {
	cwd: string
	fileContextTracker?: FileContextTracker
	workspaceManager?: WorkspaceRootManager
}

type MentionType = "file" | "folder"
type ErrorType = "not_found" | "permission_denied" | "unknown"

interface WorkspaceSearchResult {
	workspaceName: string
	content: string | null
	success: boolean
	error?: string
}

export async function expandFileMention(parsedText: string, mention: string, ctx: FileMentionContext): Promise<string> {
	const mentionPath = getFilePathFromMention(mention)
	const workspaceHint = getWorkspaceHintFromMention(mention)
	const multiRoot = ctx.workspaceManager && ctx.workspaceManager.getRoots().length > 1
	if (multiRoot && !workspaceHint) return expandMultiRootFileMention(parsedText, mention, mentionPath, ctx.workspaceManager!)
	if (multiRoot && workspaceHint) return expandHintedWorkspaceFileMention(parsedText, mention, mentionPath, workspaceHint, ctx)
	return expandSingleRootFileMention(parsedText, mention, mentionPath, ctx)
}

// Parallel search across all workspaces when no workspace hint is provided.
async function expandMultiRootFileMention(
	parsedText: string,
	mention: string,
	mentionPath: string,
	workspaceManager: WorkspaceRootManager,
): Promise<string> {
	const isFolder = mention.endsWith("/")
	const mentionType: MentionType = isFolder ? "folder" : "file"
	const results = await searchAllWorkspaces(mentionPath, workspaceManager.getRoots())
	const successful = results.filter((r) => r.success && r.content)
	if (successful.length === 0) return reportMultiRootNotFound(parsedText, mentionPath, isFolder, mentionType, results)
	if (successful.length === 1) return appendSingleWorkspaceResult(parsedText, mentionPath, isFolder, mentionType, successful[0])
	// Found in multiple workspaces: include all candidates with workspace name.
	for (const r of successful) parsedText += formatContentBlock(mentionPath, isFolder, r.content!, r.workspaceName)
	telemetryService.captureMentionUsed(
		mentionType,
		successful.reduce((sum, r) => sum + (r.content?.length || 0), 0),
	)
	return parsedText
}

function reportMultiRootNotFound(
	parsedText: string,
	mentionPath: string,
	isFolder: boolean,
	mentionType: MentionType,
	results: WorkspaceSearchResult[],
): string {
	const errorMsg = `File not found in any workspace. Searched: ${results.map((r) => r.workspaceName).join(", ")}`
	telemetryService.captureMentionFailed(mentionType, "not_found", errorMsg)
	return `${parsedText}${formatErrorBlock(mentionPath, isFolder, errorMsg)}`
}

async function appendSingleWorkspaceResult(
	parsedText: string,
	mentionPath: string,
	isFolder: boolean,
	mentionType: MentionType,
	r: WorkspaceSearchResult,
): Promise<string> {
	telemetryService.captureMentionUsed(mentionType, r.content!.length)
	return `${parsedText}${formatContentBlock(mentionPath, isFolder, r.content!, r.workspaceName)}`
}

// Search only in the workspace named by the hint.
async function expandHintedWorkspaceFileMention(
	parsedText: string,
	mention: string,
	mentionPath: string,
	workspaceHint: string,
	ctx: FileMentionContext,
): Promise<string> {
	const isFolder = mention.endsWith("/")
	const mentionType: MentionType = isFolder ? "folder" : "file"
	const targetRoot = ctx.workspaceManager!.getRootByName(workspaceHint)
	if (!targetRoot) {
		const errorMsg = `Workspace '${workspaceHint}' not found`
		telemetryService.captureMentionFailed(mentionType, "not_found", errorMsg)
		return `${parsedText}${formatErrorBlock(mentionPath, isFolder, errorMsg, workspaceHint)}`
	}
	try {
		const content = await getFileOrFolderContent(mentionPath, targetRoot.path)
		await trackFileContextIfFile(ctx, mentionPath, isFolder)
		telemetryService.captureMentionUsed(mentionType, content.length)
		return `${parsedText}${formatContentBlock(mentionPath, isFolder, content, workspaceHint)}`
	} catch (error) {
		telemetryService.captureMentionFailed(mentionType, classifyError(error.message), error.message)
		return `${parsedText}${formatErrorBlock(mentionPath, isFolder, error.message, workspaceHint)}`
	}
}

// Legacy single-workspace mode.
async function expandSingleRootFileMention(
	parsedText: string,
	mention: string,
	mentionPath: string,
	ctx: FileMentionContext,
): Promise<string> {
	const isFolder = mention.endsWith("/")
	const mentionType: MentionType = isFolder ? "folder" : "file"
	try {
		const content = await getFileOrFolderContent(mentionPath, ctx.cwd)
		await trackFileContextIfFile(ctx, mentionPath, isFolder)
		telemetryService.captureMentionUsed(mentionType, content.length)
		return `${parsedText}${formatContentBlock(mentionPath, isFolder, content)}`
	} catch (error) {
		telemetryService.captureMentionFailed(mentionType, classifyError(error.message), error.message)
		return `${parsedText}${formatErrorBlock(mentionPath, isFolder, error.message)}`
	}
}

async function searchAllWorkspaces(mentionPath: string, roots: WorkspaceRoot[]): Promise<WorkspaceSearchResult[]> {
	return Promise.all(
		roots.map(async (root) => {
			const workspaceName = root.name || path.basename(root.path)
			try {
				return { workspaceName, content: await getFileOrFolderContent(mentionPath, root.path), success: true }
			} catch (error) {
				return { workspaceName, content: null, success: false, error: error.message }
			}
		}),
	)
}

async function trackFileContextIfFile(ctx: FileMentionContext, mentionPath: string, isFolder: boolean): Promise<void> {
	if (!isFolder && ctx.fileContextTracker) await ctx.fileContextTracker.trackFileContext(mentionPath, "file_mentioned")
}

function formatContentBlock(mentionPath: string, isFolder: boolean, content: string, workspaceName?: string): string {
	const tag = isFolder ? "folder_content" : "file_content"
	const ws = workspaceName ? ` workspace="${workspaceName}"` : ""
	return `\n\n<${tag} path="${mentionPath}"${ws}>\n${content}\n</${tag}>`
}

function formatErrorBlock(mentionPath: string, isFolder: boolean, errorMsg: string, workspaceName?: string): string {
	return formatContentBlock(mentionPath, isFolder, `Error fetching content: ${errorMsg}`, workspaceName)
}

function classifyError(message: string): ErrorType {
	if (message.includes("ENOENT") || message.includes("Failed to access")) return "not_found"
	if (message.includes("EACCES") || message.includes("permission")) return "permission_denied"
	return "unknown"
}

export async function getFileOrFolderContent(mentionPath: string, cwd: string): Promise<string> {
	const absPath = path.resolve(cwd, mentionPath)
	try {
		const stats = await fs.stat(absPath)
		if (stats.isFile()) return await readFileContent(absPath)
		if (stats.isDirectory()) return await readFolderContent(absPath, mentionPath)
		return `(Failed to read contents of ${mentionPath})`
	} catch (error) {
		throw new Error(`Failed to access path "${mentionPath}": ${error.message}`)
	}
}

async function readFileContent(absPath: string): Promise<string> {
	if (await isBinaryFile(absPath).catch(() => false)) return "(Binary file, unable to display content)"
	return extractTextFromFile(absPath)
}

async function readFolderContent(absPath: string, mentionPath: string): Promise<string> {
	const entries = await fs.readdir(absPath, { withFileTypes: true })
	let folderContent = ""
	const fileContentPromises: Promise<string | undefined>[] = []
	entries.forEach((entry, index) => {
		const linePrefix = index === entries.length - 1 ? "└── " : "├── "
		if (entry.isFile()) {
			folderContent += `${linePrefix}${entry.name}\n`
			fileContentPromises.push(readNestedFile(path.join(mentionPath, entry.name), path.resolve(absPath, entry.name)))
		} else if (entry.isDirectory()) {
			folderContent += `${linePrefix}${entry.name}/\n` // not recursively getting folder contents
		} else {
			folderContent += `${linePrefix}${entry.name}\n`
		}
	})
	const fileContents = (await Promise.all(fileContentPromises)).filter((content): content is string => !!content)
	return `${folderContent}\n${fileContents.join("\n\n")}`.trim()
}

async function readNestedFile(filePath: string, absoluteFilePath: string): Promise<string | undefined> {
	try {
		if (await isBinaryFile(absoluteFilePath).catch(() => false)) return undefined
		const content = await extractTextFromFile(absoluteFilePath)
		return `<file_content path="${filePath.toPosix()}">\n${content}\n</file_content>`
	} catch (_error) {
		return undefined
	}
}
