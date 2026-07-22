import type * as acp from "@agentclientprotocol/sdk";
import type { DiracMessageChange } from "@core/task/message-state";
import {
	CardStatus,
	DiracMessage,
	DiracMessageType,
} from "@shared/ExtensionMessage";
import { DiracAskResponse } from "@shared/WebviewMessage";
import { Controller } from "@/core/controller";
import { Logger } from "@/shared/services/Logger.js";
import {
	parseWebSearchMarkerText,
	translateMessage,
} from "./messageTranslator.js";
import { handlePermissionResponse } from "./permissionHandler.js";
import type { DiracAcpSession } from "./public-types.js";
import type { AcpSessionState } from "./types.js";
import { isFollowupQuestionCard } from "./questionCard.js";

type PromptResolver = (response: acp.PromptResponse) => void;


type UsageSnapshot = {
	inputTokens: number;
	outputTokens: number;
	cachedReadTokens: number;
	cachedWriteTokens: number;
	thoughtTokens: number;
	cost: number;
	hasInputTokens: boolean;
	hasOutputTokens: boolean;
	hasCachedReadTokens: boolean;
	hasCachedWriteTokens: boolean;
	hasThoughtTokens: boolean;
	hasCost: boolean;
};

type ContextUsage = {
	used: number;
	size: number;
};

const OTHER_ANSWER_OPTION_ID = "__dirac_other_answer";

type TaskMessageBridgeOptions = {
	getSession: (sessionId: string) => DiracAcpSession | undefined;
	getController: (session: DiracAcpSession) => Controller | undefined;
	requestPermission: (
		sessionId: string,
		toolCall: unknown,
		options?: acp.PermissionOption[],
	) => Promise<acp.RequestPermissionResponse>;
	emitSessionUpdate: (
		sessionId: string,
		update: acp.SessionUpdate,
	) => Promise<void>;
	getClientCapabilities: () => acp.ClientCapabilities | undefined;
	requestElicitation: (
		request: acp.CreateElicitationRequest,
	) => Promise<acp.CreateElicitationResponse>;

	getWhispers: (sessionId: string) => string[];
	clearWhispers: (sessionId: string) => void;
	persistPermissionRule: (
		sessionId: string,
		toolCall: acp.ToolCall | acp.ToolCallUpdate,
		action: "allow" | "deny",
	) => Promise<void>;
};

export class TaskMessageBridge {
	private readonly getSession: TaskMessageBridgeOptions["getSession"];
	private readonly getController: TaskMessageBridgeOptions["getController"];
	private readonly requestPermission: TaskMessageBridgeOptions["requestPermission"];
	private readonly emitSessionUpdate: TaskMessageBridgeOptions["emitSessionUpdate"];
	private readonly getClientCapabilities: TaskMessageBridgeOptions["getClientCapabilities"];
	private readonly requestElicitation: TaskMessageBridgeOptions["requestElicitation"];

	private readonly getWhispers: TaskMessageBridgeOptions["getWhispers"];
	private readonly clearWhispers: TaskMessageBridgeOptions["clearWhispers"];
	private readonly persistPermissionRule: TaskMessageBridgeOptions["persistPermissionRule"];

	/** Track last sent content for partial messages to compute deltas */
	private readonly partialMessageLastContent: Map<number, string> = new Map();

	/**
	 * Accumulated streamed text for message subtypes whose final (non-partial)
	 * emission arrives under a NEW ts, keyed by a stable per-subtype string.
	 *
	 * Two distinct mechanisms produce this ts change mid-stream:
	 *   - completion_result: AttemptCompletionHandler delete-and-replaces the message
	 *     (partial ts=T1 removed, fresh non-partial ts=T2 created).
	 *   - followup / plan_mode_respond: the tool handler issues the final ask() with
	 *     partial=undefined, which TaskMessenger.ask() stores under a fresh Date.now()
	 *     ts rather than reusing the streaming partial's ts.
	 *
	 * In both cases the ts-keyed partialMessageLastContent sees "" for the new ts and
	 * re-emits the full text, duplicating it. Accumulating under a stable subtype key
	 * bridges the gap so the delta computes correctly. Keys: "completion_result",
	 * "followup", "plan_mode_respond". Cleared at the start of each prompt cycle.
	 */
	private readonly tsUnstableStreamLastContent: Map<string, string> = new Map();

	/** Map message timestamps to toolCallIds to avoid creating duplicate tool calls during streaming */
	private readonly messageToToolCallId: Map<number, string> = new Map();

	/** Track waiting cards already delivered to ACP interaction IO during the active prompt turn. */
	private readonly processedInteractionCardKeys: Set<string> = new Set();
	/** Terminal card updates may be delivered repeatedly; incorporate guidance once per card. */
	private readonly whisperBoundaryCardKeys: Set<string> = new Set();
	/** Serialize asynchronous message translation and interaction handling. */
	private messageWork = Promise.resolve();
	/** Invalidates interaction responses that belong to a cancelled prompt turn. */
	private interactionGeneration = 0;

