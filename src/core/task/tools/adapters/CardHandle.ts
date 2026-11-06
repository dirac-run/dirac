import { DiracAskResponse } from "@shared/WebviewMessage"
import { Card, CardStatus } from "../../../../shared/ExtensionMessage"
import type { TaskCardHandle } from "../../TaskMessenger"
import { ICardHandle } from "../interfaces/IToolEnvironment"

export class CardHandle implements ICardHandle {
	constructor(
		private readonly protocolHandle: TaskCardHandle,
		private readonly autoApprovedAction?: string,
		private readonly liveAutoApprovedAction?: () => string | undefined,
		private readonly routesToOwner = false,
	) {}

	private get card(): Readonly<Card> {
		return this.protocolHandle.getCard()
	}

	get id() {
		return this.card.id
	}
	get header() {
		return this.card.header
	}
	get toolName() {
		return this.card.toolName
	}
	get icon() {
		return this.card.icon
	}
	get status() {
		return this.card.status
	}
	get renderType() {
		return this.card.renderType
	}
	get body() {
		return this.card.body ?? ""
	}
	get rawInput() {
		return this.card.rawInput
	}
	get rawOutput() {
		return this.card.rawOutput
	}
	get diffs() {
		return this.card.diffs
	}
	get locations() {
		return this.card.locations
	}
	get requireApproval() {
		return this.card.requireApproval
	}
	get requireFeedback() {
		return this.card.requireFeedback
	}
	get feedbackPlaceholder() {
		return this.card.feedbackPlaceholder
	}
	get actions() {
		return this.card.actions
	}
	get collapsed() {
		return this.card.collapsed ?? true
	}
	get maxHeight() {
		return this.card.maxHeight
	}
	get cleanupStrategy() {
		return this.card.cleanupStrategy
	}
	get do_not_auto_collapse() {
		return this.card.do_not_auto_collapse
	}
	get startTime() {
		return this.card.startTime
	}
	get endTime() {
		return this.card.endTime
	}
	get outcome() {
		return this.card.outcome
	}
	get requiresUserInteraction() {
		return (
			!this.routesToOwner &&
			this.approvedAction() === undefined &&
			this.status === CardStatus.WAITING_FOR_INPUT &&
			!!(this.requireApproval || this.requireFeedback)
		)
	}

	private approvedAction(): string | undefined {
		return this.autoApprovedAction ?? this.liveAutoApprovedAction?.()
	}

	public toData(): import("../../../../shared/ExtensionMessage").Card {
		return structuredClone(this.card)
	}

	public async update(patch: Partial<Omit<Card, "id">>): Promise<void> {
		await this.protocolHandle.update(patch)
	}

	public async appendBody(chunk: string): Promise<void> {
		await this.protocolHandle.appendBody(chunk)
	}
	public async finalize(status: CardStatus, doNotAutoCollapse?: boolean): Promise<void> {
		await this.protocolHandle.finalize(status, doNotAutoCollapse)
	}

	public async waitForInteraction(): Promise<{
		action: string
		response: DiracAskResponse
		value?: string
		text?: string
		images?: string[]
		files?: string[]
		userEdits?: Record<string, string>
	}> {
		const approvedAction = this.approvedAction()
		if (approvedAction !== undefined) {
			return {
				action: approvedAction,
				response: DiracAskResponse.APPROVE,
				value: approvedAction,
			}
		}

		const result = await this.protocolHandle.waitForInteraction()

		let action = result.action || (result.response as string)
		let value = result.value

		if (result.text && !value) {
			const actionValue = result.text
			const isAction = this.actions?.some((a) => a.value === actionValue)
			if (isAction) {
				action = actionValue
			} else {
				action = "submit"
				value = actionValue
			}
		}

		return {
			action,
			response: result.response,
			value,
			text: result.text,
			images: result.images,
			files: result.files,
			userEdits: result.userEdits,
		}
	}
}
