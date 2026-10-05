import { CardStatus, DiracMessageType, type DiracMessage } from "@shared/ExtensionMessage";
import { DiracAskResponse } from "@shared/WebviewMessage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcpSessionStatus, type AcpSessionState } from "./public-types.js";
import { TaskMessageBridge } from "./taskMessageBridge.js";
import { ResponseOperation, responseCardInput } from "@shared/responseTool";

function questionCard(overrides: Record<string, unknown> = {}): DiracMessage {
	return {
		id: (overrides.id as string | undefined) ?? "question-1",
		ts: 1,
		content: {
			type: DiracMessageType.CARD,
			card: {
				id: "question-1",
				header: "Question: Choose a target",
				body: "Choose a target",
				status: CardStatus.WAITING_FOR_INPUT,
				renderType: "markdown",
				requireFeedback: true,
				feedbackPlaceholder: "Type another answer",
				rawInput: responseCardInput(ResponseOperation.QUESTION, "Choose a target"),
				actions: [
					{ label: "Option A", value: "option-a" },
					{ label: "Option B", value: "option-b" },
				],
				...overrides,
			},
		},
	};
}

function sessionState(): AcpSessionState {
	return {
		sessionId: "session-1",
		status: AcpSessionStatus.Processing,
		pendingToolCalls: new Map(),
	};
}

function feedbackCard(): DiracMessage {
	return questionCard({
		id: "plan-1",
		header: "Proposed Plan",
		rawInput: responseCardInput(ResponseOperation.PLAN, "Proposed Plan"),
		actions: undefined,
	});
}

function approvalCard(): DiracMessage {
	return questionCard({
		id: "approval-1",
		header: "Execute command?",
		rawInput: { command: "echo ok" },
		requireApproval: true,
		requireFeedback: false,
		actions: undefined,
	});
}

function checkpointMessage(): DiracMessage {
	return {
		id: "checkpoint-1",
		ts: 2,
		content: { type: DiracMessageType.CHECKPOINT },
	};
}

function apiStatusMessage(): DiracMessage {
	return {
		id: "api-status-1",
		ts: 3,
		content: {
			type: DiracMessageType.API_STATUS,
			status: { stopReason: "max_tokens" },
		},
	} as DiracMessage;
}