	/** Latest cumulative snapshot for every model request observed in this ACP session. */
	private readonly usageSnapshots = new Map<string, UsageSnapshot>();
	/** Most recent context occupancy reported by the active model request. */
	private contextUsage?: ContextUsage;

	constructor(options: TaskMessageBridgeOptions) {
		this.getSession = options.getSession;
		this.getController = options.getController;
		this.requestPermission = options.requestPermission;
		this.emitSessionUpdate = options.emitSessionUpdate;
		this.getClientCapabilities = options.getClientCapabilities;
		this.requestElicitation = options.requestElicitation;

		this.getWhispers = options.getWhispers;
		this.clearWhispers = options.clearWhispers;
		this.persistPermissionRule = options.persistPermissionRule;
	}

	private queueMessageWork(
		work: () => Promise<void>,
		sessionId: string,
		resolvePrompt: PromptResolver,
		promptResolved: { value: boolean },
	): Promise<void> {
		const queued = this.messageWork.then(work);
		this.messageWork = queued.catch(() => undefined);
		return queued.catch((error) => {
			this.handleUnhandledHandlerError(
				sessionId,
				promptResolved,
				resolvePrompt,
				error,
			);
		});
	}

	clearPromptState(): void {
		this.partialMessageLastContent.clear();
		this.tsUnstableStreamLastContent.clear();
		this.messageToToolCallId.clear();
		this.processedInteractionCardKeys.clear();
		this.whisperBoundaryCardKeys.clear();
	}


	promptResponse(stopReason: acp.StopReason): acp.PromptResponse {
		const usage = this.sessionTokenUsage();
		return usage ? { stopReason, usage } : { stopReason };
	}

	async restoreUsage(sessionId: string, messages: DiracMessage[], emitCurrentContext: boolean): Promise<void> {
		this.usageSnapshots.clear();
		this.contextUsage = undefined;
		for (const message of messages) {
			await this.recordUsage(sessionId, message, false);
		}
		if (emitCurrentContext) {
			await this.emitContextUsage(sessionId);
		}
	}

	private sessionTokenUsage(): acp.Usage | undefined {
		let inputTokens = 0;
		let outputTokens = 0;
		let cachedReadTokens = 0;
		let cachedWriteTokens = 0;
		let thoughtTokens = 0;
		let hasInputTokens = false;
		let hasOutputTokens = false;
		let hasCachedReadTokens = false;
		let hasCachedWriteTokens = false;
		let hasThoughtTokens = false;

		for (const snapshot of this.usageSnapshots.values()) {
			inputTokens += snapshot.inputTokens;
			outputTokens += snapshot.outputTokens;
			cachedReadTokens += snapshot.cachedReadTokens;
			cachedWriteTokens += snapshot.cachedWriteTokens;
			thoughtTokens += snapshot.thoughtTokens;
			hasInputTokens ||= snapshot.hasInputTokens;
			hasOutputTokens ||= snapshot.hasOutputTokens;
			hasCachedReadTokens ||= snapshot.hasCachedReadTokens;
			hasCachedWriteTokens ||= snapshot.hasCachedWriteTokens;
			hasThoughtTokens ||= snapshot.hasThoughtTokens;
		}

		if (!hasInputTokens && !hasOutputTokens && !hasCachedReadTokens && !hasCachedWriteTokens && !hasThoughtTokens) {
			return undefined;
		}

		return {
			totalTokens: inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens,
			inputTokens,
			outputTokens,
			...(hasThoughtTokens ? { thoughtTokens } : {}),
			...(hasCachedReadTokens ? { cachedReadTokens } : {}),
			...(hasCachedWriteTokens ? { cachedWriteTokens } : {}),
		};
	}

	private cumulativeCost(): number | undefined {
		let cost = 0;
		let hasCost = false;
		for (const snapshot of this.usageSnapshots.values()) {
			cost += snapshot.cost;
			hasCost ||= snapshot.hasCost;
		}
		return hasCost ? cost : undefined;
	}

	private async emitContextUsage(sessionId: string): Promise<void> {
		if (!this.contextUsage) return;
		const cost = this.cumulativeCost();
		await this.emitSessionUpdate(sessionId, {
			sessionUpdate: "usage_update",
			used: this.contextUsage.used,
			size: this.contextUsage.size,
			...(cost === undefined ? {} : { cost: { amount: cost, currency: "USD" } }),
		});
	}

