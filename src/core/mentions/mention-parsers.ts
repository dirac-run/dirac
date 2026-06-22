import { mentionRegexGlobal } from "@shared/context-mentions"

const GIT_COMMIT_HASH_REGEX = /^[a-f0-9]{7,40}$/

export function isGitCommitHash(mention: string): boolean {
	return GIT_COMMIT_HASH_REGEX.test(mention)
}

// Parse a workspace-prefixed mention (e.g. "workspace:name/path/to/file") into its hint and path.
export function parseWorkspaceMention(mention: string): { workspaceHint: string; path: string } | null {
	const workspaceMatch = mention.match(/^([\w-]+):(.+)$/)
	if (!workspaceMatch || mention.includes("://")) return null
	const [, workspaceHint, pathPart] = workspaceMatch
	const quotedPathMatch = pathPart.match(/^"(.*)"$/)
	return { workspaceHint, path: quotedPathMatch ? quotedPathMatch[1] : pathPart }
}

export function isFileMention(mention: string): boolean {
	return parseWorkspaceMention(mention) !== null || mention.startsWith("/") || mention.startsWith('"/')
}

export function getFilePathFromMention(mention: string): string {
	const workspaceMention = parseWorkspaceMention(mention)
	if (workspaceMention) return workspaceMention.path.startsWith("/") ? workspaceMention.path.slice(1) : workspaceMention.path
	const match = mention.match(/^"(.*)"$/)
	return (match ? match[1] : mention).slice(1)
}

export function getWorkspaceHintFromMention(mention: string): string | undefined {
	return parseWorkspaceMention(mention)?.workspaceHint
}

// First pass: replace each @mention with an inline placeholder, collecting mentions for later expansion.
export function replaceMentionPlaceholders(text: string, mentions: Set<string>): string {
	return text.replace(mentionRegexGlobal, (match, mention) => {
		mentions.add(mention)
		return formatInlinePlaceholder(mention) ?? match
	})
}

function formatInlinePlaceholder(mention: string): string | undefined {
	if (mention.startsWith("http")) return `'${mention}' (see below for site content)`
	if (isFileMention(mention)) return formatFilePlaceholder(mention)
	if (mention === "problems") return `Workspace Problems (see below for diagnostics)`
	if (mention === "terminal") return `Terminal Output (see below for output)`
	if (mention === "git-changes") return `Working directory changes (see below for details)`
	if (isGitCommitHash(mention)) return `Git commit '${mention}' (see below for commit info)`
	return undefined
}

function formatFilePlaceholder(mention: string): string {
	const mentionPath = getFilePathFromMention(mention)
	const workspaceHint = getWorkspaceHintFromMention(mention)
	const label = workspaceHint ? `${workspaceHint}:${mentionPath}` : mentionPath
	const kind = mentionPath.endsWith("/") ? "folder" : "file"
	return `'${label}' (see below for ${kind} content)`
}
