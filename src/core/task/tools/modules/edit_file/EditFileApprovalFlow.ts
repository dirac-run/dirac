import { DiracAskResponse } from "@shared/WebviewMessage"
import { DiracIcon } from "@/shared/icons"
import { CardStatus } from "@/shared/ExtensionMessage"
import { formatResponse } from "@core/formatResponse"
import { DiracDefaultTool } from "@/shared/tools"
import { stripHashesFromDiff } from "@utils/line-hashing"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { PreparedFileBatch } from "./types"

// Manages the user approval flow: auto-approval checks, manual review, and interaction loop.
export class EditFileApprovalFlow {
	async handle(
		env: IToolEnvironment,
		preparedBatches: PreparedFileBatch[],
		cards: Record<string, any>,
	): Promise<{ approved: boolean; userEdits?: Record<string, string>; feedback?: string }> {
		if (await this.shouldAutoApprove(env, preparedBatches)) return { approved: true }

		// Manual approval path — show review first
		await this.showReview(env, preparedBatches)
		await env.editor.scrollToFirstDiff()

		while (true) {
			const totalRequestedEdits = preparedBatches.reduce((acc, b) => acc + b.prepared!.resolvedEdits.length, 0)
			const fileSummary =
				preparedBatches.length === 1 ? `file ${preparedBatches[0].displayPath}` : `${preparedBatches.length} files`
			const aggregatedDiffs = preparedBatches
				.map((b) => stripHashesFromDiff(b.prepared!.diff))
				.filter((d) => d.trim().length > 0)
				.join("\n\n")

			const card = await env.ui.createCard({
				header: `Apply ${totalRequestedEdits} edit(s) to ${fileSummary}?`,
				icon: DiracIcon.FILE_EDIT,
				status: CardStatus.WAITING_FOR_INPUT,
				requireApproval: true,
				collapsed: false,
				renderType: "diff",
				body: aggregatedDiffs,
				maxHeight: 10000,
			})

			const result = await card.waitForInteraction()

			// VIEW/EDIT — re-show review and loop
			if (result.action === DiracAskResponse.EDIT || result.action === DiracAskResponse.VIEW) {
				await card.finalize(CardStatus.CANCELLED)
				await this.showReview(env, preparedBatches)
				await env.editor.scrollToFirstDiff()
				continue
			}
			// UNDO — revert user edits and loop
			if (result.action === DiracAskResponse.UNDO) {
				await card.finalize(CardStatus.CANCELLED)
				await env.editor.undoUserEdits()
				continue
			}
			// MESSAGE — user sent feedback instead of approving
			if (result.action === DiracAskResponse.MESSAGE) {
				if (result.text) await env.ui.upsertText(result.text, false, "user")
				await card.update({ body: `↩ Skipped by user` })
				await card.finalize(CardStatus.SKIPPED)
				await this.finalizeBatchCards(cards, CardStatus.SKIPPED, `- [ ] Skipped — user sent a message instead`)
				await env.editor.hideReview()
				return { approved: false, feedback: formatResponse.toolDeniedWithFeedback(result.text || result.value || "") }
			}
			// Non-approve — user denied
			if (result.action !== DiracAskResponse.APPROVE) {
				await card.update({ body: `- [ ] User denied permission` })
				await card.finalize(CardStatus.CANCELLED)
				await this.finalizeBatchCards(cards, CardStatus.CANCELLED, `- [ ] User denied permission`)
				await env.editor.hideReview()
				return { approved: false }
			}

			await card.finalize(CardStatus.SUCCESS)
			return { approved: true, userEdits: result.userEdits }
		}
	}

	private async shouldAutoApprove(env: IToolEnvironment, batches: PreparedFileBatch[]): Promise<boolean> {
		if (env.config.isSubagentExecution) return true
		if (env.config.autoApprover.isUnrestrictedAutoApprove()) return true
		for (const batch of batches) {
			const allowed = await env.config.callbacks.shouldAutoApproveToolWithPath(
				DiracDefaultTool.EDIT_FILE,
				batch.displayPath,
			)
			if (!allowed) return false
		}
		return true
	}

	private async showReview(env: IToolEnvironment, batches: PreparedFileBatch[]): Promise<void> {
		await env.editor.showReview(
			batches.map((b) => ({
				absolutePath: b.absolutePath,
				displayPath: b.displayPath,
				content: b.prepared!.finalContent,
				originalContent: b.prepared!.content,
			})),
		)
	}

	private async finalizeBatchCards(cards: Record<string, any>, status: CardStatus, body: string): Promise<void> {
		for (const absPath of Object.keys(cards)) {
			await cards[absPath].update({ body })
			await cards[absPath].finalize(status)
		}
	}
}
