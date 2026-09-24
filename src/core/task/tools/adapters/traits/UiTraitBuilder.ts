import type { UtilityPermissionRequest } from "@core/permissions/UtilityPermissionDecisionService"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { CardStatus, isFinalStatus } from "@shared/ExtensionMessage"
import { DiracIcon } from "@shared/icons"
import type { IUITrait, IInteractionTrait, ICardHandle, CardParams } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"
import { CardHandle } from "../CardHandle"
import { ApprovedPermissionCardHandle } from "../ApprovedPermissionCardHandle"

// Builds the UI trait — text streaming and card creation.
export function buildUiTrait(
	config: TaskConfig,
	createCardFn: (params: CardParams) => Promise<ICardHandle>,
	createManualInteractionCardFn: (params: CardParams) => Promise<ICardHandle>,
): IUITrait {
	return {
		createCard: createCardFn,
		createManualInteractionCard: createManualInteractionCardFn,
		upsertText: async (text: string, isReasoning?: boolean, role?: "user" | "assistant") => {
			const visibleText = config.agentIdentity && role !== "user" ? `**${config.agentIdentity.name}:** ${text}` : text
			await config.taskMessenger.upsertText(visibleText, isReasoning, undefined, undefined, role, config.agentIdentity)
		},
		streamText: async (type: "markdown" | "reasoning") => {
			return await config.taskMessenger.streamText(type)
		},
		publishState: async () => await config.callbacks.postStateToWebview(),
	}
}

export function buildInteractionTrait(
	config: TaskConfig,
	createCardFn: (params: CardParams) => Promise<ICardHandle>,
): IInteractionTrait {
	return {
		askPermission: (message, preview) => askPermissionOnCard(createCardFn, message, preview),
	}
}

// Shared by every IInteractionTrait (task and Goal child): shows the permission card,
// waits for the answer, and finalizes the card.
export async function askPermissionOnCard(
	createCardFn: (params: CardParams) => Promise<ICardHandle>,
	...[message, preview]: Parameters<IInteractionTrait["askPermission"]>
): ReturnType<IInteractionTrait["askPermission"]> {
	const card = await createCardFn({
		header: "Permission Request",
		body: message,
		requireApproval: true,
		permissionRequestKind: preview?.manualOnly ? "manual_tool" : "tool",
		collapsed: false,
		...(preview?.diffs ? { diffs: preview.diffs, renderType: "diff" } : {}),
		...(preview?.rawInput ? { rawInput: preview.rawInput } : {}),
	})
	const result = await card.waitForInteraction()
	// Finalize here, not in the tool. ToolExecutorCoordinator throws
	// "left nonterminal card(s)" on any card still WAITING_FOR_INPUT when the tool
	// returns, and a custom tool has no reason to know that — every custom tool that
	// asked for permission and was answered by hand hit it.
	// Mirrors WriteToFileTool: a message instead of an answer is SKIPPED.
	if (!isFinalStatus(card.status)) {
		if (result.action === DiracAskResponse.MESSAGE) {
			await card.finalize(CardStatus.SKIPPED)
		} else {
			await card.finalize(result.action === DiracAskResponse.APPROVE ? CardStatus.SUCCESS : CardStatus.CANCELLED)
		}
	}
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
}

// Resolves explicitly classified tool permissions before falling back to the displayed-card path.
export async function createCardFromMessenger(
	config: TaskConfig,
	params: CardParams,
	tracker: CardHandle[],
): Promise<ICardHandle> {
	const { permissionRequestKind, ...cardParams } = params
	if (permissionRequestKind === undefined) {
		return createDisplayedCardFromMessenger(config, cardParams, tracker)
	}

	const isAutoApproved = () => isUnrestrictedToolApproval(config)
	if (isAutoApproved()) {
		return new ApprovedPermissionCardHandle(cardParams)
	}
	if (permissionRequestKind === "manual_tool") {
		return createDisplayedCardFromMessenger(config, cardParams, tracker, false, isAutoApproved)
	}

	const binding = config.permissionDecisionBinding
	if (!binding) return createDisplayedCardFromMessenger(config, cardParams, tracker, true, isAutoApproved)

	const request = createUtilityPermissionRequest(config, cardParams)
	const decision = await binding.service.decide(request, config.taskState.abortSignal)
	if (isAutoApproved()) {
		return new ApprovedPermissionCardHandle(cardParams)
	}

	const currentBinding = config.permissionDecisionBinding
	if (!currentBinding || currentBinding.configurationRevision !== binding.configurationRevision) {
		return createDisplayedCardFromMessenger(config, cardParams, tracker, true, isAutoApproved)
	}
	if (decision.decision === "escalate") {
		return createDisplayedCardFromMessenger(config, cardParams, tracker, true, isAutoApproved)
	}
	await publishPermissionApprovalCard(config, cardParams, tracker, request, decision.reason)
	return new ApprovedPermissionCardHandle(cardParams)
}

