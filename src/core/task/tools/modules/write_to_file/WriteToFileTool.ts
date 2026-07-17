import { formatResponse } from "@core/formatResponse"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { stripHashes } from "@utils/line-hashing"
import { CardStatus } from "@/shared/ExtensionMessage"
import { DiracIcon } from "@/shared/icons"
import { DiracDefaultTool, DiracToolSpec } from "@/shared/tools"
import { IDiracTool } from "../../interfaces/IDiracTool"
import { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import { SurfaceType } from "../../interfaces/SurfaceType"
import { captureAccepted, captureRejected, getModelInfo } from "../../utils/AiOutputTelemetry"
import { applyModelContentFixes } from "../../utils/ModelContentProcessor"

export interface WriteFileArgs {
	path: string
	content: string
}

export abstract class BaseWriteFileTool implements IDiracTool<WriteFileArgs> {
	abstract spec(): DiracToolSpec

	supportedSurfaces(): SurfaceType[] {
		return ["all"]
	}

	async processCall(args: WriteFileArgs, env: IToolEnvironment): Promise<any> {
		let card: any
		const { path: relPath, content: rawContent } = args
		const toolId = this.spec().id

		try {
			// 1. Validate and Resolve
			const validation = await this.validateAndResolve(args, env)
			if ("error" in validation) return validation.error
			const { absolutePath, displayPath, fileExists, originalContent } = validation

			// 2. Pre-process content
			const content = this.preprocessContent(rawContent, env, relPath)

			// 3. Create card
			if (!env.config.isSubagentExecution) {
				const lineCount = content.split("\n").length
				card = await env.ui.createCard({
					header: `Writing ${displayPath}`,
					icon: DiracIcon.FILE_WRITE,
					status: CardStatus.RUNNING,
					collapsed: true,
					diffs: [{ path: displayPath, oldText: originalContent, newText: content }],
				})
			}

			// 4. Handle approval and save
			const shouldAutoApprove = await env.config.callbacks.shouldAutoApproveToolWithPath(toolId, relPath)
			const saveResult = await this.awaitApprovalThenWriteFile(
				env,
				absolutePath,
				displayPath,
				content,
				fileExists,
				originalContent,
				shouldAutoApprove,
				card,
			)

			if (typeof saveResult === "string") return saveResult // Denied with feedback or error

			// 5. Finalize results
			return await this.finalizeResults(env, absolutePath, relPath, fileExists, saveResult, shouldAutoApprove)
		} catch (error) {
			return await this.finalizeCardWithError(error, env, card)
		}
	}

	private async validateAndResolve(args: WriteFileArgs, env: IToolEnvironment) {
		const { path: relPath, content: rawContent } = args
		const toolId = this.spec().id

		if (!relPath) {
			env.orchestration.setTaskState("consecutiveMistakeCount", env.config.taskState.consecutiveMistakeCount + 1)
			if (!env.config.isSubagentExecution) {
				await env.ui.upsertText("Missing value for required parameter 'path'.")
			}
			return { error: formatResponse.missingToolParameterError("path") }
		}

		if (!rawContent) {
			env.orchestration.setTaskState("consecutiveMistakeCount", env.config.taskState.consecutiveMistakeCount + 1)
			if (toolId === DiracDefaultTool.FILE_NEW) {
				return {
					error: formatResponse.writeToFileMissingContentError(relPath, env.config.taskState.consecutiveMistakeCount),
				}
			}
			if (!env.config.isSubagentExecution) {
				await env.ui.upsertText("Missing value for required parameter 'content'.")
			}
			return { error: formatResponse.missingToolParameterError("content") }
		}

		const { absolutePath, displayPath } = await env.workspace.resolvePath(relPath)

		if (!env.config.services.diracIgnoreController.validateAccess(relPath)) {
			env.orchestration.setTaskState("consecutiveMistakeCount", env.config.taskState.consecutiveMistakeCount + 1)
			await env.ui.upsertText(`Access to '${relPath}' is blocked by .diracignore`)
			return { error: formatResponse.toolError(formatResponse.diracIgnoreError(relPath)) }
		}

		const fileInfo = await env.workspace.getFileInfo(absolutePath)
		if (fileInfo.exists && !fileInfo.isFile) {
			env.orchestration.setTaskState("consecutiveMistakeCount", env.config.taskState.consecutiveMistakeCount + 1)
			const errorMsg = `Cannot write to '${relPath}' because it is a directory.`
			if (!env.config.isSubagentExecution) {
				await env.ui.upsertText(`Dirac tried to write to '${relPath}', but it is a directory.`)
			}
			return { error: formatResponse.toolError(errorMsg) }
		}

		return {
			absolutePath,
			displayPath,
			fileExists: fileInfo.exists,
			originalContent: fileInfo.exists ? await env.workspace.readFile(absolutePath) : "",
		}
	}

	private preprocessContent(rawContent: string, env: IToolEnvironment, relPath: string): string {
		let content = stripHashes(rawContent)

		if (content.startsWith("```")) {
			content = content.split("\n").slice(1).join("\n").trim()
		}
		if (content.endsWith("```")) {
			content = content.split("\n").slice(0, -1).join("\n").trim()
		}

		const { modelId } = getModelInfo(env.config)
		content = applyModelContentFixes(content, modelId, relPath)
		return content
	}

	private async awaitApprovalThenWriteFile(
		env: IToolEnvironment,
		absolutePath: string,
		displayPath: string,
		content: string,
		fileExists: boolean,
		originalContent: string,
		shouldAutoApprove: boolean,
		card?: any,
	): Promise<any | string> {
		const toolId = this.spec().id
		const { modelId, providerId } = getModelInfo(env.config)
		let saveResult: any

		if (shouldAutoApprove) {
			if (card) {
				await card.update({
					status: CardStatus.RUNNING,
					body: `${fileExists ? "Updating" : "Creating"} file...`,
				})
			}

			if (env.config.backgroundEditEnabled) {
				saveResult = await env.editor.applyAndSaveSilently(absolutePath, content)
			} else {
				await env.editor.open(absolutePath)
				await env.editor.update(content, true)
				saveResult = await env.editor.saveChanges()
			}

			if (card) {
				await card.update({
					header: `Wrote ${displayPath}`,
					body: `✓ Successfully wrote to ${displayPath}`,
					diffs: [{ path: displayPath, oldText: originalContent, newText: saveResult.content }],
				})
				await card.finalize(CardStatus.SUCCESS)
			}

			captureAccepted({
				ulid: env.config.ulid,
				tool: toolId,
				source: "agent",
				beforeContent: originalContent,
				afterContent: content,
				providerId,
				modelId,
				filesCreated: fileExists ? 0 : 1,
			})
		} else {
			if (card) {
				await card.update({ status: CardStatus.RUNNING })
			}

			const permissionMessage = `Dirac wants to ${fileExists ? "edit" : "create"} ${displayPath}`
			const result = await env.interaction.askPermission(permissionMessage, {
				diffs: [{ path: displayPath, oldText: originalContent, newText: content }],
				rawInput: { path: displayPath, content },
			})
			const { approved, value: reason } = result

			if (result.action === DiracAskResponse.MESSAGE) {
				if (result.text) {
					await env.ui.upsertText(result.text, false, "user")
				}
				await result.card.finalize(CardStatus.SKIPPED)
				if (card) {
					await card.update({ body: `- [ ] Skipped — user sent a message instead` })
					await card.finalize(CardStatus.SKIPPED)
				}
				return formatResponse.toolDeniedWithFeedback(result.text || reason || "")
			}

			await result.card.finalize(approved ? CardStatus.SUCCESS : CardStatus.CANCELLED)

			if (!approved) {
				if (card) {
					await card.update({
						body: `- [ ] User denied permission${reason ? `: ${reason}` : ""}`,
					})
					await card.finalize(CardStatus.CANCELLED)
				}

				captureRejected({
					ulid: env.config.ulid,
					tool: toolId,
					source: "agent",
					beforeContent: originalContent,
					afterContent: content,
					providerId,
					modelId,
					filesCreated: fileExists ? 0 : 1,
				})

				return reason ? formatResponse.toolDeniedWithFeedback(reason) : formatResponse.toolDenied()
			}

			await env.editor.open(absolutePath)
			await env.editor.update(content, true)
			await env.editor.scrollToFirstDiff()
			saveResult = await env.editor.saveChanges()

			if (card) {
				await card.update({
					header: `Wrote ${displayPath}`,
					body: `✓ Successfully wrote to ${displayPath}`,
					diffs: [{ path: displayPath, oldText: originalContent, newText: saveResult.content }],
				})
				await card.finalize(CardStatus.SUCCESS)
			}

			captureAccepted({
				ulid: env.config.ulid,
				tool: toolId,
				source: "agent",
				beforeContent: originalContent,
				afterContent: content,
				providerId,
				modelId,
				filesCreated: fileExists ? 0 : 1,
			})
		}

		return saveResult
	}

	private async finalizeResults(
		env: IToolEnvironment,
		absolutePath: string,
		relPath: string,
		fileExists: boolean,
		saveResult: any,
		shouldAutoApprove: boolean,
	) {
		const toolId = this.spec().id
		await env.editor.reset()
		await env.diagnostics.prepare([absolutePath])
		const diagnostics = await env.diagnostics.getRaw([absolutePath])
		const newProblemsMessage = diagnostics.length > 0 ? `Found ${diagnostics.length} problems in ${relPath}` : undefined

		env.telemetry.captureCustomMetadata({
			toolId,
			relPath,
			fileExists,
			shouldAutoApprove,
			isSubagentExecution: env.config.isSubagentExecution,
			filesCreated: fileExists ? 0 : 1,
		})

		if (saveResult.userEdits) {
			return formatResponse.fileEditWithUserChanges(
				relPath,
				"User made manual changes in the editor.",
				saveResult.autoFormatting ? "Auto-formatting applied." : undefined,
				newProblemsMessage,
			)
		}

		return formatResponse.fileEditWithoutUserChanges(
			relPath,
			saveResult.autoFormatting ? "Auto-formatting applied." : undefined,
			newProblemsMessage,
		)
	}

	private async finalizeCardWithError(error: any, env: IToolEnvironment, card?: any): Promise<string> {
		env.orchestration.setTaskState("consecutiveMistakeCount", env.config.taskState.consecutiveMistakeCount + 1)

		if (card) {
			await card.update({
				body: `✕ Error: ${error.message || String(error)}`,
			})
			await card.finalize(CardStatus.ERROR)
		}

		return formatResponse.toolError(error.message || String(error))
	}
}

export const write_to_file_spec: DiracToolSpec = {
	id: DiracDefaultTool.FILE_NEW,
	name: "write_to_file",
	description: "Creates a new file or completely overwrites an existing file. Automatically creates required directories.",
	parameters: [
		{
			name: "path",
			required: true,
			type: "string",
			instruction: "The path of the file to write to.",
		},
		{
			name: "content",
			required: true,
			type: "string",
			instruction: "The COMPLETE intended content of the file. Do not truncate or omit any parts.",
		},
	],
}


export class WriteToFileTool extends BaseWriteFileTool {
	spec(): DiracToolSpec {
		return write_to_file_spec
	}
}
