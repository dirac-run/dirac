import { formatResponse } from "@core/formatResponse"
import type { SourceMutationPlan } from "@services/source-ast/types"
import { CardStatus, isFinalStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@shared/icons"
import { DiracDefaultTool, type DiracToolSpec } from "@shared/tools"
import { getErrorMessage } from "@/shared/errors"
import type { IDiracTool } from "../../interfaces/IDiracTool"
import type { ICardHandle, IToolEnvironment } from "../../interfaces/IToolEnvironment"
import type { SurfaceType } from "../../interfaces/SurfaceType"
import { ToolSkippedByUserMessage } from "../../types/ToolSkippedByUserMessage"
import { AstEditApplier, type AstEditApplyResult } from "./AstEditApplier"
import { AstEditApproval } from "./AstEditApproval"
import { AstEditFormatter } from "./AstEditFormatter"
import { type EditAstArgs, EditAstValidator } from "./EditAstValidator"

export const edit_ast_spec: DiracToolSpec = {
	id: DiracDefaultTool.EDIT_AST,
	name: "edit_ast",
	description:
		"AST-aware rename and whole-definition replacement. Use rename for exact indexed definitions and references within selected scopes, replace for complete named definitions, and edit_file for partial edits. The tool validates the full plan, requests approval when required, writes changes, and reports diagnostics. Unavailable in strict Plan Mode.",
	parameters: [
		{
			name: "operation",
			required: true,
			type: "string",
			enum: ["rename", "replace"],
			instruction: "rename updates exact indexed occurrences; replace replaces complete named definitions.",
		},
		{
			name: "targets",
			required: true,
			type: "array",
			items: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "File or directory scope for rename; one source file for replace.",
					},
					symbol: {
						type: "string",
						description: "Exact symbol; qualify ambiguous names, for example UserService.load.",
					},
					replacement: {
						type: "string",
						description:
							"New identifier for rename; complete definition source for replace, including owned docs, comments, decorators, and declaration or export syntax.",
					},
				},
				required: ["path", "symbol", "replacement"],
				additionalProperties: false,
			},
			instruction:
				"One or more targets. Rename targets must share one symbol and replacement; replace targets identify source files and named definitions.",
		},
	],
}

/** Orchestrates validated AST mutation planning, approval, saving, diagnostics, cards, and reporting. */
export class EditAstTool implements IDiracTool<EditAstArgs, string> {
	private readonly validator = new EditAstValidator()
	private readonly formatter = new AstEditFormatter()
	private readonly approval = new AstEditApproval(this.formatter)
	private readonly applier = new AstEditApplier()

	public spec(): DiracToolSpec {
		return edit_ast_spec
	}

	public supportedSurfaces(): SurfaceType[] {
		return ["all"]
	}

	public async processCall(rawArgs: EditAstArgs, env: IToolEnvironment): Promise<string> {
		const validation = this.validator.validate(rawArgs)
		if (!validation.valid) {
			this.incrementMistake(env)
			return formatResponse.toolError(validation.error)
		}

		const args = validation.args
		const progressCards = new Map<string, ICardHandle>()
		let plan: SourceMutationPlan | undefined
		let applied: AstEditApplyResult | undefined
		let autoApproved = false
		let approved = false

		try {
			plan = await this.plan(args, env)
			if (plan.failures.length > 0) {
				this.captureTelemetry(env, args, plan, undefined, { autoApproved, approved })
				return formatResponse.toolError(`AST edit plan rejected.\n\n${this.formatter.invalidPlan(plan)}`)
			}
			if (plan.files.length === 0 || plan.editCount === 0) {
				this.captureTelemetry(env, args, plan, undefined, { autoApproved, approved })
				return this.formatter.invalidPlan(plan)
			}

			await this.createProgressCards(args, plan, env, progressCards)

			const approvalResult = await this.approval.request(env, args, plan, progressCards)
			autoApproved = approvalResult.autoApproved
			approved = approvalResult.approved
			if (!approvalResult.approved) {
				this.captureTelemetry(env, args, plan, undefined, { autoApproved, approved })
				return approvalResult.feedback || formatResponse.toolDenied()
			}

			env.config.callbacks.assertMutationAuthorized(DiracDefaultTool.EDIT_AST)
			applied = await this.applier.apply(env, plan, approvalResult.userEdits)
		} catch (error) {
			if (error instanceof ToolSkippedByUserMessage) {
				await env.editor.hideReview()
				throw error
			}
			if (applied && plan) {
				return this.completeAfterWrites(
					args,
					plan,
					applied,
					progressCards,
					env,
					{ autoApproved, approved },
					error,
				)
			}
			await env.editor.hideReview().catch(() => undefined)
			await this.finalizeUnexpectedFailure(progressCards, error)
			this.captureTelemetry(env, args, plan, undefined, { autoApproved, approved, executionFailed: true })
			return formatResponse.toolError(this.formatter.formatFailure(error))
		}

		return this.completeAfterWrites(
			args,
			plan,
			applied,
			progressCards,
			env,
			{ autoApproved, approved },
		)
	}