describe("TaskMessageBridge form elicitation", () => {
	let submitCardResponse: ReturnType<typeof vi.fn>;
	let requestPermission: ReturnType<typeof vi.fn>;
	let requestElicitation: ReturnType<typeof vi.fn>;
	let emitSessionUpdate: ReturnType<typeof vi.fn>;
	let bridge: TaskMessageBridge;
	let taskState: { lastWaitingCardId: string | undefined; abort: boolean };
	let getMessageById: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		submitCardResponse = vi.fn().mockResolvedValue(undefined);
		requestPermission = vi.fn();
		requestElicitation = vi.fn().mockResolvedValue({
			action: "accept",
			content: { optionId: "option-a" },
		});
		emitSessionUpdate = vi.fn().mockResolvedValue(undefined);
		taskState = { lastWaitingCardId: "question-1", abort: false };
		getMessageById = vi.fn((id: string) => questionCard({ id }));
		const task = { submitCardResponse, taskState, messageStateHandler: { getMessageById } };
		bridge = new TaskMessageBridge({
			getSession: () => ({}) as any,
			getController: () => ({ task }) as any,
			requestPermission,
			emitSessionUpdate,
			getClientCapabilities: () => ({ elicitation: { form: {} } }) as any,
			requestElicitation,
			getWhispers: () => [],
			clearWhispers: vi.fn(),
			persistPermissionRule: vi.fn(),
		} as any);
	});

	it("builds one ACP form request and resumes with the selected option", async () => {
		const message = questionCard();
		await (bridge as any).processMessageWithDelta("session-1", sessionState(), message);
		await (bridge as any).processMessageWithDelta("session-1", sessionState(), message);

		expect(requestElicitation).toHaveBeenCalledTimes(1);
		expect(requestPermission).not.toHaveBeenCalled();
		expect(requestElicitation).toHaveBeenCalledWith({
			mode: "form",
			sessionId: "session-1",
			toolCallId: "question-1",
			message: "Choose a target",
			requestedSchema: {
				type: "object",
				properties: {
					optionId: {
						type: "string",
						title: "Choose an option",
						oneOf: [
							{ const: "option-a", title: "Option A" },
							{ const: "option-b", title: "Option B" },
							{ const: "__dirac_other_answer", title: "Other answer" },
						],
					},
				},
				required: ["optionId"],
			},
		});
		expect(submitCardResponse).toHaveBeenCalledWith(
			"question-1",
			DiracAskResponse.APPROVE,
			undefined,
			undefined,
			undefined,
			"option-a",
		);
	});

	it("requests required free text when the question has no predefined actions", async () => {
		requestElicitation.mockResolvedValueOnce({
			action: "accept",
			content: { text: "  custom answer  " },
		});
		await (bridge as any).processMessageWithDelta(
			"session-1",
			sessionState(),
			questionCard({ actions: undefined }),
		);

		expect(requestElicitation).toHaveBeenCalledWith(
			expect.objectContaining({
				requestedSchema: {
					type: "object",
					properties: {
						text: {
							type: "string",
							title: "Answer",
							description: "Type another answer",
							minLength: 1,
							pattern: ".*\\S.*",
						},
					},
					required: ["text"],
				},
			}),
		);
		expect(submitCardResponse).toHaveBeenCalledWith(
			"question-1",
			DiracAskResponse.APPROVE,
			"custom answer",
			undefined,
			undefined,
			undefined,
		);
	});

	it("collects free text in a second form after Other answer is selected", async () => {
		requestElicitation
			.mockResolvedValueOnce({
				action: "accept",
				content: { optionId: "__dirac_other_answer" },
			})
			.mockResolvedValueOnce({
				action: "accept",
				content: { text: "  explicit detail  " },
			});
		await (bridge as any).processMessageWithDelta(
			"session-1",
			sessionState(),
			questionCard(),
		);

		expect(requestElicitation).toHaveBeenCalledTimes(2);
		expect(requestElicitation).toHaveBeenNthCalledWith(2, {
			mode: "form",
			sessionId: "session-1",
			toolCallId: "question-1",
			message: "Enter another answer",
			requestedSchema: {
				type: "object",
				properties: {
					text: {
						type: "string",
						title: "Answer",
						description: "Type another answer",
						minLength: 1,
						pattern: ".*\\S.*",
					},
				},
				required: ["text"],
			},
		});
		expect(submitCardResponse).toHaveBeenCalledWith(
			"question-1",
			DiracAskResponse.APPROVE,
			"explicit detail",
		);
	});

	it.each([
		[{ action: "decline" }, DiracAskResponse.REJECT],
		[{ action: "cancel" }, DiracAskResponse.REJECT],
	] as const)("maps %s to a Dirac rejection response", async (response, expected) => {
		requestElicitation.mockResolvedValueOnce(response);
		await (bridge as any).processMessageWithDelta("session-1", sessionState(), questionCard());
		expect(submitCardResponse).toHaveBeenCalledWith("question-1", expected);
	});

	it.each([
		{ action: "accept", content: null },
		{ action: "accept", content: [] },
		{ action: "accept", content: {} },
		{ action: "accept", content: { optionId: "unknown" } },
		{ action: "accept", content: { text: "   " } },
		{ action: "accept", content: { unexpected: "answer" } },
	])("visibly cancels malformed accepted content %#", async (response) => {
		requestElicitation.mockResolvedValueOnce(response);
		await (bridge as any).processMessageWithDelta("session-1", sessionState(), questionCard());

		expect(submitCardResponse).toHaveBeenCalledWith("question-1", DiracAskResponse.REJECT);
		expect(emitSessionUpdate).toHaveBeenCalledWith(
			"session-1",
			expect.objectContaining({ sessionUpdate: "agent_message_chunk" }),
		);
		expect(requestPermission).not.toHaveBeenCalled();
	});
	it("rejects whitespace-only content for a required free-text form", async () => {
		requestElicitation.mockResolvedValueOnce({
			action: "accept",
			content: { text: "   " },
		});
		await (bridge as any).processMessageWithDelta(
			"session-1",
			sessionState(),
			questionCard({ actions: undefined }),
		);

		expect(submitCardResponse).toHaveBeenCalledWith(
			"question-1",
			DiracAskResponse.REJECT,
		);
	});


	it("defers a question to the next prompt when form support is absent", async () => {
		const unsupportedBridge = new TaskMessageBridge({
			getSession: () => ({}) as any,
			getController: () => ({ task: { submitCardResponse } }) as any,
			requestPermission,
			emitSessionUpdate,
			getClientCapabilities: () => ({}),
			requestElicitation,
			getWhispers: () => [],
			clearWhispers: vi.fn(),
			persistPermissionRule: vi.fn(),
		} as any);
		const resolvePrompt = vi.fn();
		const promptResolved = { value: false };

		await (unsupportedBridge as any).handleDiracMessagesChanged(
			"session-1",
			sessionState(),
			{ type: "add", message: questionCard() },
			resolvePrompt,
			promptResolved,
		);

		expect(requestElicitation).not.toHaveBeenCalled();
		expect(requestPermission).not.toHaveBeenCalled();
		expect(submitCardResponse).not.toHaveBeenCalled();
		expect(resolvePrompt).toHaveBeenCalledWith({ stopReason: "end_turn" });
		expect(promptResolved.value).toBe(true);
		expect(emitSessionUpdate).toHaveBeenCalledWith(
			"session-1",
			expect.objectContaining({
				sessionUpdate: "agent_message_chunk",
				content: expect.objectContaining({ text: expect.stringContaining("does not support form elicitation") }),
			}),
		);
	});

	it("keeps the ACP prompt active after an inline elicitation response", async () => {
		const resolvePrompt = vi.fn();
		const promptResolved = { value: false };

		await (bridge as any).handleDiracMessagesChanged(
			"session-1",
			sessionState(),
			{ type: "add", message: questionCard() },
			resolvePrompt,
			promptResolved,
		);

		expect(submitCardResponse).toHaveBeenCalled();
		expect(resolvePrompt).not.toHaveBeenCalled();
		expect(promptResolved.value).toBe(false);
	});

	it("ends the ACP prompt for feedback that is deferred to the next prompt", async () => {
		const resolvePrompt = vi.fn();
		const promptResolved = { value: false };

		await (bridge as any).handleDiracMessagesChanged(
			"session-1",
			sessionState(),
			{ type: "add", message: feedbackCard() },
			resolvePrompt,
			promptResolved,
		);

		expect(requestElicitation).not.toHaveBeenCalled();
		expect(resolvePrompt).toHaveBeenCalledWith({ stopReason: "end_turn" });
	});

	it.each([
		["checkpoint", checkpointMessage()],
		["recoverable API stop status", apiStatusMessage()],
	] as const)("does not end the ACP prompt for %s", async (_name, message) => {
		const resolvePrompt = vi.fn();
		const promptResolved = { value: false };

		await (bridge as any).handleDiracMessagesChanged(
			"session-1",
			sessionState(),
			{ type: "add", message },
			resolvePrompt,
			promptResolved,
		);

		expect(resolvePrompt).not.toHaveBeenCalled();
		expect(promptResolved.value).toBe(false);
	});


	it("keeps the ACP prompt active after an inline permission response", async () => {
		taskState.lastWaitingCardId = "approval-1";
		requestPermission.mockResolvedValueOnce({
			outcome: { outcome: "selected", optionId: "allow_once" },
		});
		const resolvePrompt = vi.fn();
		const promptResolved = { value: false };

		await (bridge as any).handleDiracMessagesChanged(
			"session-1",
			sessionState(),
			{ type: "add", message: approvalCard() },
			resolvePrompt,
			promptResolved,
		);

		expect(requestPermission).toHaveBeenCalled();
		expect(resolvePrompt).not.toHaveBeenCalled();
		expect(promptResolved.value).toBe(false);
	});

	for (const createCard of [approvalCard, questionCard]) {
		it(`defers ${createCard.name} client input until the card reaches the FIFO head`, async () => {
			const message = createCard();
			getMessageById.mockReturnValue(message);
			taskState.lastWaitingCardId = "earlier-card";
			requestPermission.mockResolvedValue({ outcome: { outcome: "selected", optionId: "allow_once" } });

			await (bridge as any).processMessageWithDelta("session-1", sessionState(), message);
			expect(requestPermission).not.toHaveBeenCalled();
			expect(requestElicitation).not.toHaveBeenCalled();

			taskState.lastWaitingCardId = message.id;
			await (bridge as any).processMessageWithDelta("session-1", sessionState(), message);

			expect(submitCardResponse).toHaveBeenCalledWith(message.id, DiracAskResponse.APPROVE, undefined, undefined, undefined, createCard === questionCard ? "option-a" : undefined);
		});

		it(`does not request input for ${createCard.name} that becomes terminal before activation`, async () => {
			const message = createCard();
			getMessageById.mockReturnValue(message);
			taskState.lastWaitingCardId = undefined;
			await (bridge as any).processMessageWithDelta("session-1", sessionState(), message);

			if (message.content.type === DiracMessageType.CARD) message.content.card.status = CardStatus.SUCCESS;
			taskState.lastWaitingCardId = message.id;
			await (bridge as any).processMessageWithDelta("session-1", sessionState(), message);

			expect(requestPermission).not.toHaveBeenCalled();
			expect(requestElicitation).not.toHaveBeenCalled();
			expect(submitCardResponse).not.toHaveBeenCalled();
		});
	}

	it("does not block a ready card behind an earlier-created inactive card", async () => {
		const first = questionCard();
		const second = approvalCard();
		getMessageById.mockImplementation((id: string) => id === first.id ? first : second);
		taskState.lastWaitingCardId = second.id;
		requestPermission.mockResolvedValue({ outcome: { outcome: "selected", optionId: "allow_once" } });

		await (bridge as any).processMessageWithDelta("session-1", sessionState(), first);
		await (bridge as any).processMessageWithDelta("session-1", sessionState(), second);
		expect(requestPermission).toHaveBeenCalledTimes(1);
		expect(requestElicitation).not.toHaveBeenCalled();

		taskState.lastWaitingCardId = first.id;
		await (bridge as any).processMessageWithDelta("session-1", sessionState(), first);
		expect(requestElicitation).toHaveBeenCalledTimes(1);
	});

	it("does not request input for an aborted task", async () => {
		taskState.lastWaitingCardId = "approval-1";
		taskState.abort = true;
		await (bridge as any).processMessageWithDelta("session-1", sessionState(), approvalCard());

		expect(requestPermission).not.toHaveBeenCalled();
		expect(submitCardResponse).not.toHaveBeenCalled();
	});

	it("ignores a permission response that arrives after cancellation", async () => {
		taskState.lastWaitingCardId = "approval-1";
		let resolvePermission!: (response: unknown) => void;
		requestPermission.mockImplementationOnce(() => new Promise((resolve) => { resolvePermission = resolve; }));
		const processing = (bridge as any).processMessageWithDelta("session-1", sessionState(), approvalCard());
		await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));

		bridge.invalidatePendingInteractions();
		resolvePermission({ outcome: { outcome: "selected", optionId: "allow_once" } });
		await processing;

		expect(submitCardResponse).not.toHaveBeenCalled();
	});

	it("ignores an elicitation response that arrives after cancellation", async () => {
		let resolveElicitation!: (response: unknown) => void;
		requestElicitation.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveElicitation = resolve;
				}),
		);
		const processing = (bridge as any).processMessageWithDelta(
			"session-1",
			sessionState(),
			questionCard(),
		);
		await vi.waitFor(() => expect(requestElicitation).toHaveBeenCalledTimes(1));

		bridge.invalidatePendingInteractions();
		resolveElicitation({ action: "accept", content: { optionId: "option-a" } });
		await processing;

		expect(submitCardResponse).not.toHaveBeenCalled();
	});

	it("keeps message handling serialized when prompt-local state is cleared", async () => {
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let secondStarted = false;
		const rejectPrompt = vi.fn();
		const promptResolved = { value: false };

		const first = (bridge as any).queueMessageWork(
			() => firstGate,
			"session-1",
			rejectPrompt,
			promptResolved,
		);
		bridge.clearPromptState();
		const second = (bridge as any).queueMessageWork(
			async () => {
				secondStarted = true;
			},
			"session-1",
			rejectPrompt,
			promptResolved,
		);
		await Promise.resolve();
		expect(secondStarted).toBe(false);

		releaseFirst();
		await Promise.all([first, second]);
		expect(secondStarted).toBe(true);
	});

	it("turns an OpenRouter API-status message into context and cumulative token usage", async () => {
		const usageMessage = {
			id: "api-status-usage",
			ts: 10,
			content: {
				type: DiracMessageType.API_STATUS,
				status: {
					tokensIn: 100,
					tokensOut: 25,
					cacheReads: 10,
					cacheWrites: 5,
					reasoningTokens: 4,
					cost: 0.02,
					contextWindow: 200_000,
				},
			},
		} as DiracMessage;

		await (bridge as any).processMessageWithDelta("session-1", sessionState(), usageMessage);

		expect(emitSessionUpdate).toHaveBeenCalledWith("session-1", {
			sessionUpdate: "usage_update",
			used: 140,
			size: 200_000,
			cost: { amount: 0.02, currency: "USD" },
		});
		expect(bridge.promptResponse("end_turn")).toEqual({
			stopReason: "end_turn",
			usage: {
				totalTokens: 140,
				inputTokens: 100,
				outputTokens: 25,
				thoughtTokens: 4,
				cachedReadTokens: 10,
				cachedWriteTokens: 5,
			},
		});
	});

	it("reports provider-reported zero cost in ACP usage updates", async () => {
		const usageMessage = {
			id: "api-status-zero-cost",
			ts: 11,
			content: {
				type: DiracMessageType.API_STATUS,
				status: { tokensIn: 12, tokensOut: 3, cost: 0, contextWindow: 1_048_576 },
			},
		} as DiracMessage;

		await (bridge as any).processMessageWithDelta("session-1", sessionState(), usageMessage);

		expect(emitSessionUpdate).toHaveBeenCalledWith("session-1", {
			sessionUpdate: "usage_update",
			used: 15,
			size: 1_048_576,
			cost: { amount: 0, currency: "USD" },
		});
		expect(bridge.promptResponse("end_turn").usage).toEqual({
			totalTokens: 15,
			inputTokens: 12,
			outputTokens: 3,
		});
	});

	it("does not emit an invalid cost-only ACP usage update", async () => {
		const usageMessage = {
			id: "api-status-no-context-window",
			ts: 12,
			content: {
				type: DiracMessageType.API_STATUS,
				status: { tokensIn: 12, tokensOut: 3, cost: 0.01 },
			},
		} as DiracMessage;

		await (bridge as any).processMessageWithDelta("session-1", sessionState(), usageMessage);

		expect(emitSessionUpdate).not.toHaveBeenCalledWith(
			"session-1",
			expect.objectContaining({ sessionUpdate: "usage_update" }),
		);
		expect(bridge.promptResponse("end_turn").usage).toEqual({
			totalTokens: 15,
			inputTokens: 12,
			outputTokens: 3,
		});
	});

	it("replaces streamed usage snapshots instead of double-counting them", async () => {
		const usageMessage = {
			id: "api-status-stream",
			ts: 11,
			content: {
				type: DiracMessageType.API_STATUS,
				status: { tokensIn: 50, tokensOut: 5 },
			},
		} as DiracMessage;
		await (bridge as any).processMessageWithDelta("session-1", sessionState(), usageMessage);
		(usageMessage.content as any).status = { tokensIn: 60, tokensOut: 10 };
		await (bridge as any).processMessageWithDelta("session-1", sessionState(), usageMessage);

		expect(bridge.promptResponse("end_turn").usage).toEqual({
			totalTokens: 70,
			inputTokens: 60,
			outputTokens: 10,
		});
	});

	it("rebuilds usage after a checkpoint-style message replacement", async () => {
		const original = {
			id: "api-status-original",
			ts: 12,
			content: {
				type: DiracMessageType.API_STATUS,
				status: { tokensIn: 80, tokensOut: 20, cost: 0.03, contextWindow: 1000 },
			},
		} as DiracMessage;
		await (bridge as any).processMessageWithDelta("session-1", sessionState(), original);

		const aggregate = {
			id: "api-status",
			ts: 13,
			content: {
				type: DiracMessageType.API_STATUS,
				status: {
					tokensIn: 0,
					tokensOut: 0,
					cost: 0.03,
					deletedMetrics: { tokensIn: 80, tokensOut: 20 },
				},
			},
		} as DiracMessage;
		await (bridge as any).handleDiracMessagesChanged(
			"session-1",
			sessionState(),
			{ type: "set", messages: [] },
			vi.fn(),
			{ value: false },
		);
		await (bridge as any).processMessageWithDelta("session-1", sessionState(), aggregate);

		expect(bridge.promptResponse("end_turn").usage).toEqual({
			totalTokens: 100,
			inputTokens: 80,
			outputTokens: 20,
		});
	});

	it("ignores malformed subagent usage cards", async () => {
		const malformedUsage = {
			id: "subagent-usage-malformed",
			ts: 14,
			content: {
				type: DiracMessageType.CARD,
				card: {
					id: "subagent-usage-malformed",
					header: "Subagent Usage",
					body: "{not-json",
					status: CardStatus.SUCCESS,
					renderType: "text",
				},
			},
		} as DiracMessage;

		await expect(
			(bridge as any).processMessageWithDelta("session-1", sessionState(), malformedUsage),
		).resolves.toBe(false);
		expect(bridge.promptResponse("end_turn")).toEqual({ stopReason: "end_turn" });
	});


	it("rejects the ACP prompt when asynchronous message handling fails", async () => {
		const internalError = new Error("persistence failed");
		const rejectPrompt = vi.fn();
		const promptResolved = { value: false };

		await (bridge as any).queueMessageWork(
			async () => {
				throw internalError;
			},
			"session-1",
			rejectPrompt,
			promptResolved,
		);
		await Promise.resolve();

		expect(emitSessionUpdate).toHaveBeenCalledWith(
			"session-1",
			expect.objectContaining({
				sessionUpdate: "agent_message_chunk",
				content: expect.objectContaining({ text: "Error: persistence failed" }),
			}),
		);
		expect(rejectPrompt).toHaveBeenCalledWith(internalError);
		expect(promptResolved.value).toBe(true);
	});



	it("uses task-run fulfillment as the fallback ACP turn boundary", async () => {
		let finishTask!: () => void;
		const taskRunPromise = new Promise<void>((resolve) => {
			finishTask = resolve;
		});
		const messageStateHandler = {
			on: vi.fn(),
			off: vi.fn(),
		};
		const controller = { task: { messageStateHandler } } as any;
		const resolvePrompt = vi.fn();
		const promptResolved = { value: false };
		const cleanupFunctions: Array<() => void> = [];

		bridge.subscribeToTaskMessages(
			controller,
			"session-1",
			sessionState(),
			resolvePrompt,
			vi.fn(),
			promptResolved,
			cleanupFunctions,
			taskRunPromise,
		);
		finishTask();
		await taskRunPromise;
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(resolvePrompt).toHaveBeenCalledWith({ stopReason: "end_turn" });
		expect(promptResolved.value).toBe(true);
		cleanupFunctions.forEach((cleanup) => cleanup());
	});

});
