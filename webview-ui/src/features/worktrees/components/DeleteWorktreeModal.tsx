import { VSCodeButton, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { AlertTriangle, Loader2, X } from "lucide-react"
import { memo, useCallback, useEffect, useState } from "react"
import { Button } from "@/shared/ui/button"

interface DeleteWorktreeModalProps {
	open: boolean
	onClose: () => void
	onConfirm: (deleteBranch: boolean) => Promise<void>
	worktreePath: string
	branchName: string
}

const DeleteWorktreeModal = ({ open, onClose, onConfirm, worktreePath, branchName }: DeleteWorktreeModalProps) => {
	const [isDeleting, setIsDeleting] = useState(false)
	const [deleteBranch, setDeleteBranch] = useState(false)
	const [deleteError, setDeleteError] = useState<string | null>(null)

	const closeModal = useCallback(() => {
		if (!isDeleting) onClose()
	}, [isDeleting, onClose])

	useEffect(() => {
		if (!open) {
			setDeleteBranch(false)
			setDeleteError(null)
			setIsDeleting(false)
		}
	}, [open])

	useEffect(() => {
		if (!open) return
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !isDeleting) closeModal()
		}
		document.addEventListener("keydown", onKeyDown)
		return () => document.removeEventListener("keydown", onKeyDown)
	}, [closeModal, isDeleting, open])

	const handleDelete = useCallback(async () => {
		if (isDeleting) return
		setIsDeleting(true)
		setDeleteError(null)
		try {
			await onConfirm(deleteBranch)
			onClose()
		} catch (error) {
			setDeleteError(error instanceof Error ? error.message : "Failed to delete worktree")
		} finally {
			setIsDeleting(false)
		}
	}, [deleteBranch, isDeleting, onClose, onConfirm])

	if (!open) return null

	return (
		<div
			aria-labelledby="delete-worktree-title"
			aria-modal="true"
			className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
			onClick={(event) => event.target === event.currentTarget && closeModal()}
			role="alertdialog">
			<div className="bg-[var(--vscode-editor-background)] border border-[var(--vscode-panel-border)] rounded-lg p-5 w-[400px] max-w-[90vw] relative">
				<button
					aria-label="Close delete worktree dialog"
					className="absolute top-3 right-3 p-1 rounded hover:bg-[var(--vscode-toolbar-hoverBackground)] text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] cursor-pointer disabled:opacity-50"
					disabled={isDeleting}
					onClick={closeModal}
					type="button">
					<X className="w-4 h-4" />
				</button>
				<div className="flex items-center gap-2 mb-3 pr-6">
					<AlertTriangle className="w-5 h-5 text-[var(--vscode-errorForeground)]" />
					<h4 className="m-0" id="delete-worktree-title">
						Delete Worktree
					</h4>
				</div>
				<p className="text-sm text-[var(--vscode-descriptionForeground)] mt-0 mb-3">
					This will delete the worktree directory at{" "}
					<span className="font-semibold text-[var(--vscode-foreground)] break-all">{worktreePath}</span>
				</p>
				<label className="flex items-center gap-2 cursor-pointer mb-3">
					<VSCodeCheckbox
						checked={deleteBranch}
						disabled={isDeleting || !branchName}
						onChange={(event) => setDeleteBranch((event.target as HTMLInputElement).checked)}
					/>
					<span className="text-sm">
						Also delete branch <span className="font-semibold">{branchName || "(detached HEAD)"}</span>
					</span>
				</label>
				{deleteBranch && (
					<p className="text-sm text-[var(--vscode-inputValidation-warningForeground)] mt-0 mb-3">
						Warning: Unpushed commits on this branch will be lost.
					</p>
				)}
				{deleteError && (
					<div
						aria-live="polite"
						className="mb-3 flex items-start gap-2 rounded border border-[var(--vscode-inputValidation-errorBorder)] bg-[var(--vscode-inputValidation-errorBackground)] p-3">
						<AlertTriangle className="w-4 h-4 shrink-0 text-[var(--vscode-errorForeground)]" />
						<p className="m-0 text-sm text-[var(--vscode-errorForeground)]">{deleteError}</p>
					</div>
				)}
				<div className="flex justify-end gap-2">
					<VSCodeButton appearance="secondary" disabled={isDeleting} onClick={closeModal}>
						Cancel
					</VSCodeButton>
					<Button disabled={isDeleting} onClick={handleDelete} variant="danger">
						{isDeleting ? (
							<>
								<Loader2 className="w-4 h-4 mr-1 animate-spin" />
								Deleting...
							</>
						) : (
							"Delete"
						)}
					</Button>
				</div>
			</div>
		</div>
	)
}

export default memo(DeleteWorktreeModal)