	private usageSnapshotFromMessage(message: DiracMessage): UsageSnapshot | undefined {
		if (message.content.type === DiracMessageType.API_STATUS) {
			const info = message.content.status;
			const deleted = info.deletedMetrics;
			return {
				inputTokens: (info.tokensIn ?? 0) + (deleted?.tokensIn ?? 0),
				outputTokens: (info.tokensOut ?? 0) + (deleted?.tokensOut ?? 0),
				cachedReadTokens: (info.cacheReads ?? 0) + (deleted?.cacheReads ?? 0),
				cachedWriteTokens: (info.cacheWrites ?? 0) + (deleted?.cacheWrites ?? 0),
				thoughtTokens: info.reasoningTokens ?? 0,
				cost: info.cost ?? 0,
				hasInputTokens: info.tokensIn !== undefined || deleted?.tokensIn !== undefined,
				hasOutputTokens: info.tokensOut !== undefined || deleted?.tokensOut !== undefined,
				hasCachedReadTokens: info.cacheReads !== undefined || deleted?.cacheReads !== undefined,
				hasCachedWriteTokens: info.cacheWrites !== undefined || deleted?.cacheWrites !== undefined,
				hasThoughtTokens: info.reasoningTokens !== undefined,
				hasCost: info.cost !== undefined,
			};
		}

		if (message.content.type !== DiracMessageType.CARD || message.content.card.header !== "Subagent Usage") {
			return undefined;
		}

		let payload: unknown;
		try {
			payload = JSON.parse(message.content.card.body || "{}");
		} catch {
			return undefined;
		}
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;

		const usage = payload as Record<string, unknown>;
		const tokensIn = typeof usage.tokensIn === "number" ? usage.tokensIn : undefined;
		const tokensOut = typeof usage.tokensOut === "number" ? usage.tokensOut : undefined;
		const cacheReads = typeof usage.cacheReads === "number" ? usage.cacheReads : undefined;
		const cacheWrites = typeof usage.cacheWrites === "number" ? usage.cacheWrites : undefined;
		const cost = typeof usage.cost === "number" ? usage.cost : undefined;
		return {
			inputTokens: tokensIn ?? 0,
			outputTokens: tokensOut ?? 0,
			cachedReadTokens: cacheReads ?? 0,
			cachedWriteTokens: cacheWrites ?? 0,
			thoughtTokens: 0,
			cost: cost ?? 0,
			hasInputTokens: tokensIn !== undefined,
			hasOutputTokens: tokensOut !== undefined,
			hasCachedReadTokens: cacheReads !== undefined,
			hasCachedWriteTokens: cacheWrites !== undefined,
			hasThoughtTokens: false,
			hasCost: cost !== undefined,
		};
	}

	private async recordUsage(
		sessionId: string,
		message: DiracMessage,
		emitCurrentContext: boolean,
	): Promise<void> {
		const snapshot = this.usageSnapshotFromMessage(message);
		if (!snapshot) return;

		const keyPrefix = message.content.type === DiracMessageType.API_STATUS ? "api" : "subagent";
		this.usageSnapshots.set(`${keyPrefix}:${message.id}`, snapshot);

		if (message.content.type === DiracMessageType.API_STATUS) {
			const info = message.content.status;
			const contextWindow = info.contextWindow;
			if (contextWindow !== undefined) {
				this.contextUsage = {
					used: (info.tokensIn ?? 0) + (info.tokensOut ?? 0) + (info.cacheWrites ?? 0) + (info.cacheReads ?? 0),
					size: contextWindow,
				};
			}
		}

		if (emitCurrentContext) {
			await this.emitContextUsage(sessionId);
		}
	}

	invalidatePendingInteractions(): void {
		this.interactionGeneration += 1;
	}

	waitForMessageWork(): Promise<void> {
		return this.messageWork;
	}

	/** Finalize every non-terminal tool call when the client cancels its turn. */
	async cancelInFlightToolCalls(
		sessionId: string,
		sessionState: AcpSessionState,
	): Promise<void> {
		const toolCallIds = new Set(sessionState.pendingToolCalls.keys());
		if (sessionState.currentToolCallId) {
			toolCallIds.add(sessionState.currentToolCallId);
		}
		if (sessionState.retryToolCallId) {
			toolCallIds.add(sessionState.retryToolCallId);
		}

		for (const toolCallId of toolCallIds) {
			await this.emitSessionUpdate(sessionId, {
				sessionUpdate: "tool_call_update",
				toolCallId,
				status: "failed",
				rawOutput: { reason: "cancelled" },
			});
		}

		sessionState.pendingToolCalls.clear();
		sessionState.currentToolCallId = undefined;
		sessionState.retryToolCallId = undefined;
	}

