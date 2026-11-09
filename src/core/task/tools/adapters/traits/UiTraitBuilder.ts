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
			await config.taskMessenger.upsertText(text, isReasoning, undefined, undefined, role)
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
	if (config.taskMessenger.routesToOwner) return createTaskletPermissionCard(config, params, tracker)
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

	const request = createUtilityPermissionRequest(config, cardParams, binding.authorityMode)
	const decision = await binding.service.decide(request, config.taskState.abortSignal)
	config.taskState.abortSignal.throwIfAborted()
	if (isAutoApproved()) {
		return new ApprovedPermissionCardHandle(cardParams)
	}

	const currentBinding = config.permissionDecisionBinding
	if (!currentBinding || currentBinding.configurationRevision !== binding.configurationRevision ||
		currentBinding.commandPermissionRevision !== binding.commandPermissionRevision) {
		return createDisplayedCardFromMessenger(config, cardParams, tracker, true, isAutoApproved)
	}
	if (decision.decision === "escalate") {
		return createDisplayedCardFromMessenger(config, cardParams, tracker, true, isAutoApproved)
	}
	await publishPermissionApprovalCard(config, cardParams, tracker, request, decision.reason)
	config.taskState.abortSignal.throwIfAborted()
	const publishedBinding = config.permissionDecisionBinding
	if (!publishedBinding || publishedBinding.configurationRevision !== binding.configurationRevision ||
		publishedBinding.commandPermissionRevision !== binding.commandPermissionRevision) {
		return createDisplayedCardFromMessenger(config, cardParams, tracker, true, isAutoApproved)
	}
	return new ApprovedPermissionCardHandle(cardParams)
}

/** Only unresolved execute_command permissions may consult Utility before the owner. */
async function createTaskletPermissionCard(
	config: TaskConfig,
	params: CardParams,
	tracker: CardHandle[],
): Promise<ICardHandle> {
	if (params.operationalInput || (!params.requireApproval && params.permissionRequestKind === undefined)) {
		return createOwnerCard(config, params, tracker)
	}
	if (config.toolUse?.name !== "execute_command" || params.permissionOperation?.kind !== "commands") {
		return createOwnerCard(config, {
			...params,
			utilityPermissionSkipped: "This operation requires Dirac review before automatic approval.",
		}, tracker)
	}
	if (params.permissionRequestKind === "manual_tool") {
		return createOwnerCard(config, {
			...params,
			utilityPermissionSkipped: "Command restrictions require Dirac review; Utility cannot approve this request.",
		}, tracker)
	}
	const binding = config.permissionDecisionBinding
	if (!binding || params.permissionRequestKind !== "tool") {
		return createOwnerCard(config, {
			...params,
			utilityPermissionSkipped: !binding
				? "Utility permission handling is disabled or not fully configured."
				: "This request was not classified for Utility approval.",
		}, tracker)
	}

	const request = createUtilityPermissionRequest(config, params, binding.authorityMode)
	const decision = await binding.service.decide(request, config.taskState.abortSignal)
	config.taskState.abortSignal.throwIfAborted()
	const currentBinding = config.permissionDecisionBinding
	if (!currentBinding || currentBinding.configurationRevision !== binding.configurationRevision ||
		currentBinding.commandPermissionRevision !== binding.commandPermissionRevision) {
		return createOwnerCard(config, {
			...params,
			utilityPermissionEscalation: "Permission settings changed during evaluation; approval requires a new authority check.",
		}, tracker)
	}
	if (decision.decision === "escalate") {
		return createOwnerCard(config, { ...params, utilityPermissionEscalation: decision.reason }, tracker)
	}
	await publishPermissionApprovalCard(config, params, tracker, request, decision.reason)
	config.taskState.abortSignal.throwIfAborted()
	const publishedBinding = config.permissionDecisionBinding
	if (!publishedBinding || publishedBinding.configurationRevision !== binding.configurationRevision ||
		publishedBinding.commandPermissionRevision !== binding.commandPermissionRevision) {
		return createOwnerCard(config, {
			...params,
			utilityPermissionEscalation: "Permission settings changed during approval publication; approval requires a new authority check.",
		}, tracker)
	}
	return new ApprovedPermissionCardHandle(params)
}

function isUnrestrictedToolApproval(config: TaskConfig): boolean {
	return config.autoApprover.isUnrestrictedAutoApprove()
}

function createUtilityPermissionRequest(
	config: TaskConfig,
	params: CardParams,
	authorityMode: UtilityPermissionRequest["runtime"]["mode"],
): UtilityPermissionRequest {
	const toolName = config.toolUse?.name ?? params.toolName ?? "unknown"
	const includesResolvedDiffs = toolName === "edit_file" || toolName === "edit_ast"
	return {
		toolCall: {
			name: toolName,
			arguments: structuredClone(config.toolUse?.params ?? {}),
		},
		permission: {
			header: params.header,
			...(params.permissionOperation ? { operation: structuredClone(params.permissionOperation) } : {}),
			...(params.locations ? { locations: structuredClone(params.locations) } : {}),
			...(includesResolvedDiffs && params.diffs ? { diffs: structuredClone(params.diffs) } : {}),
		},
		runtime: {
			cwd: config.cwd,
			mode: authorityMode,
			isSubagent: config.executionProfile === "tasklet",
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
	const actor = config.executionProfile === "tasklet" ? config.taskId : "Dirac"
	await createDisplayedCardFromMessenger(
		config,
		{
			header: `${actor} · Auto-approved`,
			toolName: "permission_approval",
			icon: DiracIcon.PERMISSION_APPROVAL,
			status: CardStatus.SUCCESS,
			renderType: "markdown",
			body: `**Decision:** Approved\n\n**Source:** Utility permission policy\n\n**Reason:** ${reason}\n\n### Requested operation\n\n${params.body ?? params.header}`,
			...(config.executionProfile === "tasklet" ? { communication: { actor } } : {}),
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
	if (config.taskMessenger.routesToOwner) return createOwnerCard(config, params, tracker)
	const { permissionRequestKind: _permissionRequestKind, ...cardParams } = params
	return createDisplayedCardFromMessenger(config, cardParams, tracker, false)
}

async function createOwnerCard(config: TaskConfig, params: CardParams, tracker: CardHandle[]): Promise<ICardHandle> {
	const handle = await config.taskMessenger.createCard({
		...params,
		isAutoApproved: undefined,
		permissionOperation:
			params.permissionOperation ??
			(!params.operationalInput && (params.requireApproval || params.permissionRequestKind)
				? { kind: "tool", manualOnly: params.permissionRequestKind === "manual_tool" }
				: undefined),
		toolCall: config.toolUse ? { name: config.toolUse.name, arguments: structuredClone(config.toolUse.params) } : undefined,
	})
	const adapterHandle = new CardHandle(handle, undefined, undefined, true)
	tracker.push(adapterHandle)
	return adapterHandle
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