	private async completeAfterWrites(
		args: EditAstArgs,
		plan: SourceMutationPlan,
		applied: AstEditApplyResult,
		progressCards: Map<string, ICardHandle>,
		env: IToolEnvironment,
		approvalState: { autoApproved: boolean; approved: boolean },
		priorError?: unknown,
	): Promise<string> {
		const observabilityFailures: string[] = []
		if (priorError) observabilityFailures.push(this.errorMessage(priorError))
		try {
			await env.editor.hideReview()
		} catch (error) {
			observabilityFailures.push(`review cleanup failed: ${this.errorMessage(error)}`)
		}
		observabilityFailures.push(...await this.finalizeProgressCards(args, applied, progressCards))
		const telemetryFailure = this.captureTelemetry(env, args, plan, applied, {
			...approvalState,
			executionFailed: observabilityFailures.length > 0,
		})
		if (telemetryFailure) observabilityFailures.push(telemetryFailure)

		let result: string
		try {
			result = this.formatter.formatResult(args, plan, applied)
		} catch (error) {
			observabilityFailures.push(`result formatting failed: ${this.errorMessage(error)}.`)
			result = applied.savedFileCount > 0
				? `${args.operation === "rename" ? "Rename" : "Replacement"} completed: saved ${applied.savedFileCount} of ${plan.files.length} file(s), with ${applied.failedFileCount} save failure(s).`
				: `${args.operation === "rename" ? "Rename" : "Replacement"} failed: no files were saved.`
		}
		const withObservabilityWarning = observabilityFailures.length > 0
			? `${result}\n\nObservability warning: the files above were already saved, but ${observabilityFailures.join(" ")}`
			: result
		if (applied.savedFileCount > 0) {
			try {
				env.orchestration.setTaskState("consecutiveMistakeCount", 0)
			} catch (error) {
				return `${withObservabilityWarning}\n\nObservability warning: task-state update failed: ${this.errorMessage(error)}.`
			}
			return withObservabilityWarning
		}
		return formatResponse.toolError(withObservabilityWarning)
	}

	private plan(args: EditAstArgs, env: IToolEnvironment): Promise<SourceMutationPlan> {
		if (args.operation === "rename") {
			return env.sourceAst.planRename({
				paths: args.targets.map((target) => target.path),
				symbol: args.targets[0].symbol,
				replacement: args.targets[0].replacement,
			})
		}
		return env.sourceAst.planReplacements({ targets: args.targets })
	}

	private async createProgressCards(
		args: EditAstArgs,
		plan: SourceMutationPlan,
		env: IToolEnvironment,
		cards: Map<string, ICardHandle>,
	): Promise<void> {
		for (const file of plan.files) {
			const card = await env.ui.createCard({
				header: this.formatter.progressHeader(args.operation, file),
				icon: args.operation === "rename" ? DiracIcon.SYMBOL_RENAME : DiracIcon.SYMBOL_REPLACE,
				status: CardStatus.RUNNING,
				collapsed: true,
				body: `Validated ${file.editCount} edit(s).`,
				locations: [{ path: file.displayPath }],
				rawInput: {
					tool: "edit_ast",
					operation: args.operation,
					path: file.displayPath,
					symbols: file.changedSymbols,
				},
				rawOutput: { status: "planned", editCount: file.editCount },
			})
			cards.set(file.absolutePath, card)
		}
	}

