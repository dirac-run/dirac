import { formatResponse } from "@core/formatResponse"
import type { SourceMutationPlan } from "@services/source-ast/types"
import { type CardDiff, CardStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@shared/icons"
import { DiracDefaultTool } from "@shared/tools"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { getErrorMessage } from "@/shared/errors"
import type { ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import type { ToolPermissionDisposition } from "../../autoApprove"
import type { AstEditFormatter } from "./AstEditFormatter"
import type { EditAstArgs } from "./EditAstValidator"

export interface AstEditApprovalResult {
	approved: boolean
	autoApproved: boolean
	feedback?: string
	userEdits?: Record<string, string>
}

/** Owns per-path approval checks, review presentation, interaction, and review cleanup. */
export class AstEditApproval {
	constructor(private readonly formatter: AstEditFormatter) { }

	public async request(
		env: IToolEnvironment,
		args: EditAstArgs,
		plan: SourceMutationPlan,
		progressCards: Map<string, ICardHandle>,
	): Promise<AstEditApprovalResult> {
		const utilityPermissionHandlingEnabled = env.config.permissionDecisionBinding !== undefined
		const permissionDisposition = await this.resolvePermissionDisposition(env, plan)
		if (permissionDisposition === "auto_approve") {
			await this.updateProgressCards(progressCards, "Plan validated. Auto-approved; applying changes...")
			return { approved: true, autoApproved: true }
		}

		if (!utilityPermissionHandlingEnabled && env.config.isSubagentExecution) {
			return {
				approved: false,
				autoApproved: false,
				feedback: formatResponse.toolError(
					"edit_ast cannot modify one or more requested paths in this non-interactive subagent. Run the edit in the parent agent where approval can be requested.",
				),
			}
		}

		const diffs = this.formatter.diffs(plan)
		let reviewShown = false
		await this.updateProgressCards(progressCards, "Plan validated. Waiting for approval...")

		while (true) {
			const approvalCard = await this.createApprovalCard(
				env,
				args,
				plan,
				diffs,
				permissionDisposition,
				utilityPermissionHandlingEnabled,
			)
			// Card creation resolves utility approval before any manual review opens.
			if (!reviewShown && approvalCard.requiresUserInteraction !== false) {
				await env.editor.showReview(
					plan.files.map((file) => ({
						absolutePath: file.absolutePath,
						displayPath: file.displayPath,
						content: file.content,
						originalContent: file.originalContent,
					})),
				)
				await env.editor.scrollToFirstDiff()
				reviewShown = true
			}

			let result: Awaited<ReturnType<ICardHandle["waitForInteraction"]>>
			try {
				result = await approvalCard.waitForInteraction()
			} catch (error) {
				try {
					await this.finalizeApprovalCard(
						approvalCard,
						CardStatus.ERROR,
						`Approval interaction failed: ${this.errorMessage(error)}`,
						{ status: "error", reason: "interaction_failed" },
					)
				} catch (finalizationError) {
					throw new AggregateError([error, finalizationError], "Approval interaction and card finalization failed")
				}
				throw error
			}

			if (result.action === DiracAskResponse.EDIT || result.action === DiracAskResponse.VIEW) {
				await this.finalizeApprovalCard(
					approvalCard,
					CardStatus.CANCELLED,
					"Review reopened for inspection or editing.",
					{ status: "cancelled", reason: "review_reopened" },
				)
				await env.editor.showReview(
					plan.files.map((file) => ({
						absolutePath: file.absolutePath,
						displayPath: file.displayPath,
						content: file.content,
						originalContent: file.originalContent,
					})),
				)
				await env.editor.scrollToFirstDiff()
				reviewShown = true
				continue
			}

			if (result.action === DiracAskResponse.UNDO) {
				await this.finalizeApprovalCard(
					approvalCard,
					CardStatus.CANCELLED,
					"Review edits were undone; waiting for a new decision.",
					{ status: "cancelled", reason: "review_undo" },
				)
				await env.editor.undoUserEdits()
				continue
			}

			if (result.action === DiracAskResponse.MESSAGE) {
				await this.finalizeApprovalCard(
					approvalCard,
					CardStatus.SKIPPED,
					"Operation denied by user — a message was sent instead.",
					{ status: "denied", reason: "user_message" },
				)
				if (result.text) await env.ui.upsertText(result.text, false, "user")
				await env.editor.hideReview()
				await this.finalizeProgressCards(progressCards, CardStatus.SKIPPED, "Operation denied by user.")
				return {
					approved: false,
					autoApproved: false,
					feedback: formatResponse.toolDeniedWithFeedback(result.text || result.value || ""),
				}
			}

			if (result.action !== DiracAskResponse.APPROVE) {
				await this.finalizeApprovalCard(approvalCard, CardStatus.CANCELLED, "Operation denied by user.", {
					status: "denied",
					reason: result.value || "rejected",
				})
				await env.editor.hideReview()
				await this.finalizeProgressCards(progressCards, CardStatus.CANCELLED, "Operation denied by user.")
				return {
					approved: false,
					autoApproved: false,
					feedback: formatResponse.toolDenied(),
				}
			}

			await this.finalizeApprovalCard(approvalCard, CardStatus.SUCCESS, this.formatter.approvalBody(args, plan), {
				status: "approved",
			})
			return { approved: true, autoApproved: false, userEdits: result.userEdits }
		}
	}

	private async resolvePermissionDisposition(
		env: IToolEnvironment,
		plan: SourceMutationPlan,
	): Promise<ToolPermissionDisposition> {
		if (env.config.permissionDecisionBinding === undefined) {
			if (env.config.autoApprover.isUnrestrictedAutoApprove()) return "auto_approve"
			for (const file of plan.files) {
				const autoApproved = await env.config.callbacks.shouldAutoApproveToolWithPath(
					DiracDefaultTool.EDIT_AST,
					file.displayPath,
				)
				if (!autoApproved) return "manual_only"
			}
			return "auto_approve"
		}

		let disposition: ToolPermissionDisposition = "auto_approve"
		for (const file of plan.files) {
			const pathDisposition = await env.config.callbacks.resolveToolPathPermission(
				DiracDefaultTool.EDIT_AST,
				file.displayPath,
			)
			if (pathDisposition === "manual_only") return "manual_only"
			if (pathDisposition === "utility_eligible") disposition = "utility_eligible"
		}
		return disposition
	}

	private createApprovalCard(
		env: IToolEnvironment,
		args: EditAstArgs,
		plan: SourceMutationPlan,
		diffs: CardDiff[],
		permissionDisposition: ToolPermissionDisposition,
		utilityPermissionHandlingEnabled: boolean,
	): Promise<ICardHandle> {
		return env.ui.createCard({
			header: this.formatter.approvalHeader(args, plan),
			icon: args.operation === "rename" ? DiracIcon.SYMBOL_RENAME : DiracIcon.SYMBOL_REPLACE,
			status: CardStatus.WAITING_FOR_INPUT,
			requireApproval: true,
			permissionRequestKind:
				utilityPermissionHandlingEnabled && permissionDisposition === "manual_only" ? "manual_tool" : "tool",
			collapsed: false,
			renderType: "diff",
			body: this.formatter.approvalBody(args, plan),
			diffs,
			locations: plan.files.map((file) => ({ path: file.displayPath })),
			rawInput: {
				tool: "edit_ast",
				operation: args.operation,
				targets: args.targets.map(({ path, symbol }) => ({ path, symbol })),
			},
			rawOutput: {
				status: "waiting_for_approval",
				plannedFileCount: plan.files.length,
				plannedEditCount: plan.editCount,
			},
			maxHeight: 10000,
		})
	}

	private async finalizeApprovalCard(
		card: ICardHandle,
		status: CardStatus,
		body: string,
		rawOutput: Record<string, unknown>,
	): Promise<void> {
		let updateError: unknown
		let finalizationError: unknown
		try {
			await card.update({ body, rawOutput, status })
		} catch (error) {
			updateError = error
		}
		try {
			await card.finalize(status)
		} catch (error) {
			finalizationError = error
		}
		if (updateError && finalizationError) {
			throw new AggregateError([updateError, finalizationError], "Approval card update and finalization failed")
		}
		if (updateError) throw updateError
		if (finalizationError) throw finalizationError
	}

	private async updateProgressCards(cards: Map<string, ICardHandle>, body: string): Promise<void> {
		for (const card of cards.values()) await card.update({ body })
	}

	private async finalizeProgressCards(cards: Map<string, ICardHandle>, status: CardStatus, body: string): Promise<void> {
		for (const card of cards.values()) {
			await card.update({ body, rawOutput: { status } })
			await card.finalize(status)
		}
	}

	private errorMessage(error: unknown): string {
		return getErrorMessage(error)
	}
}
