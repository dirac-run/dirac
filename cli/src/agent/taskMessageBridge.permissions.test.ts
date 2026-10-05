import { EventEmitter } from "node:events"
import type * as acp from "@agentclientprotocol/sdk"
import { TaskMessenger } from "@core/task/TaskMessenger"
import { TaskState } from "@core/task/TaskState"
import { submitCardResponse } from "@core/task/TaskUserInput"
import { ToolSkippedByUserMessage } from "@core/task/tools/types/ToolSkippedByUserMessage"
import { CardStatus, DiracMessageType, type DiracMessage } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { describe, expect, it, vi } from "vitest"
import { AcpSessionStatus } from "./public-types.js"
import { TaskMessageBridge } from "./taskMessageBridge.js"

// Exercise task response storage and ACP forwarding together, without an LLM or subprocess.
describe("TaskMessageBridge immediate permission responses", () => {
	it.each([
		["allow_once", DiracAskResponse.APPROVE, CardStatus.SUCCESS],
		["reject_once", DiracAskResponse.REJECT, CardStatus.CANCELLED],
		["message", DiracAskResponse.MESSAGE, CardStatus.SKIPPED],
	] as const)("finishes the prompt after an immediate %s response", async (optionId, expectedResponse, finalStatus) => {
		const taskState = new TaskState()
		const messages: DiracMessage[] = []
		let releaseCreation!: () => void
		const creationGate = new Promise<void>((resolve) => {
			releaseCreation = resolve
		})
		let finishTask!: () => void
		const taskRunPromise = new Promise<void>((resolve) => {
			finishTask = resolve
		})

		const messageStateHandler = Object.assign(new EventEmitter(), {
			addToDiracMessages: vi.fn(async (message: DiracMessage) => {
				messages.push(message)
				messageStateHandler.emit("diracMessagesChanged", { type: "add", message, messages })
				// Let ACP observe creation before the tool receives its card handle.
				await creationGate
			}),
			getMessageById: vi.fn((id: string) => messages.find((message) => message.id === id)),
			findMessageIndexByCardId: (id: string) =>
				messages.findIndex((message) => message.content.type === DiracMessageType.CARD && message.content.card.id === id),
			getDiracMessages: () => messages,
			flushPendingWrites: async () => {},
			publishCardInteractionReady: vi.fn((id: string) => {
				messageStateHandler.emit(
					"cardInteractionReady",
					messages.find((message) => message.id === id),
				)
			}),
			patchCardById: async (id: string, patch: Record<string, unknown>) => {
				const message = messages.find((candidate) => candidate.id === id)!
				if (message.content.type !== DiracMessageType.CARD) throw new Error("Expected a card")
				Object.assign(message.content.card, patch)
				messageStateHandler.emit("diracMessagesChanged", { type: "update", message, messages })
				return message.content.card
			},
		})
		const task = {
			taskState,
			messageStateHandler,
			submitCardResponse: vi.fn(
				async (
					cardId: string,
					response: DiracAskResponse | string,
					text?: string,
					images?: string[],
					files?: string[],
					value?: string,
				) => submitCardResponse({ taskState }, { cardId, response, text, images, files, value }),
			),
		}
		const controller = { task } as any
		const messenger = new TaskMessenger({
			taskState,
			messageStateHandler,
			postStateToWebview: async () => {},
			getWorkingConfiguration: () => ({ settings: { hooksEnabled: false }, apiConfiguration: {} }),
			getCurrentProviderInfo: vi.fn(),
			taskId: "task-1",
		} as any)
		const requestPermission = vi.fn(
			async () =>
				({
					outcome: { outcome: "selected", optionId, data: { text: "Use another command" } },
				}) as acp.RequestPermissionResponse,
		)
		const bridge = new TaskMessageBridge({
			getSession: () => ({}) as any,
			getController: () => controller,
			requestPermission,
			emitSessionUpdate: vi.fn().mockResolvedValue(undefined),
			getClientCapabilities: () => ({}),
			requestElicitation: vi.fn(),
			persistPermissionRule: vi.fn(),
		})
		const cleanupFunctions: Array<() => void> = []
		const prompt = new Promise<acp.PromptResponse>((resolve, reject) => {
			bridge.subscribeToTaskMessages(
				controller,
				"session-1",
				{ sessionId: "session-1", status: AcpSessionStatus.Processing, pendingToolCalls: new Map() },
				resolve,
				reject,
				{ value: false },
				cleanupFunctions,
				taskRunPromise,
			)
		})
		let interaction: Promise<{ response: DiracAskResponse; text?: string }> | undefined
		let interactionTimer: ReturnType<typeof setTimeout> | undefined

		try {
			const creating = messenger.createCard({
				header: "Execute command?",
				rawInput: { command: "echo ok" },
				requireApproval: true,
			})
			await vi.waitFor(() => expect(messageStateHandler.getMessageById).toHaveBeenCalled())
			expect(taskState.lastWaitingCardId).toBeUndefined()
			expect(requestPermission).not.toHaveBeenCalled()

			releaseCreation()
			const card = await creating
			interactionTimer = setTimeout(() => {
				taskState.abort = true
			}, 1500)
			interaction = card.waitForInteraction().catch((error) => {
				if (!(error instanceof ToolSkippedByUserMessage)) throw error
				return { response: DiracAskResponse.MESSAGE, text: error.userMessage }
			})

			const result = await interaction
			expect(result.response).toBe(expectedResponse)
			if (expectedResponse === DiracAskResponse.MESSAGE) expect(result.text).toBe("Use another command")
			await card.finalize(finalStatus)
			finishTask()

			await expect(prompt).resolves.toEqual({ stopReason: "end_turn" })
			expect(requestPermission).toHaveBeenCalledTimes(1)
			expect(task.submitCardResponse).toHaveBeenCalledTimes(1)
			expect(taskState.waitingCardIds).toEqual([])
			expect(taskState.askResponseCardId).toBeUndefined()
		} finally {
			taskState.abort = true
			bridge.invalidatePendingInteractions()
			releaseCreation()
			clearTimeout(interactionTimer)
			finishTask()
			await interaction?.catch(() => undefined)
			await bridge.waitForMessageWork()
			await prompt.catch(() => undefined)
			cleanupFunctions.forEach((cleanup) => cleanup())
		}
	})
})
