
import { Card } from "../../../../shared/ExtensionMessage"

export type UIRendererType = "card" | "permission" | "progress" | "status" | "diff"

import type { ICardHandle } from "./IToolEnvironment"
export type { ICardHandle }


export interface IToolCallbacks {

	/** Invoke a modular renderer */
	/** Update a work unit (card) */
	updateCard: (card: Card) => Promise<void>


	/** Execute a shell command */
	executeCommand: (command: string, options?: { timeout?: number }) => Promise<[boolean, any]>

	/** Create a new work unit (card) */
	createCard: (params: import("./IToolEnvironment").CardParams) => Promise<ICardHandle>

}