function isUnrestrictedToolApproval(config: TaskConfig): boolean {
	return config.autoApprover.isUnrestrictedAutoApprove()
}

function createUtilityPermissionRequest(config: TaskConfig, params: CardParams): UtilityPermissionRequest {
	const toolName = config.toolUse?.name ?? params.toolName ?? "unknown"
	const includesResolvedDiffs = toolName === "edit_file" || toolName === "edit_ast"
	return {
		toolCall: {
			name: toolName,
			arguments: structuredClone(config.toolUse?.params ?? {}),
		},
		permission: {
			header: params.header,
			...(params.locations ? { locations: structuredClone(params.locations) } : {}),
			...(includesResolvedDiffs && params.diffs ? { diffs: structuredClone(params.diffs) } : {}),
		},
		runtime: {
			cwd: config.cwd,
			mode: config.mode,
			isSubagent: config.isSubagentExecution,
		},
	}
}

async function publishPermissionApprovalCard(
	config: TaskConfig,
	params: CardParams,
	tracker: CardHandle[],
	request: UtilityPermissionRequest,
	reason: string,
): Promise<void> {
	await createDisplayedCardFromMessenger(
		config,
		{
			header: `Auto Approved · ${params.header}`,
			toolName: "permission_approval",
			icon: DiracIcon.PERMISSION_APPROVAL,
			status: CardStatus.SUCCESS,
			renderType: "markdown",
			body: `**Result:** Auto Approved by permission agent\n\n**Reason:** ${reason}`,
			rawInput: { tool: request.toolCall.name },
			rawOutput: { decision: "approve", reason, approvedTool: request.toolCall.name },
			locations: params.locations,
			collapsed: true,
		},
		tracker,
		false,
	)
}
/** Creates a displayed interaction that bypasses every automatic approval policy. */
export async function createManualInteractionCardFromMessenger(
	config: TaskConfig,
	params: CardParams,
	tracker: CardHandle[],
): Promise<ICardHandle> {
	const { permissionRequestKind: _permissionRequestKind, ...cardParams } = params
	return createDisplayedCardFromMessenger(config, cardParams, tracker, false)
}

// Creates a card via taskMessenger and wraps the protocol handle in a CardHandle.
async function createDisplayedCardFromMessenger(
	config: TaskConfig,
	params: CardParams,
	tracker: CardHandle[],
	allowYoloAutoApproval = true,
	isAutoApproved?: () => boolean,
): Promise<ICardHandle> {
	const autoApprovedAction =
		params.requireApproval && ((allowYoloAutoApproval && config.yoloModeToggled) || isAutoApproved?.())
			? (params.actions?.find((candidate) => candidate.primary)?.value ?? DiracAskResponse.APPROVE)
			: undefined
	const liveAutoApprovedAction = isAutoApproved
		? () =>
			isAutoApproved()
				? (params.actions?.find((candidate) => candidate.primary)?.value ?? DiracAskResponse.APPROVE)
				: undefined
		: undefined
	const displayedParams = autoApprovedAction
		? {
			...params,
			status: params.status === CardStatus.WAITING_FOR_INPUT ? CardStatus.RUNNING : params.status,
			requireApproval: false,
			requireFeedback: false,
			feedbackPlaceholder: undefined,
			actions: undefined,
		}
		: params
	const messengerParams = !autoApprovedAction && isAutoApproved ? { ...displayedParams, isAutoApproved } : displayedParams
	const handle = await config.taskMessenger.createCard(messengerParams)
	const adapterHandle = new CardHandle(handle, autoApprovedAction, liveAutoApprovedAction)
	tracker.push(adapterHandle)
	return adapterHandle
}
