import fs from "node:fs"
import path from "node:path"
import { arePathsEqual } from "@/utils/path"
import { DIRAC_CLI_DIR } from "../utils/path.js"

const SESSION_WORKTREES_FILE = path.join(DIRAC_CLI_DIR.data, "acp-session-worktrees.json")

/** Durable ownership record for an ACP session's isolated git worktree. */
export type SessionWorktree = {
	sourceCwd: string
	worktreePath: string
	branch: string
	targetBranch?: string
}

type SessionWorktreesMap = Record<string, SessionWorktree>

function readSessionWorktrees(): SessionWorktreesMap {
	if (!fs.existsSync(SESSION_WORKTREES_FILE)) {
		return {}
	}

	return JSON.parse(fs.readFileSync(SESSION_WORKTREES_FILE, "utf-8")) as SessionWorktreesMap
}

function writeSessionWorktrees(worktrees: SessionWorktreesMap): void {
	fs.mkdirSync(path.dirname(SESSION_WORKTREES_FILE), { recursive: true })
	fs.writeFileSync(SESSION_WORKTREES_FILE, JSON.stringify(worktrees, null, 2))
}

/** Persist the worktree that Dirac provisioned for an ACP session. */
export function setSessionWorktree(sessionId: string, worktree: SessionWorktree): void {
	const worktrees = readSessionWorktrees()
	worktrees[sessionId] = worktree
	writeSessionWorktrees(worktrees)
}

/** Return the isolated worktree owned by a session, if it has one. */
export function getSessionWorktree(sessionId: string): SessionWorktree | undefined {
	return readSessionWorktrees()[sessionId]
}

/** Forget a session's worktree ownership record after the worktree is removed. */
export function deleteSessionWorktree(sessionId: string): void {
	const worktrees = readSessionWorktrees()
	delete worktrees[sessionId]
	writeSessionWorktrees(worktrees)
}

function isSameOrNestedWorktreePath(worktreePath: string, candidatePath: string): boolean {
	if (arePathsEqual(worktreePath, candidatePath)) return true
	const relative = path.relative(path.resolve(worktreePath), path.resolve(candidatePath))
	return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative)
}

/** Return sourceSessionId's worktree record when candidatePath equals or is nested inside it, undefined otherwise. */
export function resolveSharedSessionWorktree(sourceSessionId: string, candidatePath: string): SessionWorktree | undefined {
	const worktrees = readSessionWorktrees()
	const sourceWorktree = worktrees[sourceSessionId]
	if (sourceWorktree && isSameOrNestedWorktreePath(sourceWorktree.worktreePath, candidatePath)) {
		return sourceWorktree
	}
	return undefined
}

/** Return every session ID that currently owns the given worktree path. */
export function getWorktreeOwnerSessionIds(worktreePath: string): string[] {
	return Object.entries(readSessionWorktrees())
		.filter(([, entry]) => arePathsEqual(entry.worktreePath, worktreePath))
		.map(([sessionId]) => sessionId)
}

/** Return true when at least one session other than sessionId still owns worktreePath. */
export function hasOtherSessionWorktreeOwners(sessionId: string, worktreePath: string): boolean {
	return getWorktreeOwnerSessionIds(worktreePath).some((ownerId) => ownerId !== sessionId)
}
