import { MergeWorktreeRequest, MergeWorktreeResult } from "@shared/proto/dirac/worktree"
import { listWorktrees } from "@utils/git-worktree"
import { getWorkspacePath } from "@utils/path"
import simpleGit from "simple-git"
import { telemetryService } from "@/services/telemetry"
import { Controller } from ".."

const result = (success: boolean, message: string, extra: Partial<MergeWorktreeResult> = {}): MergeWorktreeResult =>
	MergeWorktreeResult.create({ success, message, hasConflicts: false, conflictingFiles: [], ...extra })

export async function mergeWorktree(_controller: Controller, request: MergeWorktreeRequest): Promise<MergeWorktreeResult> {
	const cwd = await getWorkspacePath()
	const { worktreePath, targetBranch, deleteAfterMerge } = request
	if (!cwd) return result(false, "No workspace folder found")
	if (!worktreePath) return result(false, "Worktree path is required")
	if (!targetBranch) return result(false, "Target branch is required")
	try {
		const { worktrees } = await listWorktrees(cwd)
		const targetPath = worktrees.find((w) => w.branch === targetBranch)?.path
		if (!targetPath)
			return result(
				false,
				`Target branch '${targetBranch}' is not checked out in any worktree. Please checkout the branch first.`,
			)
		const git = simpleGit(targetPath)
		const worktreeGit = simpleGit(worktreePath)
		const sourceBranch = (await worktreeGit.revparse(["--abbrev-ref", "HEAD"]).catch(() => ""))?.trim() || null
		if (!sourceBranch) return result(false, "Failed to get branch name from worktree")
		if (sourceBranch === "HEAD") return result(false, "Cannot merge a detached HEAD worktree", { sourceBranch, targetBranch })
		const branchInfo = { sourceBranch, targetBranch }
		const sourceStatus = await worktreeGit.status().catch(() => null)
		const sourceDirty = sourceStatus && !sourceStatus.isClean()
		if (sourceDirty) return result(false, "Worktree has uncommitted changes. Please commit or stash them first.", branchInfo)
		const targetStatus = await git.status().catch(() => null)
		const targetDirty = targetStatus && !targetStatus.isClean()
		if (targetDirty)
			return result(
				false,
				`Target worktree (${targetBranch}) has uncommitted changes. Please commit or stash them first.`,
				branchInfo,
			)
		// Attempt merge
		try {
			await git.merge([sourceBranch, "--no-edit"])
		} catch (error) {
			const diffResult = await git.diff(["--name-only", "--diff-filter=U"]).catch(() => "")
			const conflicts = diffResult.trim().split("\n").filter(Boolean)
			if (conflicts.length > 0) {
				await git.merge(["--abort"]).catch(() => {})
				telemetryService.captureWorktreeMergeAttempted(false, true, deleteAfterMerge)
				const extra = { hasConflicts: true, conflictingFiles: conflicts, ...branchInfo }
				return result(false, `Merge conflict detected. ${conflicts.length} file(s) have conflicts.`, extra)
			}
			telemetryService.captureWorktreeMergeAttempted(false, false, deleteAfterMerge)
			return result(false, `Merge failed: ${error instanceof Error ? error.message : String(error)}`, branchInfo)
		}
		// Delete worktree if requested
		if (deleteAfterMerge) {
			try {
				await git.raw(["worktree", "remove", worktreePath, "--force"])
			} catch (error) {
				const msg = `failed to delete worktree: ${error instanceof Error ? error.message : String(error)}`
				return result(true, `Merged '${sourceBranch}' into '${targetBranch}' successfully, but ${msg}`, branchInfo)
			}
			await git.deleteLocalBranch(sourceBranch).catch(() => {})
		}
		telemetryService.captureWorktreeMergeAttempted(true, false, deleteAfterMerge)
		const message = deleteAfterMerge
			? `Successfully merged '${sourceBranch}' into '${targetBranch}' and removed worktree`
			: `Successfully merged '${sourceBranch}' into '${targetBranch}'`
		return result(true, message, branchInfo)
	} catch (error) {
		return result(false, `Unexpected error: ${error instanceof Error ? error.message : String(error)}`)
	}
}