	subscribeToTaskMessages(
		controller: Controller,
		sessionId: string,
		sessionState: AcpSessionState,
		resolvePrompt: PromptResolver,
		promptResolved: { value: boolean },
		cleanupFunctions: Array<() => void>,
		taskRunPromise?: Promise<void>,
	): void {
		// Capture the task reference once so cleanup always removes the listener
		// from the task that was active when this prompt subscribed.
		const task = controller.task;
		if (!task) return;
		let active = true;

		const onDiracMessagesChanged = (change: DiracMessageChange) => {
			void this.queueMessageWork(
				() =>
					this.handleDiracMessagesChanged(
						sessionId,
						sessionState,
						change,
						resolvePrompt,
						promptResolved,
					),
				sessionId,
				resolvePrompt,
				promptResolved,
			);
		};

		task.messageStateHandler.on("diracMessagesChanged", onDiracMessagesChanged);
		cleanupFunctions.push(() => {
			active = false;
			task.messageStateHandler.off(
				"diracMessagesChanged",
				onDiracMessagesChanged,
			);
		});

		// Task runs are detached by Controller.initTask. Fulfillment is the
		// authoritative fallback for task-loop exits that do not emit a dedicated
		// terminal card (direct responses, fatal exits, and similar paths). Queue
		// the resolution behind message forwarding so the client receives every
		// preceding update before session/prompt completes.
		if (taskRunPromise) {
			taskRunPromise.then(
				() => {
					void this.queueMessageWork(
						async () => {
							if (!active || promptResolved.value) return;
							promptResolved.value = true;
							resolvePrompt(this.promptResponse("end_turn"));
						},
						sessionId,
						resolvePrompt,
						promptResolved,
					);
				},
				(error) => {
					if (!active) return;
					this.handleUnhandledHandlerError(
						sessionId,
						promptResolved,
						resolvePrompt,
						error,
					);
				},
			);
		}
	}

	async replayTaskMessages(
		controller: Controller,
		sessionId: string,
		sessionState: AcpSessionState,
		resolvePrompt: PromptResolver,
		promptResolved: { value: boolean },
		startIndex = 0,
		endIndex?: number,
	): Promise<void> {
		await this.queueMessageWork(
			async () => {
				const messages =
					controller.task?.messageStateHandler
						.getDiracMessages()
						.slice(startIndex, endIndex) ?? [];

				for (const message of messages) {
					const handledInlineInteraction = await this.processMessageWithDelta(
						sessionId,
						sessionState,
						message,
					);
					this.checkMessageForPromptResolution(
						message,
						resolvePrompt,
						promptResolved,
						handledInlineInteraction,
					);
					if (promptResolved.value) return;
				}
			},
			sessionId,
			resolvePrompt,
			promptResolved,
		);
	}

