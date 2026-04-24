import { sendPartialMessageEvent } from "@core/controller/ui/subscribeToPartialMessage"
import { executeHook } from "@core/hooks/hook-executor"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { formatResponse } from "@core/prompts/responses"
import { DiracAsk, DiracSay, MultiCommandState } from "@shared/ExtensionMessage"
import { convertDiracMessageToProto } from "@shared/proto-conversions/dirac-message"
import { Logger } from "@shared/services/Logger"
import { DiracDefaultTool } from "@shared/tools"
import { DiracAskResponse } from "@shared/WebviewMessage"
import pWaitFor from "p-wait-for"
import { TaskMessengerDependencies } from "./types/task-messenger"

export class TaskMessenger {
	constructor(private dependencies: TaskMessengerDependencies) {}

	async ask(
		type: DiracAsk,
		text?: string,
		partial?: boolean,
		multiCommandState?: MultiCommandState,
	): Promise<{
		response: DiracAskResponse
		text?: string
		images?: string[]
		files?: string[]
		askTs?: number
	}> {
		// Allow resume asks even when aborted to enable resume button after cancellation
		if (this.dependencies.taskState.abort && type !== "resume_task" && type !== "resume_completed_task") {
			throw new Error("Dirac instance aborted")
		}

		let askTs: number
		if (partial !== undefined) {
			const diracMessages = this.dependencies.messageStateHandler.getDiracMessages()
			// Search backwards for the last partial message of the same type and subtype
			let lastMessageIndex = -1
			for (let i = diracMessages.length - 1; i >= 0; i--) {
				const msg = diracMessages[i]
				if (msg.partial && msg.type === "ask" && msg.ask === type) {
					lastMessageIndex = i
					break
				}
			}
			const isUpdatingPreviousPartial = lastMessageIndex !== -1
			const lastMessage = isUpdatingPreviousPartial ? diracMessages[lastMessageIndex] : undefined

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// existing partial message, so update it
					await this.dependencies.messageStateHandler.updateDiracMessage(lastMessageIndex, {
						text,
						multiCommandState,
						partial,
						commandCompleted: false,
					})
					const protoMessage = convertDiracMessageToProto(lastMessage!)
					await sendPartialMessageEvent(protoMessage)
					await this.dependencies.postStateToWebview()
					return {
						response: this.dependencies.taskState.askResponse!,
						text: this.dependencies.taskState.askResponseText,
						images: this.dependencies.taskState.askResponseImages,
						files: this.dependencies.taskState.askResponseFiles,
						askTs: lastMessage!.ts,
					}
				}
				// this is a new partial message, so add it with partial state
				askTs = Date.now()
				this.dependencies.taskState.lastMessageTs = askTs
				await this.dependencies.messageStateHandler.addToDiracMessages({
					ts: askTs,
					type: "ask",
					ask: type,
					text,
					partial,
					multiCommandState,
				})
				await this.dependencies.postStateToWebview()
				return {
					response: this.dependencies.taskState.askResponse!,
					text: this.dependencies.taskState.askResponseText,
					images: this.dependencies.taskState.askResponseImages,
					files: this.dependencies.taskState.askResponseFiles,
					askTs,
				}
			}
			// partial=false means its a complete version of a previously partial message
			if (isUpdatingPreviousPartial) {
				// this is the complete version of a previously partial message, so replace the partial with the complete version
				this.dependencies.taskState.askResponse = undefined
				this.dependencies.taskState.askResponseText = undefined
				this.dependencies.taskState.askResponseImages = undefined
				this.dependencies.taskState.askResponseFiles = undefined

				askTs = lastMessage!.ts
				this.dependencies.taskState.lastMessageTs = askTs
				await this.dependencies.messageStateHandler.updateDiracMessage(lastMessageIndex, {
					text,
					partial: false,
					multiCommandState,
					commandCompleted: false,
				})
				const protoMessage = convertDiracMessageToProto(lastMessage!)
				await sendPartialMessageEvent(protoMessage)
				await this.dependencies.postStateToWebview()
			} else {
				// this is a new partial=false message, so add it like normal
				this.dependencies.taskState.askResponse = undefined
				this.dependencies.taskState.askResponseText = undefined
				this.dependencies.taskState.askResponseImages = undefined
				this.dependencies.taskState.askResponseFiles = undefined
				askTs = Date.now()
				this.dependencies.taskState.lastMessageTs = askTs
				await this.dependencies.messageStateHandler.addToDiracMessages({
					ts: askTs,
					type: "ask",
					ask: type,
					text,
					multiCommandState,
				})
				await this.dependencies.postStateToWebview()
			}
		} else {
			// this is a new non-partial message, so add it like normal
			this.dependencies.taskState.askResponse = undefined
			this.dependencies.taskState.askResponseText = undefined
			this.dependencies.taskState.askResponseImages = undefined
			this.dependencies.taskState.askResponseFiles = undefined
			askTs = Date.now()
			this.dependencies.taskState.lastMessageTs = askTs
			await this.dependencies.messageStateHandler.addToDiracMessages({
				ts: askTs,
				type: "ask",
				ask: type,
				text,
			})
			await this.dependencies.postStateToWebview()
		}

		// Notification hook marks that Dirac is waiting for user input.
		await this.runNotificationHook({
			event: "user_attention",
			source: type,
			message: text || "",
			waitingForUserInput: true,
		})

		await pWaitFor(
			() => {
				const response = this.dependencies.taskState.askResponse
				if (response !== undefined) {
				}
				return response !== undefined || this.dependencies.taskState.lastMessageTs !== askTs
			},
			{
				interval: 100,
			},
		)

		if (this.dependencies.taskState.lastMessageTs !== askTs) {
			throw new Error("Current ask promise was ignored")
		}

		const result = {
			response: this.dependencies.taskState.askResponse!,
			text: this.dependencies.taskState.askResponseText,
			images: this.dependencies.taskState.askResponseImages,
			files: this.dependencies.taskState.askResponseFiles,
		}

		this.dependencies.taskState.askResponse = undefined
		this.dependencies.taskState.askResponseText = undefined
		this.dependencies.taskState.askResponseImages = undefined
		this.dependencies.taskState.askResponseFiles = undefined
		return result
	}

	async runNotificationHook(notification: {
		event: string
		source: string
		message: string
		waitingForUserInput: boolean
	}): Promise<void> {
		const hooksEnabled = getHooksEnabledSafe(this.dependencies.stateManager.getGlobalSettingsKey("hooksEnabled"))
		if (!hooksEnabled) {
			return
		}

		try {
			await executeHook({
				hookName: "Notification",
				hookInput: {
					notification,
				},
				isCancellable: false,
				say: async () => undefined,
				messageStateHandler: this.dependencies.messageStateHandler,
				taskId: this.dependencies.taskId,
				hooksEnabled,
				model: getHookModelContext(this.dependencies.api, this.dependencies.stateManager),
			})
		} catch (error) {
			Logger.error("[Notification Hook] Failed (non-fatal):", error)
		}
	}

	async handleWebviewAskResponse(askResponse: DiracAskResponse, text?: string, images?: string[], files?: string[]) {
		this.dependencies.taskState.askResponse = askResponse
		this.dependencies.taskState.askResponseText = text
		this.dependencies.taskState.askResponseImages = images
		this.dependencies.taskState.askResponseFiles = files
	}

	async say(
		type: DiracSay,
		text?: string,
		images?: string[],
		files?: string[],
		partial?: boolean,
		multiCommandState?: MultiCommandState,
	): Promise<number | undefined> {
		// Allow hook messages even when aborted to enable proper cleanup
		if (this.dependencies.taskState.abort && type !== "hook_status" && type !== "hook_output_stream") {
			throw new Error("Dirac instance aborted")
		}

		const providerInfo = this.dependencies.getCurrentProviderInfo()
		const modelInfo = {
			providerId: providerInfo.providerId,
			modelId: providerInfo.model.id,
			mode: providerInfo.mode,
		}

		if (partial !== undefined) {
			const diracMessages = this.dependencies.messageStateHandler.getDiracMessages()
			// Search backwards for the last partial message of the same type and subtype
			let lastIndex = -1
			for (let i = diracMessages.length - 1; i >= 0; i--) {
				const msg = diracMessages[i]
				if (msg.partial && msg.type === "say" && msg.say === type) {
					lastIndex = i
					break
				}
			}
			const isUpdatingPreviousPartial = lastIndex !== -1
			const lastMessage = isUpdatingPreviousPartial ? diracMessages[lastIndex] : undefined

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// existing partial message, so update it
					await this.dependencies.messageStateHandler.updateDiracMessage(lastIndex, {
						text,
						multiCommandState,
						images,
						files,
						partial,
						commandCompleted: false,
					})
					const protoMessage = convertDiracMessageToProto(lastMessage!)
					await sendPartialMessageEvent(protoMessage)
					await this.dependencies.postStateToWebview()
					return lastMessage!.ts
				}
				// this is a new partial message, so add it with partial state
				const sayTs = Date.now()
				this.dependencies.taskState.lastMessageTs = sayTs
				await this.dependencies.messageStateHandler.addToDiracMessages({
					ts: sayTs,
					type: "say",
					say: type,
					text,
					images,
					files,
					partial,
					modelInfo,
					multiCommandState,
				})
				await this.dependencies.postStateToWebview()
				return sayTs
			}
			// partial=false means its a complete version of a previously partial message
			if (isUpdatingPreviousPartial) {
				// this is the complete version of a previously partial message, so replace the partial with the complete version
				this.dependencies.taskState.lastMessageTs = lastMessage!.ts
				await this.dependencies.messageStateHandler.updateDiracMessage(lastIndex, {
					text,
					images,
					files,
					partial: false,
					multiCommandState,
					commandCompleted: false,
				})
				const protoMessage = convertDiracMessageToProto(lastMessage!)
				await sendPartialMessageEvent(protoMessage)
				await this.dependencies.postStateToWebview()
				return undefined
			}
			// this is a new partial=false message, so add it like normal
			const sayTs = Date.now()
			this.dependencies.taskState.lastMessageTs = sayTs
			await this.dependencies.messageStateHandler.addToDiracMessages({
				ts: sayTs,
				type: "say",
				say: type,
				text,
				images,
				files,
				modelInfo,
				multiCommandState,
			})
			await this.dependencies.postStateToWebview()
			return sayTs
		}

		// this is a new non-partial message, so add it like normal
		const sayTs = Date.now()
		this.dependencies.taskState.lastMessageTs = sayTs
		await this.dependencies.messageStateHandler.addToDiracMessages({
			ts: sayTs,
			type: "say",
			say: type,
			text,
			images,
			files,
			modelInfo,
			multiCommandState,
		})
		await this.dependencies.postStateToWebview()
		return sayTs
	}

	async sayAndCreateMissingParamError(toolName: DiracDefaultTool, paramName: string, relPath?: string) {
		// Clear any partial UI state for this tool
		await this.removeLastPartialMessageIfExistsWithType("say", "tool")
		await this.removeLastPartialMessageIfExistsWithType("ask", "tool")

		await this.say(
			"error",
			`Dirac tried to use ${toolName}${relPath ? ` for '${relPath.toPosix()}'` : ""} without providing a value for '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}

	async removeLastPartialMessageIfExistsWithType(type: "ask" | "say", askOrSay: DiracAsk | DiracSay) {
		const diracMessages = this.dependencies.messageStateHandler.getDiracMessages()
		// Search backwards for the last partial message of the same type and subtype
		let indexToRemove = -1
		for (let i = diracMessages.length - 1; i >= 0; i--) {
			const msg = diracMessages[i]
			if (msg.partial && msg.type === type && (msg.ask === askOrSay || msg.say === askOrSay)) {
				indexToRemove = i
				break
			}
		}

		if (indexToRemove !== -1) {
			const newMessages = [...diracMessages]
			newMessages.splice(indexToRemove, 1)
			this.dependencies.messageStateHandler.setDiracMessages(newMessages)
			await this.dependencies.messageStateHandler.saveDiracMessagesAndUpdateHistory()
			await this.dependencies.postStateToWebview()
		}
	}
}
