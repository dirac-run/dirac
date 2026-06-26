import { openFile } from "@integrations/misc/open-file"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { openExternal } from "@utils/env"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { isDirectory } from "@/utils/fs"
import { getCwd } from "@/utils/path"
import { FileContextTracker } from "../context/context-tracking/FileContextTracker"
import type { WorkspaceRootManager } from "../workspace"
import { expandFileMention, type FileMentionContext } from "./file-mention"
import {
	expandGitChangesMention,
	expandGitCommitMention,
	expandProblemsMention,
	expandTerminalMention,
	isGitCommitMention,
} from "./keyword-mention"
import { getFilePathFromMention, isFileMention, replaceMentionPlaceholders } from "./mention-parsers"
import { expandUrlMention, findUrlMention, tryCloseBrowser, tryLaunchBrowser } from "./url-mention"

export async function openMention(mention?: string): Promise<void> {
	if (!mention) return
	const cwd = await getCwd()
	if (!cwd) return
	if (isFileMention(mention)) {
		const absPath = path.resolve(cwd, getFilePathFromMention(mention))
		if (await isDirectory(absPath)) await HostProvider.workspace.openInFileExplorerPanel({ path: absPath })
		else openFile(absPath)
	} else if (mention === "problems") await HostProvider.workspace.openProblemsPanel({})
	else if (mention === "terminal") await HostProvider.workspace.openTerminalPanel({})
	else if (mention.startsWith("http")) await openExternal(mention)
}

export async function getFileMentionFromPath(filePath: string) {
	const cwd = await getCwd()
	if (!cwd) return "@/" + filePath
	return "@/" + path.relative(cwd, filePath)
}

interface MentionExpansionContext {
	cwd: string
	urlContentFetcher: UrlContentFetcher
	launchBrowserError?: Error
	fileContextTracker?: FileContextTracker
	workspaceManager?: WorkspaceRootManager
}

export async function parseMentions(
	text: string,
	cwd: string,
	urlContentFetcher: UrlContentFetcher,
	fileContextTracker?: FileContextTracker,
	workspaceManager?: WorkspaceRootManager,
): Promise<string> {
	const mentions = new Set<string>()
	let parsedText = replaceMentionPlaceholders(text, mentions)
	const urlMention = findUrlMention(mentions)
	const launchBrowserError = urlMention ? await tryLaunchBrowser(urlMention, urlContentFetcher) : undefined
	const ctx: MentionExpansionContext = { cwd, urlContentFetcher, launchBrowserError, fileContextTracker, workspaceManager }
	for (const mention of mentions) parsedText = await expandMention(parsedText, mention, ctx)
	if (urlMention) await tryCloseBrowser(urlContentFetcher)
	return parsedText
}

// Dispatch a single mention to its type-specific expander. Guard clauses keep this flat (depth 1).
async function expandMention(parsedText: string, mention: string, ctx: MentionExpansionContext): Promise<string> {
	// Safety guard: bare "/" would resolve to the workspace root and scan the entire project.
	if (mention === "/") return parsedText
	if (mention.startsWith("http")) return expandUrlMention(parsedText, mention, ctx.urlContentFetcher, ctx.launchBrowserError)
	if (isFileMention(mention)) return expandFileMention(parsedText, mention, toFileContext(ctx))
	if (mention === "problems") return expandProblemsMention(parsedText)
	if (mention === "terminal") return expandTerminalMention(parsedText)
	if (mention === "git-changes") return expandGitChangesMention(parsedText, ctx.cwd)
	if (isGitCommitMention(mention)) return expandGitCommitMention(parsedText, mention, ctx.cwd)
	return parsedText
}

function toFileContext(ctx: MentionExpansionContext): FileMentionContext {
	return { cwd: ctx.cwd, fileContextTracker: ctx.fileContextTracker, workspaceManager: ctx.workspaceManager }
}