	/**
	 * Terminate the in-flight prompt with an error after an unhandled throw
	 * inside message handling.
	 *
	 * Without this the promise wired up in prompt() would never resolve
	 * and the client (Zed et al.) would spin forever. Emits an
	 * `agent_message_chunk` carrying the error text, then resolves the prompt
	 * with `stopReason: "end_turn"`.
	 */
	private handleUnhandledHandlerError(
		sessionId: string,
		promptResolved: { value: boolean },
		resolvePrompt: PromptResolver,
		error: unknown,
	): void {
		Logger.error(
			"[TaskMessageBridge] Unhandled error in message handler:",
			error,
		);
		if (promptResolved.value) return;
		promptResolved.value = true;
		const message = error instanceof Error ? error.message : String(error);
		this.emitSessionUpdate(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: `Error: ${message}` },
		})
			.catch((emitError) =>
				Logger.error(
					"[TaskMessageBridge] Failed to emit error update:",
					emitError,
				),
			)
			.finally(() => resolvePrompt(this.promptResponse("end_turn")));
	}

	private async incorporateWhispersAtToolBoundary(
		sessionId: string,
	): Promise<void> {
		const session = this.getSession(sessionId);
		const task = session && this.getController(session)?.task;
		if (!task) return;

		const whispers = this.getWhispers(sessionId);
		if (whispers.length === 0) return;

		const guidance = whispers.map((whisper) => `- ${whisper}`).join("\n");
		task.taskState.pendingUserMessage =
			`${task.taskState.pendingUserMessage ?? ""}\n\n[Client guidance received during this turn:\n${guidance}\n]`.trim();
		this.clearWhispers(sessionId);
		await this.emitSessionUpdate(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: {
				type: "text",
				text: "\nIncorporated your mid-turn guidance.\n",
			},
		});
	}

	private async incorporateWhispersAtTerminalToolBoundary(
		sessionId: string,
		message: DiracMessage,
	): Promise<void> {
		if (message.content.type !== DiracMessageType.CARD) return;
		if (
			![
				CardStatus.SUCCESS,
				CardStatus.ERROR,
				CardStatus.SKIPPED,
				CardStatus.CANCELLED,
				CardStatus.ABANDONED,
			].includes(message.content.card.status)
		)
			return;

		const cardKey = `${sessionId}:${message.content.card.id}`;
		if (this.whisperBoundaryCardKeys.has(cardKey)) return;
		this.whisperBoundaryCardKeys.add(cardKey);
		await this.incorporateWhispersAtToolBoundary(sessionId);
	}

	private async handleDiracMessagesChanged(
		sessionId: string,
		sessionState: AcpSessionState,
		change: DiracMessageChange,
		resolvePrompt: PromptResolver,
		promptResolved: { value: boolean },
	): Promise<void> {
		if (change.type === "set" || change.type === "delete") {
			await this.restoreUsage(sessionId, change.messages, true);
			return;
		}
		if (!change.message) return;

		const handledInlineInteraction = await this.processMessageWithDelta(
			sessionId,
			sessionState,
			change.message,
		);
		await this.incorporateWhispersAtTerminalToolBoundary(
			sessionId,
			change.message,
		);
		this.checkMessageForPromptResolution(
			change.message,
			resolvePrompt,
			promptResolved,
			handledInlineInteraction,
		);
	}

	private formElicitationIsNegotiated(): boolean {
		return this.getClientCapabilities()?.elicitation?.form != null;
	}

	private freeformTextProperty(
		message: DiracMessage,
	): NonNullable<acp.ElicitationSchema["properties"]>[string] {
		const description =
			message.content.type === DiracMessageType.CARD
				? message.content.card.feedbackPlaceholder
				: undefined;
		return {
			type: "string",
			title: "Answer",
			...(description ? { description } : {}),
			minLength: 1,
			pattern: ".*\\S.*",
		};
	}

	private freeformElicitationRequest(
		sessionId: string,
		message: DiracMessage,
	): acp.CreateElicitationRequest {
		if (message.content.type !== DiracMessageType.CARD) {
			throw new Error("Elicitation no longer refers to a card");
		}
		return {
			mode: "form",
			sessionId,
			toolCallId: message.content.card.id,
			message: "Enter another answer",
			requestedSchema: {
				type: "object",
				properties: { text: this.freeformTextProperty(message) },
				required: ["text"],
			},
		};
	}
	private elicitationRequestFromCard(
		sessionId: string,
		message: DiracMessage,
	): acp.CreateElicitationRequest | undefined {
		if (!isFollowupQuestionCard(message)) return undefined;
		if (message.content.type !== DiracMessageType.CARD) return undefined;

		const { card } = message.content;
		const properties: NonNullable<acp.ElicitationSchema["properties"]> = {};
		const required: string[] = [];
		const actionIds = new Set<string>();

		if (card.actions?.length) {
			for (const action of card.actions) {
				if (
					!action.value ||
					action.value === OTHER_ANSWER_OPTION_ID ||
					actionIds.has(action.value)
				) {
					throw new Error(
						"Follow-up question actions must have unique, non-empty values reserved for their options",
					);
				}
				actionIds.add(action.value);
			}
			properties.optionId = {
				type: "string",
				title: "Choose an option",
				oneOf: [
					...card.actions.map((action) => ({
						const: action.value,
						title: action.label,
					})),
					{ const: OTHER_ANSWER_OPTION_ID, title: "Other answer" },
				],
			};
			required.push("optionId");
		} else {
			properties.text = this.freeformTextProperty(message);
			required.push("text");
		}

		return {
			mode: "form",
			sessionId,
			toolCallId: card.id,
			message: card.body || card.header,
			requestedSchema: {
				type: "object",
				properties,
				required,
			},
		};
	}

	private async emitInvalidElicitationMessage(
		sessionId: string,
		message: string,
	): Promise<void> {
		await this.emitSessionUpdate(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: `\n${message}\n` },
		});
	}

	private acceptedElicitationAnswer(
		message: DiracMessage,
		response: acp.CreateElicitationResponse,
		expectedField: "optionId" | "text",
	): { optionId?: string; text?: string; requestsFreeformText?: boolean } {
		if (response.action !== "accept") {
			throw new Error(`Expected accepted elicitation, received ${response.action}`);
		}
		if (
			!response.content ||
			typeof response.content !== "object" ||
			Array.isArray(response.content)
		) {
			throw new Error("Accepted elicitation content must be an object");
		}
		if (message.content.type !== DiracMessageType.CARD) {
			throw new Error("Elicitation no longer refers to a card");
		}

		const content = response.content as Record<string, unknown>;
		const unknownKeys = Object.keys(content).filter(
			(key) => key !== expectedField,
		);
		if (unknownKeys.length > 0) {
			throw new Error(`Unsupported elicitation fields: ${unknownKeys.join(", ")}`);
		}

		if (expectedField === "text") {
			if (typeof content.text !== "string") {
				throw new Error("Elicitation text must be a string");
			}
			const text = content.text.trim();
			if (!text) throw new Error("Elicitation text must not be empty");
			return { text };
		}

		if (typeof content.optionId !== "string") {
			throw new Error("Elicitation optionId must be a string");
		}
		if (content.optionId === OTHER_ANSWER_OPTION_ID) {
			return { requestsFreeformText: true };
		}
		if (
			!message.content.card.actions?.some(
				(action) => action.value === content.optionId,
			)
		) {
			throw new Error(`Unknown elicitation option: ${content.optionId}`);
		}
		return { optionId: content.optionId };
	}

	private async cancelQuestionCard(
		sessionId: string,
		message: DiracMessage,
		reason: string,
	): Promise<void> {
		if (message.content.type !== DiracMessageType.CARD) return;
		Logger.error(`[TaskMessageBridge] ${reason}`);
		await this.emitInvalidElicitationMessage(sessionId, reason);
		const session = this.getSession(sessionId);
		const task = session && this.getController(session)?.task;
		await task?.submitCardResponse(
			message.content.card.id,
			DiracAskResponse.REJECT,
		);
	}

	private async handleElicitationRequest(
		sessionId: string,
		message: DiracMessage,
		request: acp.CreateElicitationRequest,
	): Promise<void> {
		const session = this.getSession(sessionId);
		const controller = session && this.getController(session);
		if (!controller?.task || message.content.type !== DiracMessageType.CARD) return;
		const task = controller.task;
		const cardId = message.content.card.id;
		const interactionGeneration = this.interactionGeneration;
		const interactionIsCurrent = () =>
			this.interactionGeneration === interactionGeneration;

		try {
			const response = await this.requestElicitation(request);
			if (!interactionIsCurrent()) return;

			switch (response.action) {
				case "accept": {
					const expectedField = message.content.card.actions?.length
						? "optionId"
						: "text";
					const answer = this.acceptedElicitationAnswer(
						message,
						response,
						expectedField,
					);
					if (answer.requestsFreeformText) {
						const freeformResponse = await this.requestElicitation(
							this.freeformElicitationRequest(sessionId, message),
						);
						if (!interactionIsCurrent()) return;
						if (freeformResponse.action !== "accept") {
							await task.submitCardResponse(cardId, DiracAskResponse.REJECT);
							return;
						}
						const freeformAnswer = this.acceptedElicitationAnswer(
							message,
							freeformResponse,
							"text",
						);
						await task.submitCardResponse(
							cardId,
							DiracAskResponse.APPROVE,
							freeformAnswer.text,
						);
						return;
					}
					await task.submitCardResponse(
						cardId,
						DiracAskResponse.APPROVE,
						answer.text,
						undefined,
						undefined,
						answer.optionId,
					);
					return;
				}
				case "decline":
				case "cancel":
					await task.submitCardResponse(cardId, DiracAskResponse.REJECT);
					return;
				default:
					throw new Error(`Unsupported elicitation action: ${response.action}`);
			}
		} catch (error) {
			if (!interactionIsCurrent()) return;
			const detail = error instanceof Error ? error.message : String(error);
			await this.cancelQuestionCard(
				sessionId,
				message,
				`The ACP client returned an invalid answer: ${detail}`,
			);
		}
	}

	private async handlePermissionRequest(
		sessionId: string,
		sessionState: AcpSessionState,
		message: DiracMessage,
		permissionRequest: Omit<acp.RequestPermissionRequest, "sessionId">,
	): Promise<void> {
		const session = this.getSession(sessionId);

		if (!session) {
			Logger.debug(
				"[TaskMessageBridge] No session found for permission request",
			);
			return;
		}

		const controller = this.getController(session);

		if (!controller?.task) {
			Logger.debug("[TaskMessageBridge] No active task for permission request");
			return;
		}

		const cardId =
			message.content.type === DiracMessageType.CARD
				? message.content.card.id
				: "";

		// Derive interaction type from card properties: requireApproval → "tool", requireFeedback → "followup"
		const interactionType: "tool" | "followup" =
			message.content.type === DiracMessageType.CARD &&
				message.content.card.requireApproval
				? "tool"
				: "followup";

		try {
			const response = await this.requestPermission(
				sessionId,
				permissionRequest.toolCall,
				permissionRequest.options,
			);

			Logger.debug(
				"[TaskMessageBridge] Permission response received:",
				response.outcome,
			);

			const result = handlePermissionResponse(response, interactionType);
			if (result.persistentAction) {
				await this.persistPermissionRule(
					sessionId,
					permissionRequest.toolCall,
					result.persistentAction,
				);
			}

			if (sessionState.currentToolCallId) {
				if (result.cancelled) {
					await this.emitSessionUpdate(sessionId, {
						sessionUpdate: "tool_call_update",
						toolCallId: sessionState.currentToolCallId,
						status: "failed",
						rawOutput: { reason: "cancelled" },
					});
				} else if (result.response === DiracAskResponse.REJECT) {
					await this.emitSessionUpdate(sessionId, {
						sessionUpdate: "tool_call_update",
						toolCallId: sessionState.currentToolCallId,
						status: "failed",
						rawOutput: { reason: "rejected" },
					});
				} else {
					await this.emitSessionUpdate(sessionId, {
						sessionUpdate: "tool_call_update",
						toolCallId: sessionState.currentToolCallId,
						status: "in_progress",
					});
				}
			}

			if (result.cancelled) {
				await controller.task.submitCardResponse(
					cardId,
					DiracAskResponse.REJECT,
				);
			} else {
				const isNewTaskTransition =
					message.content.type === DiracMessageType.CARD && message.content.card.rawInput?.tool === "new_task";
				await controller.task.submitCardResponse(
					cardId,
					isNewTaskTransition && result.response === "new_task" ? DiracAskResponse.APPROVE : result.response,
					result.text,
					undefined,
					undefined,
					isNewTaskTransition && result.response === "new_task" ? "new_task" : undefined,
				);
			}
		} catch (error) {
			Logger.debug(
				"[TaskMessageBridge] Error handling permission request:",
				error,
			);

			if (sessionState.currentToolCallId) {
				await this.emitSessionUpdate(sessionId, {
					sessionUpdate: "tool_call_update",
					toolCallId: sessionState.currentToolCallId,
					status: "failed",
					rawOutput: { error: String(error) },
				});
			}

			await controller.task.submitCardResponse(cardId, DiracAskResponse.REJECT);
		}
	}

	private checkMessageForPromptResolution(
		message: DiracMessage,
		resolvePrompt: PromptResolver,
		promptResolved: { value: boolean },
		handledInlineInteraction: boolean,
	): void {
		if (promptResolved.value || message.content.type !== DiracMessageType.CARD) {
			return;
		}

		const card = message.content.card;

		// Permission and elicitation requests are serviced inside the active ACP
		// prompt. Their source snapshot remains WAITING_FOR_INPUT even after the
		// response has been submitted to Task, so it must not terminate the turn.
		if (handledInlineInteraction) return;

		// Feedback cards without an ACP-native interaction are intentionally
		// deferred: return control to the client and accept the answer in the next
		// session/prompt request.
		if (
			card.status === CardStatus.WAITING_FOR_INPUT &&
			card.requireFeedback
		) {
			promptResolved.value = true;
			resolvePrompt(this.promptResponse("end_turn"));
			return;
		}

		// attempt_completion is a deliberate ACP boundary even though the core task
		// remains alive to accept optional follow-up feedback.
		if (
			card.status === CardStatus.SUCCESS &&
			card.header === "Task Completed"
		) {
			promptResolved.value = true;
			resolvePrompt(this.promptResponse("end_turn"));
		}
	}

	private async emitPlanFromMessage(
		sessionId: string,
		message: DiracMessage,
	): Promise<void> {
		if (
			message.content.type !== DiracMessageType.CARD ||
			message.content.card.header !== "Proposed Plan"
		)
			return;

		const body = message.content.card.body;
		if (!body) return;

		const planText = this.planTextFromCard(body).trim();
		if (!planText) return;

		const numberedItems = planText
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^[-*]\s+|^\d+[.)]\s+/.test(line))
			.map((line) => line.replace(/^[-*]\s+|^\d+[.)]\s+/, "").trim())
			.filter(Boolean);
		const planItems = numberedItems.length > 0 ? numberedItems : [planText];
		const status = this.planStatusFromCard(message.content.card.status);

		await this.emitSessionUpdate(sessionId, {
			sessionUpdate: "plan",
			entries: planItems.map((content, index) => ({
				content,
				priority: index === 0 ? "high" : "medium",
				status,
			})),
		});
	}

	private planTextFromCard(body: string): string {
		try {
			const parsed = JSON.parse(body) as { response?: unknown };
			return typeof parsed.response === "string" ? parsed.response : body;
		} catch {
			return body;
		}
	}

	private planStatusFromCard(status: CardStatus): acp.PlanEntryStatus {
		if (status === CardStatus.SUCCESS) return "completed";
		if (status === CardStatus.RUNNING || status === CardStatus.BUILDING)
			return "in_progress";
		return "pending";
	}

	private getInteractionCardKey(
		sessionId: string,
		message: DiracMessage,
	): string | undefined {
		if (message.content.type !== DiracMessageType.CARD) return undefined;

		const { card } = message.content;
		if (card.status !== CardStatus.WAITING_FOR_INPUT) return undefined;
		if (!card.requireApproval && !card.requireFeedback && !card.actions?.length)
			return undefined;

		return `${sessionId}:${card.id}`;
	}

	private async processMessageWithDelta(
		sessionId: string,
		sessionState: AcpSessionState,
		message: DiracMessage,
	): Promise<boolean> {
		let handledInlineInteraction = false;
		const messageKey = message.ts;
		const lastText = this.partialMessageLastContent.get(messageKey) || "";

		await this.emitPlanFromMessage(sessionId, message);

		// In the new message model, only MARKDOWN messages stream text content.
		// Card bodies are set at creation time (no incremental streaming).
		// Narrow message.content to MARKDOWN up front so that downstream
		// property accesses (.content, .isCompletion, .isReasoning) type-check
		// without intermediate boolean variables that defeat TS narrowing.
		const isTextStreamingMessage =
			message.content.type === DiracMessageType.MARKDOWN;

		if (
			message.content.type === DiracMessageType.MARKDOWN &&
			message.content.content &&
			!parseWebSearchMarkerText(message.content.content)
		) {
			const isCompletionResult = message.content.isCompletion === true;

			const textContent = message.content.content;

			// completion_result text was previously wrapped in JSON; in the new model
			// the content is already plain text.

			// completion_result emits its final (non-partial) text under a NEW ts
			// (see tsUnstableStreamLastContent). The ts-keyed partialMessageLastContent
			// sees "" for that new ts and would re-emit the whole text, so for these
			// subtypes we accumulate under a stable key.
			const stableStreamKey = isCompletionResult
				? "completion_result"
				: undefined;
			const lastTextForDelta = stableStreamKey
				? (this.tsUnstableStreamLastContent.get(stableStreamKey) ?? "")
				: lastText;

			// For streaming text messages, compute delta to avoid sending duplicates
			let textDelta: string;
			if (textContent.startsWith(lastTextForDelta)) {
				textDelta = textContent.slice(lastTextForDelta.length);
			} else {
				// Content changed entirely (rare), send all
				textDelta = textContent;
			}

			// Determine the correct update type based on message content
			const sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" =
				message.content.isReasoning
					? "agent_thought_chunk"
					: "agent_message_chunk";

			// For completion_result messages, add a leading newline to separate from previous content
			const needsNewline = isCompletionResult && lastTextForDelta === "";

			// Update tracking BEFORE the await: concurrent event handlers share these accumulators,
			// and an await yields the event loop — a second handler could otherwise read stale state
			// and re-send the full accumulated text instead of just the delta.
			if (stableStreamKey) {
				this.tsUnstableStreamLastContent.set(stableStreamKey, textContent);
			} else {
				this.partialMessageLastContent.set(messageKey, textContent);
			}

			// Only send if there's new content
			if (textDelta) {
				await this.emitSessionUpdate(sessionId, {
					sessionUpdate,
					content: {
						type: "text",
						text: needsNewline ? `\n${textDelta}` : textDelta,
					},
				});
			}
		} else {
			// For non-streaming messages (cards, checkpoints, api status), use the full translator
			// Check if we already have a toolCallId for this message (from a previous partial update)
			const existingToolCallId = this.messageToToolCallId.get(messageKey);

			const result = translateMessage(message, sessionState, {
				existingToolCallId,
				clientCapabilities: this.getClientCapabilities(),
			});

			// Send all updates produced by the translator
			for (const update of result.updates) {
				await this.emitSessionUpdate(sessionId, update);
			}

			await this.recordUsage(sessionId, message, true);

			// Track the toolCallId for this message so subsequent updates reuse it
			if (result.toolCallId) {
				this.messageToToolCallId.set(messageKey, result.toolCallId);
			}

			if (result.requiresPermission) {
				handledInlineInteraction = true;
			}

			const isQuestionCard = isFollowupQuestionCard(message);
			if (isQuestionCard && this.formElicitationIsNegotiated()) {
				handledInlineInteraction = true;
			}
			if (isQuestionCard) {
				const interactionCardKey = this.getInteractionCardKey(sessionId, message);
				if (
					interactionCardKey &&
					!this.processedInteractionCardKeys.has(interactionCardKey)
				) {
					this.processedInteractionCardKeys.add(interactionCardKey);
					if (!this.formElicitationIsNegotiated()) {
						await this.emitInvalidElicitationMessage(
							sessionId,
							"This ACP client does not support form elicitation. You can provide the answer in a later prompt.",
						);
					} else {
						try {
							const elicitationRequest = this.elicitationRequestFromCard(
								sessionId,
								message,
							);
							if (elicitationRequest) {
								await this.handleElicitationRequest(
									sessionId,
									message,
									elicitationRequest,
								);
							}
						} catch (error) {
							const detail = error instanceof Error ? error.message : String(error);
							await this.cancelQuestionCard(
								sessionId,
								message,
								`Unable to create ACP form elicitation: ${detail}`,
							);
						}
					}
				}
			} else if (result.requiresPermission && result.permissionRequest) {
				const interactionCardKey = this.getInteractionCardKey(
					sessionId,
					message,
				);

				if (
					interactionCardKey &&
					this.processedInteractionCardKeys.has(interactionCardKey)
				) {
					Logger.debug(
						"[TaskMessageBridge] Skipping duplicate ACP interaction request:",
						interactionCardKey,
					);
				} else {
					if (interactionCardKey) {
						this.processedInteractionCardKeys.add(interactionCardKey);
					}
					await this.handlePermissionRequest(
						sessionId,
						sessionState,
						message,
						result.permissionRequest,
					);
				}
			}

			// Track text content for this message (in case of future updates)
			if (
				message.content.type === DiracMessageType.CARD &&
				message.content.card.body
			) {
				this.partialMessageLastContent.set(
					messageKey,
					message.content.card.body,
				);
			}

			// NOTE: Do NOT delete messageToToolCallId here. A message can receive multiple
			// non-partial updates (e.g. ask:command status updates during execution).
			// Deleting on the first partial=false would cause subsequent updates to lose the
			// existingToolCallId, generating new tool_call + permission events.
			// The map is cleared at the start of each prompt cycle (clearPromptState()).
		}

		return handledInlineInteraction;
	}
}