	private async finalizeProgressCards(
		args: EditAstArgs,
		applied: AstEditApplyResult,
		cards: Map<string, ICardHandle>,
	): Promise<string[]> {
		const failures: string[] = []
		for (const result of applied.files) {
			const card = cards.get(result.file.absolutePath)
			if (!card) continue
			const saved = result.status === "saved"
			const status = saved ? CardStatus.SUCCESS : CardStatus.ERROR
			const body = saved
				? [
					`Saved ${result.file.editCount} edit(s).`,
					result.diagnosticsStatus === "clean" ? "No diagnostics problems reported." : undefined,
					result.diagnosticsStatus === "problems"
						? `Diagnostics reported ${result.diagnostics?.diagnostics.length ?? 0} problem(s).`
						: undefined,
					result.diagnosticsStatus === "failed"
						? `Diagnostics collection failed: ${result.diagnosticsError}`
						: undefined,
				].filter(Boolean).join("\n")
				: `Save failed: ${result.saveError}`
			try {
				await card.update({
					header: saved
						? this.formatter.completedHeader(args.operation, result.file)
						: `Failed to save ${result.file.displayPath}`,
					body,
					status,
					diffs: [{
						path: result.file.displayPath,
						oldText: result.file.originalContent,
						newText: result.finalContent ?? result.file.content,
					}],
					rawOutput: {
						status: saved ? "saved" : "save_failed",
						editCount: result.file.editCount,
						diagnosticsStatus: result.diagnosticsStatus,
						diagnosticsErrorCount: result.errorCount,
					},
				})
			} catch (error) {
				failures.push(`card update failed for ${result.file.displayPath}: ${this.errorMessage(error)}.`)
			}
			try {
				await card.finalize(status)
			} catch (error) {
				failures.push(`card finalization failed for ${result.file.displayPath}: ${this.errorMessage(error)}.`)
			}
		}
		return failures
	}

	private async finalizeUnexpectedFailure(cards: Map<string, ICardHandle>, error: unknown): Promise<void> {
		const message = this.formatter.formatFailure(error)
		for (const card of cards.values()) {
			if (isFinalStatus(card.status)) continue
			try {
				await card.update({ body: message, rawOutput: { status: "error" } })
			} catch {
				// Finalization remains mandatory even if the observability update fails.
			}
			try {
				await card.finalize(CardStatus.ERROR)
			} catch {
				// Preserve the original tool failure after attempting every card.
			}
		}
	}

	private captureTelemetry(
		env: IToolEnvironment,
		args: EditAstArgs,
		plan: SourceMutationPlan | undefined,
		applied: AstEditApplyResult | undefined,
		state: { autoApproved: boolean; approved: boolean; executionFailed?: boolean },
	): string | undefined {
		try {
			env.telemetry.captureCustomMetadata({
				operation: args.operation,
				requestedTargetCount: args.targets.length,
				plannedFileCount: plan?.files.length ?? 0,
				plannedEditCount: plan?.editCount ?? 0,
				unchangedTargetCount: plan?.unchangedTargets.length ?? 0,
				planningFailureCount: plan?.failures.length ?? 0,
				autoApproved: state.autoApproved,
				approved: state.approved,
				savedFileCount: applied?.savedFileCount ?? 0,
				failedFileCount: applied?.failedFileCount ?? 0,
				diagnosticsErrorCount: applied?.diagnosticsErrorCount ?? 0,
				diagnosticsFailureCount: applied?.diagnosticsFailureCount ?? 0,
				partialFailure: applied?.partialFailure ?? false,
				executionFailed: state.executionFailed === true,
			})
			return undefined
		} catch (error) {
			return `telemetry failed: ${this.errorMessage(error)}.`
		}
	}

	private incrementMistake(env: IToolEnvironment): void {
		const count = env.orchestration.getTaskState("consecutiveMistakeCount")
		env.orchestration.setTaskState("consecutiveMistakeCount", count + 1)
	}

	private errorMessage(error: unknown): string {
		return getErrorMessage(error)
	}
}
