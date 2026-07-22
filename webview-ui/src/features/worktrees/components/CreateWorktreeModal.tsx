import { EmptyRequest } from "@shared/proto/dirac/common"
import { CreateWorktreeRequest, SwitchWorktreeRequest } from "@shared/proto/dirac/worktree"
import { VSCodeButton, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { AlertCircle, AlertTriangle, Loader2, X } from "lucide-react"
import { memo, useCallback, useEffect, useRef, useState } from "react"
import { WorktreeServiceClient } from "@/shared/api/grpc-client"

interface CreateWorktreeModalProps {
	open: boolean
	onClose: () => void
	/** When true, opens the worktree in a new window after creation */
	openAfterCreate?: boolean
	/** Called after successful creation (and opening if openAfterCreate is true) */
	onSuccess?: () => void | Promise<void>
}

const CreateWorktreeModal = ({ open, onClose, openAfterCreate = false, onSuccess }: CreateWorktreeModalProps) => {
	const [newWorktreePath, setNewWorktreePath] = useState("")
	const [newBranchName, setNewBranchName] = useState("")
	const [isCreating, setIsCreating] = useState(false)
	const [createError, setCreateError] = useState<string | null>(null)
	const [createdWorktreePath, setCreatedWorktreePath] = useState<string>()
	const [isLoadingDefaults, setIsLoadingDefaults] = useState(false)
	const [hasWorktreeInclude, setHasWorktreeInclude] = useState<boolean | null>(null)
	const defaultsRequestRef = useRef(0)

	const closeModal = useCallback(() => {
		if (!isCreating) onClose()
	}, [isCreating, onClose])

	useEffect(() => {
		if (!open) {
			defaultsRequestRef.current++
			setNewWorktreePath("")
			setNewBranchName("")
			setCreateError(null)
			setCreatedWorktreePath(undefined)
			setHasWorktreeInclude(null)
			setIsLoadingDefaults(false)
			return
		}

		const requestId = ++defaultsRequestRef.current
		setCreateError(null)
		setIsLoadingDefaults(true)
		Promise.all([
			WorktreeServiceClient.getWorktreeDefaults(EmptyRequest.create({})),
			WorktreeServiceClient.getWorktreeIncludeStatus(EmptyRequest.create({})),
		])
			.then(([defaults, includeStatus]) => {
				if (defaultsRequestRef.current !== requestId) return
				setNewBranchName(defaults.suggestedBranch)
				setNewWorktreePath(defaults.suggestedPath)
				setHasWorktreeInclude(includeStatus.exists)
			})
			.catch((error) => {
				if (defaultsRequestRef.current !== requestId) return
				setCreateError(error instanceof Error ? error.message : "Failed to load worktree defaults")
			})
			.finally(() => {
				if (defaultsRequestRef.current === requestId) setIsLoadingDefaults(false)
			})
	}, [open])

	useEffect(() => {
		if (!open) return
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !isCreating) closeModal()
		}
		document.addEventListener("keydown", onKeyDown)
		return () => document.removeEventListener("keydown", onKeyDown)
	}, [closeModal, isCreating, open])

	const handleCreateWorktree = useCallback(async () => {
		if (isCreating || isLoadingDefaults || createdWorktreePath) return
		const path = newWorktreePath.trim()
		const branch = newBranchName.trim()
		if (!path || !branch) {
			setCreateError("Branch name and folder path are required.")
			return
		}

		setIsCreating(true)
		setCreateError(null)
		let createdPath: string | undefined
		try {
			const result = await WorktreeServiceClient.createWorktree(
				CreateWorktreeRequest.create({ path, branch, createNewBranch: true }),
			)
			if (!result.success) {
				setCreateError(result.message || "Failed to create worktree")
				return
			}

			createdPath = result.worktree?.path || path
			setCreatedWorktreePath(createdPath)
			if (openAfterCreate) {
				if (!result.worktree?.path) throw new Error("the created worktree path was not returned")
				const switchResult = await WorktreeServiceClient.switchWorktree(
					SwitchWorktreeRequest.create({ path: result.worktree.path, newWindow: true }),
				)
				if (!switchResult.success) throw new Error(switchResult.message || "opening the new window failed")
			}
			await onSuccess?.()
			onClose()
		} catch (error) {
			const message = error instanceof Error ? error.message : "a post-create action failed"
			setCreateError(createdPath ? `Worktree was created at ${createdPath}, but ${message}.` : message)
		} finally {
			setIsCreating(false)
		}
	}, [createdWorktreePath, isCreating, isLoadingDefaults, newWorktreePath, newBranchName, openAfterCreate, onSuccess, onClose])

	if (!open) return null

	const title = openAfterCreate ? "New Worktree" : "Create New Worktree"
	const buttonText = openAfterCreate ? "Create & Open" : "Create Worktree"
	const creatingText = openAfterCreate ? "Creating & Opening..." : "Creating..."
	const description = openAfterCreate
		? "This will create a copy of your project on a new branch and open it in a separate window."
		: "This will create a copy of your project on a new branch."
	const canSubmit =
		!createdWorktreePath &&
		newWorktreePath.trim().length > 0 &&
		newBranchName.trim().length > 0 &&
		!isCreating &&
		!isLoadingDefaults

	return (
		<div
			aria-labelledby="create-worktree-title"
			aria-modal="true"
			className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
			onClick={(event) => event.target === event.currentTarget && closeModal()}
			role="dialog">
			<div className="bg-[var(--vscode-editor-background)] border border-[var(--vscode-panel-border)] rounded-lg p-5 w-[450px] max-w-[90vw] relative">
				<button
					aria-label="Close create worktree dialog"
					className="absolute top-3 right-3 p-1 rounded hover:bg-[var(--vscode-toolbar-hoverBackground)] text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] cursor-pointer disabled:opacity-50"
					disabled={isCreating}
					onClick={closeModal}
					type="button">
					<X className="w-4 h-4" />
				</button>
				<h4 className="mt-0 mb-2 pr-6" id="create-worktree-title">
					{title}
				</h4>
				<p className="text-sm text-[var(--vscode-descriptionForeground)] mt-0 mb-4">{description}</p>
				{hasWorktreeInclude === false && (
					<div
						className="flex items-start gap-2 p-2 rounded mb-3"
						style={{ backgroundColor: "var(--vscode-inputValidation-warningBackground)" }}>
						<AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-[var(--vscode-editorWarning-foreground)]" />
						<p className="text-xs text-[var(--vscode-foreground)] m-0">No .worktreeinclude detected.</p>
					</div>
				)}
				<div className="flex flex-col gap-3">
					<div>
						<label className="block text-sm font-medium mb-1" htmlFor="worktree-branch-name">
							Branch Name *
						</label>
						<VSCodeTextField
							autofocus
							className="w-full"
							disabled={isCreating || isLoadingDefaults}
							id="worktree-branch-name"
							onInput={(event) => setNewBranchName((event.target as HTMLInputElement).value)}
							placeholder="feature/my-feature"
							value={newBranchName}
						/>
						<p className="text-xs text-[var(--vscode-descriptionForeground)] mt-1">
							Your new copy will be checked out to this branch.
						</p>
					</div>
					<div>
						<label className="block text-sm font-medium mb-1" htmlFor="worktree-folder-path">
							Folder Path *
						</label>
						<VSCodeTextField
							className="w-full"
							disabled={isCreating || isLoadingDefaults}
							id="worktree-folder-path"
							onInput={(event) => setNewWorktreePath((event.target as HTMLInputElement).value)}
							placeholder="../my-feature-worktree"
							value={newWorktreePath}
						/>
						<p className="text-xs text-[var(--vscode-descriptionForeground)] mt-1">
							Where the project will be copied for the worktree.
						</p>
					</div>
					{createError && (
						<div
							aria-live="polite"
							className="flex items-start gap-2 p-3 rounded bg-[var(--vscode-inputValidation-errorBackground)] border border-[var(--vscode-inputValidation-errorBorder)]">
							<AlertCircle className="w-4 h-4 flex-shrink-0 text-[var(--vscode-errorForeground)] mt-0.5" />
							<p className="text-sm text-[var(--vscode-errorForeground)] m-0">{createError}</p>
						</div>
					)}
					<div className="flex justify-end gap-2">
						<VSCodeButton appearance="secondary" disabled={isCreating} onClick={closeModal}>
							Cancel
						</VSCodeButton>
						<VSCodeButton disabled={!canSubmit} onClick={handleCreateWorktree}>
							{isLoadingDefaults ? (
								<>
									<Loader2 className="w-4 h-4 mr-1 animate-spin" />
									Loading...
								</>
							) : isCreating ? (
								<>
									<Loader2 className="w-4 h-4 mr-1 animate-spin" />
									{creatingText}
								</>
							) : createdWorktreePath ? (
								"Created"
							) : (
								buttonText
							)}
						</VSCodeButton>
					</div>
				</div>
			</div>
		</div>
	)
}

export default memo(CreateWorktreeModal)
