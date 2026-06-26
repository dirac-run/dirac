import { DiracAskResponse } from "@shared/WebviewMessage"
import type { IUITrait, IInteractionTrait, ICardHandle, CardParams } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"
import { CardHandle } from "../CardHandle"

// Builds the UI trait — text streaming and card creation.
export function buildUiTrait(config: TaskConfig, createCardFn: (params: CardParams) => Promise<ICardHandle>): IUITrait {
	return {
		createCard: createCardFn,
		upsertText: async (text: string, isReasoning?: boolean, role?: "user" | "assistant") => {
			await config.taskMessenger.upsertText(text, isReasoning, undefined, undefined, role)
		},
		streamText: async (type: "markdown" | "reasoning") => {
			return await config.taskMessenger.streamText(type)
		},
	}
}

// Builds the interaction trait — permission requests via cards.
export function buildInteractionTrait(config: TaskConfig, createCardFn: (params: CardParams) => Promise<ICardHandle>): IInteractionTrait {
	return {
		askPermission: async (message: string) => {
			const card = await createCardFn({
				header: "Permission Request",
				body: message,
				requireApproval: true,
				collapsed: false,
			})
			const result = await card.waitForInteraction()
			return {
				approved: result.action === DiracAskResponse.APPROVE,
				action: result.action,
				value: result.value,
				text: result.text,
				images: result.images as string[] | undefined,
				files: result.files as string[] | undefined,
				userEdits: result.userEdits,
				card,
			}
		},
	}
}

// Creates a card via taskMessenger and wraps the protocol handle in a CardHandle.
export async function createCardFromMessenger(config: TaskConfig, params: CardParams, tracker: CardHandle[]): Promise<ICardHandle> {
	const handle = await config.taskMessenger.createCard(params)
	const adapterHandle = new CardHandle(handle, params)
	tracker.push(adapterHandle)
	return adapterHandle
}
