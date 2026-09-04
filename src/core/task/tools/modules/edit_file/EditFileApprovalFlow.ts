import { DiracAskResponse } from "@shared/WebviewMessage"
import { DiracIcon } from "@/shared/icons"
import { CardStatus } from "@/shared/ExtensionMessage"
import { formatResponse } from "@core/formatResponse"
import { DiracDefaultTool } from "@/shared/tools"
import { stripHashesFromDiff } from "@utils/line-hashing"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import type { ToolPermissionDisposition } from "../../autoApprove"
import { PreparedFileBatch } from "./types"

export class EditFileApprovalFlow {
	async handle(
		env: IToolEnvironment,
		preparedBatches: PreparedFileBatch[],
		cards: Record<string, any>,
	): Promise<{ approved: boolean; userEdits?: Record<string, string>; feedback?: string }> {
		const utilityPermissionHandlingEnabled = env.config.permissionDecisionBinding !== undefined
		const permissionDisposition = await this.resolvePermissionDisposition(env, preparedBatches)
		if (permissionDisposition === "auto_approve") return { approved: true }

		let reviewShown = false

		while (true) {
			const totalRequestedEdits = preparedBatches.reduce((acc, batch) => acc + batch.prepared!.resolvedEdits.length, 0)
			const fileSummary =
				preparedBatches.length === 1 ? `file ${preparedBatches[0].displayPath}` : `${preparedBatches.length} files`
			const aggregatedDiffs = preparedBatches
				.map((batch) => stripHashesFromDiff(batch.prepared!.diff))
				.filter((diff) => diff.trim().length > 0)
				.join("\n\n")

			const card = await env.ui.createCard({
				header: `Apply ${totalRequestedEdits} edit(s) to ${fileSummary}?`,
				icon: DiracIcon.FILE_EDIT,
				status: CardStatus.WAITING_FOR_INPUT,
				requireApproval: true,
				permissionRequestKind:
					utilityPermissionHandlingEnabled && permissionDisposition === "manual_only" ? "manual_tool" : "tool",
				collapsed: false,
				renderType: "diff",
				body: aggregatedDiffs,
				maxHeight: 10000,
			})

			// Card creation resolves utility approval before any manual review opens.
			if (!reviewShown && card.requiresUserInteraction !== false) {
				await this.showReview(env, preparedBatches)
				await env.editor.scrollToFirstDiff()
				reviewShown = true
			}

			const result = await card.waitForInteraction()

			if (result.action === DiracAskResponse.EDIT || result.action === DiracAskResponse.VIEW) {
				await card.finalize(CardStatus.CANCELLED)
				await this.showReview(env, preparedBatches)
				await env.editor.scrollToFirstDiff()
				reviewShown = true
				continue
			}
			if (result.action === DiracAskResponse.UNDO) {
				await card.finalize(CardStatus.CANCELLED)
				await env.editor.undoUserEdits()
				continue
			}
			if (result.action === DiracAskResponse.MESSAGE) {
				if (result.text) await env.ui.upsertText(result.text, false, "user")
				await card.update({ body: `↩ Skipped by user` })
				await card.finalize(CardStatus.SKIPPED)
				await this.finalizeBatchCards(cards, CardStatus.SKIPPED, `- [ ] Skipped — user sent a message instead`)
				await env.editor.hideReview()
				return { approved: false, feedback: formatResponse.toolDeniedWithFeedback(result.text || result.value || "") }
			}
			if (result.action !== DiracAskResponse.APPROVE) {
				const denialBody = `- [ ] User denied permission`
				await card.update({ body: denialBody })
				await card.finalize(CardStatus.CANCELLED)
				await this.finalizeBatchCards(cards, CardStatus.CANCELLED, denialBody)
				await env.editor.hideReview()
				return { approved: false }
			}

			await card.finalize(CardStatus.SUCCESS)
			return { approved: true, userEdits: result.userEdits }
		}
	}

	private async resolvePermissionDisposition(
		env: IToolEnvironment,
		batches: PreparedFileBatch[],
	): Promise<ToolPermissionDisposition> {
		if (env.config.permissionDecisionBinding === undefined) {
			if (env.config.isSubagentExecution) return "auto_approve"
			if (env.config.autoApprover.isUnrestrictedAutoApprove()) return "auto_approve"
			for (const batch of batches) {
				const autoApproved = await env.config.callbacks.shouldAutoApproveToolWithPath(
					DiracDefaultTool.EDIT_FILE,
					batch.displayPath,
				)
				if (!autoApproved) return "manual_only"
			}
			return "auto_approve"
		}

		let disposition: ToolPermissionDisposition = "auto_approve"
		for (const batch of batches) {
			const pathDisposition = await env.config.callbacks.resolveToolPathPermission(
				DiracDefaultTool.EDIT_FILE,
				batch.displayPath,
			)
			if (pathDisposition === "manual_only") return "manual_only"
			if (pathDisposition === "utility_eligible") disposition = "utility_eligible"
		}
		return disposition
	}

	private async showReview(env: IToolEnvironment, batches: PreparedFileBatch[]): Promise<void> {
		await env.editor.showReview(
			batches.map((batch) => ({
				absolutePath: batch.absolutePath,
				displayPath: batch.displayPath,
				content: batch.prepared!.finalContent,
				originalContent: batch.prepared!.content,
			})),
		)
	}

	private async finalizeBatchCards(cards: Record<string, any>, status: CardStatus, body: string): Promise<void> {
		for (const absolutePath of Object.keys(cards)) {
			await cards[absolutePath].update({ body })
			await cards[absolutePath].finalize(status)
		}
	}
}
