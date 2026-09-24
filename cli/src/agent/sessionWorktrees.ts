import * as fs from "node:fs/promises"
import path from "node:path"
import type * as acp from "@agentclientprotocol/sdk"
import simpleGit from "simple-git"
import type { Controller } from "@/core/controller"
import { createWorktree, deleteWorktree, getGitRootPath } from "@/utils/git-worktree"
import {
	deleteSessionWorktree,
	getSessionWorktree,
	type SessionWorktree,
	setSessionWorktree,
} from "../acp/acp-session-worktrees.js"
import type { DiracAcpSession } from "./public-types.js"

export type WorktreeProvisioningRequest = {
	baseBranch?: string
}

export function worktreeProvisioningRequest(params: acp.NewSessionRequest): WorktreeProvisioningRequest | undefined {
	const requested = params._meta?.["dev.dirac/worktree"]
	if (requested === undefined || requested === false) {
		return undefined
	}
	if (requested === true) {
		return {}
	}
	if (!requested || typeof requested !== "object" || Array.isArray(requested)) {
		throw new Error("dev.dirac/worktree must be true or an object with an optional baseBranch")
	}

	const baseBranch = (requested as Record<string, unknown>).baseBranch
	if (baseBranch !== undefined && typeof baseBranch !== "string") {
		throw new Error("dev.dirac/worktree.baseBranch must be a string")
	}
	return { ...(baseBranch === undefined ? {} : { baseBranch }) }
}

interface SessionWorktreeDeps {
	sessions: Map<string, DiracAcpSession>
	getController(session: DiracAcpSession): Controller | undefined
}

/**
 * Owns Dirac-provisioned git worktrees for ACP sessions: provisioning on
 * session creation, integration back into the target branch, and teardown of
 * the owned worktree on session deletion.
 */
export class SessionWorktreeManager {
	constructor(private readonly deps: SessionWorktreeDeps) {}

	/** Create a branch-backed git worktree owned exclusively by one ACP session. */
	async provisionSessionWorktree(
		sessionId: string,
		cwd: string,
		request: WorktreeProvisioningRequest,
	): Promise<SessionWorktree> {
		const sourceCwd = await getGitRootPath(cwd)
		if (!sourceCwd) {
			throw new Error("dev.dirac/worktree requires cwd to be inside a git repository")
		}

		const git = simpleGit(sourceCwd)
		const checkedOutBranch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim()
		const targetBranch = request.baseBranch ?? (checkedOutBranch === "HEAD" ? undefined : checkedOutBranch)
		const branch = `dirac/acp-${sessionId}`
		const worktreeDirectory = path.join(path.dirname(sourceCwd), ".dirac-worktrees")
		const worktreePath = path.join(worktreeDirectory, `${path.basename(sourceCwd)}-${sessionId}`)
		await fs.mkdir(worktreeDirectory, { recursive: true })

		const result = await createWorktree(sourceCwd, worktreePath, {
			branch,
			baseBranch: targetBranch,
			createNewBranch: true,
		})
		if (!result.success || !result.worktree) {
			throw new Error(result.message)
		}

		const worktree = {
			sourceCwd,
			worktreePath: result.worktree.path,
			branch: result.worktree.branch,
			...(targetBranch ? { targetBranch } : {}),
		}
		setSessionWorktree(sessionId, worktree)
		return worktree
	}

	/** Merge a session-owned worktree branch into its requested target branch. */
	async integrateSessionWorktree(
		sessionId: string,
		targetBranch?: string,
		deleteAfterMerge = true,
	): Promise<{
		sourceBranch: string
		targetBranch: string
		worktreePath: string
	}> {
		const worktree = getSessionWorktree(sessionId)
		if (!worktree) {
			throw new Error(`Session ${sessionId} has no Dirac-provisioned worktree`)
		}

		const activeSession = this.deps.sessions.get(sessionId)
		const activeController = activeSession ? this.deps.getController(activeSession) : undefined
		if (activeController?.task) {
			throw new Error(`Cannot integrate ACP session ${sessionId} while its task is active; close the session first`)
		}

		const branch = targetBranch ?? worktree.targetBranch
		if (!branch) {
			throw new Error("targetBranch is required when the session was created from a detached HEAD")
		}

		const targetGit = simpleGit(worktree.sourceCwd)
		const checkedOutBranch = (await targetGit.revparse(["--abbrev-ref", "HEAD"])).trim()
		if (checkedOutBranch !== branch) {
			throw new Error(`Target branch ${branch} is not checked out at ${worktree.sourceCwd}`)
		}
		if (!(await targetGit.status()).isClean()) {
			throw new Error(`Target branch ${branch} has uncommitted changes`)
		}

		const worktreeGit = simpleGit(worktree.worktreePath)
		if (!(await worktreeGit.status()).isClean()) {
			throw new Error("Session worktree has uncommitted changes; commit or stash them before integrating")
		}

		await targetGit.merge([worktree.branch, "--no-edit"])
		if (deleteAfterMerge) {
			await targetGit.raw(["worktree", "remove", "--force", worktree.worktreePath])
			await targetGit.deleteLocalBranch(worktree.branch)
			deleteSessionWorktree(sessionId)
		}

		return {
			sourceBranch: worktree.branch,
			targetBranch: branch,
			worktreePath: worktree.worktreePath,
		}
	}

	/** Remove the session-owned worktree, if the session has one. */
	async deleteOwnedWorktree(sessionId: string): Promise<void> {
		const worktree = getSessionWorktree(sessionId)
		if (!worktree) return

		const removal = await deleteWorktree(worktree.sourceCwd, worktree.worktreePath, true)
		if (!removal.success) {
			throw new Error(removal.message)
		}
		deleteSessionWorktree(sessionId)
	}
}
