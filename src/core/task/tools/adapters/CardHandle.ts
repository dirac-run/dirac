import {
	CardStatus,
	ICardHandle as IProtocolCardHandle,
	RenderType,
	ActionButton,
	CardLocation,
	CleanupStrategy,
	Card,
} from "../../../../shared/ExtensionMessage"
import { ICardHandle, CardParams } from "../interfaces/IToolEnvironment"
import { DiracAskResponse } from "@shared/WebviewMessage"

export class CardHandle implements ICardHandle {
	public header: string
	public icon?: string
	public status: CardStatus = CardStatus.PENDING
	public renderType: RenderType = "text"
	public body = ""

	public rawInput?: import("../../../../shared/ExtensionMessage").CardRawInput
	public rawOutput?: import("../../../../shared/ExtensionMessage").CardRawOutput
	public diffs?: import("../../../../shared/ExtensionMessage").CardDiff[]
	public locations?: CardLocation[]
	public requireApproval?: boolean
	public requireFeedback?: boolean
	public feedbackPlaceholder?: string
	public actions?: ActionButton[]
	public collapsed = true
	public maxHeight?: number
	public cleanupStrategy?: CleanupStrategy
	public do_not_auto_collapse?: boolean
	public startTime?: number
	public endTime?: number
	public outcome?: string

	public readonly id: string

	constructor(
		private protocolHandle: IProtocolCardHandle,
		params: CardParams,
	) {
		this.id = protocolHandle.id
		this.header = params.header
		this.icon = params.icon
		this.status = params.status || CardStatus.RUNNING
		this.renderType = params.renderType || "text"
		this.body = params.body || ""

		this.rawInput = params.rawInput
		this.rawOutput = params.rawOutput
		this.diffs = params.diffs
		this.locations = params.locations
		this.requireApproval = params.requireApproval
		this.requireFeedback = params.requireFeedback
		this.feedbackPlaceholder = params.feedbackPlaceholder
		this.actions = params.actions
		this.collapsed = params.collapsed ?? true
		this.maxHeight = params.maxHeight
		this.cleanupStrategy = params.cleanupStrategy
		this.do_not_auto_collapse = params.do_not_auto_collapse
		this.outcome = params.outcome
	}

	public toData(): import("../../../../shared/ExtensionMessage").Card {
		return {
			id: this.id,
			header: this.header,
			icon: this.icon,
			status: this.status,
			renderType: this.renderType,
			body: this.body,

			rawInput: this.rawInput,
			rawOutput: this.rawOutput,
			diffs: this.diffs,
			locations: this.locations,
			requireApproval: this.requireApproval,
			requireFeedback: this.requireFeedback,
			feedbackPlaceholder: this.feedbackPlaceholder,
			actions: this.actions,
			collapsed: this.collapsed,
			maxHeight: this.maxHeight,
			cleanupStrategy: this.cleanupStrategy,
			do_not_auto_collapse: this.do_not_auto_collapse,
			startTime: this.startTime,
			endTime: this.endTime,
			outcome: this.outcome,
		}
	}

	public async update(patch: Partial<Omit<Card, "id">>): Promise<void> {
		if (patch.header !== undefined) this.header = patch.header
		if (patch.icon !== undefined) this.icon = patch.icon
		if (patch.status !== undefined) this.status = patch.status
		if (patch.renderType !== undefined) this.renderType = patch.renderType
		if (patch.body !== undefined) this.body = patch.body

		if (patch.rawInput !== undefined) this.rawInput = patch.rawInput
		if (patch.rawOutput !== undefined) this.rawOutput = patch.rawOutput
		if (patch.diffs !== undefined) this.diffs = patch.diffs
		if (patch.locations !== undefined) this.locations = patch.locations
		if (patch.requireApproval !== undefined) this.requireApproval = patch.requireApproval
		if (patch.requireFeedback !== undefined) this.requireFeedback = patch.requireFeedback
		if (patch.feedbackPlaceholder !== undefined) this.feedbackPlaceholder = patch.feedbackPlaceholder
		if (patch.actions !== undefined) this.actions = patch.actions
		if (patch.collapsed !== undefined) this.collapsed = patch.collapsed
		if (patch.maxHeight !== undefined) this.maxHeight = patch.maxHeight
		if (patch.cleanupStrategy !== undefined) this.cleanupStrategy = patch.cleanupStrategy
		if (patch.do_not_auto_collapse !== undefined) this.do_not_auto_collapse = patch.do_not_auto_collapse
		if (patch.outcome !== undefined) this.outcome = patch.outcome
		if (patch.startTime !== undefined) this.startTime = patch.startTime
		if (patch.endTime !== undefined) this.endTime = patch.endTime

		await this.protocolHandle.update(patch as any)
	}

	public async appendBody(chunk: string): Promise<void> {
		this.body += chunk
		await this.protocolHandle.appendBody(chunk)
	}
	public async finalize(status: CardStatus, doNotAutoCollapse?: boolean): Promise<void> {
		this.status = status
		this.endTime = Date.now()
		if (doNotAutoCollapse) {
			this.do_not_auto_collapse = true
		}
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
