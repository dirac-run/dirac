import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { CardKind, CardStatus, DiracMessageType, SteeringTranscriptStatus, type CommandApprovalChoice } from "@shared/ExtensionMessage"
import {
	CardKind as ProtoCardKind,
	CardStatus as ProtoCardStatus,
	DiracMessage as ProtoDiracMessage,
	SteeringTranscriptStatus as ProtoSteeringTranscriptStatus,
} from "@shared/proto/dirac/ui"
import { convertDiracMessageToProto, convertProtoToDiracMessage } from "./dirac-message"

describe("Dirac message proto conversion", () => {
	it("round trips host-offered command approval choices through binary protobuf", () => {
		const choices: CommandApprovalChoice[] = [
			{ id: "approve", label: "Approve this command" },
			{ id: "opaque-grant", label: "Localized grant label", category: "filesystem", access: "mutate" },
			{ id: "legacy-grant", label: "Legacy grant without metadata" },
			{ id: "second-grant", label: "Localized read label", category: "credentials", access: "read" },
			{ id: "third-grant", label: "Localized use label", category: "network", access: "use" },
			{ id: "reject", label: "Reject" },
		]
		const proto = convertDiracMessageToProto({
			id: "command", ts: 1,
			content: {
				type: DiracMessageType.CARD, card: {
					id: "command-card", header: "Execute", status: CardStatus.WAITING_FOR_INPUT,
					renderType: "markdown", requireApproval: true, commandApprovalChoices: choices,
				}
			},
		})
		const roundTripped = convertProtoToDiracMessage(ProtoDiracMessage.decode(ProtoDiracMessage.encode(proto).finish()))
		assert.equal(roundTripped.content.type, DiracMessageType.CARD)
		if (roundTripped.content.type !== DiracMessageType.CARD) assert.fail("Expected card")
		assert.deepEqual(roundTripped.content.card.commandApprovalChoices, choices)
	})

	it("omits unknown or unspecified presentation enums without changing opaque choices", () => {
		const proto = ProtoDiracMessage.create({
			id: "future-choice", ts: 1,
			card: {
				id: "command-card", header: "Execute", status: ProtoCardStatus.CARD_WAITING_FOR_INPUT,
				commandApprovalChoices: [
					{ id: "opaque-future", label: "Future choice", category: 999, access: 999 },
					{ id: "opaque-unspecified", label: "Unspecified choice", category: 0, access: 0 },
				],
			},
		})
		const converted = convertProtoToDiracMessage(ProtoDiracMessage.decode(ProtoDiracMessage.encode(proto).finish()))
		if (converted.content.type !== DiracMessageType.CARD) assert.fail("Expected card")
		assert.deepEqual(converted.content.card.commandApprovalChoices, [
			{ id: "opaque-future", label: "Future choice" },
			{ id: "opaque-unspecified", label: "Unspecified choice" },
		])
	})

	it("round trips semantic card identity and steering status enums", () => {
		const message: import("@shared/ExtensionMessage").DiracMessage = {
			id: "completion",
			ts: 1,
			content: {
				type: DiracMessageType.CARD,
				card: {
					id: "card",
					kind: CardKind.TASK_COMPLETION,
					header: "Localized completion",
					status: CardStatus.SUCCESS,
					renderType: "markdown",
				},
			},
		}

		const proto = convertDiracMessageToProto(message)
		assert.equal(proto.card?.kind, ProtoCardKind.CARD_KIND_TASK_COMPLETION)
		assert.equal(convertProtoToDiracMessage(proto).content.type, DiracMessageType.CARD)
		if (!proto.card) assert.fail("Expected card")
		const roundTripped = convertProtoToDiracMessage(proto)
		if (roundTripped.content.type !== DiracMessageType.CARD) assert.fail("Expected card")
		assert.equal(roundTripped.content.card.kind, CardKind.TASK_COMPLETION)

		const steering = convertDiracMessageToProto({
			id: "steering",
			ts: 2,
			content: {
				type: DiracMessageType.MARKDOWN,
				content: "Keep going",
				steering: { status: SteeringTranscriptStatus.QUEUED },
			},
		})
		assert.equal(steering.markdown?.steeringTranscriptStatus, ProtoSteeringTranscriptStatus.STEERING_TRANSCRIPT_STATUS_QUEUED)
		assert.equal(steering.markdown?.steeringStatus, SteeringTranscriptStatus.QUEUED)
	})

	it("reads the enum before the deprecated steering string and falls back for legacy messages", () => {
		const enumMessage = ProtoDiracMessage.create({
			id: "enum",
			ts: 1,
			markdown: {
				content: "enum",
				isReasoning: false,
				images: [],
				files: [],
				steeringStatus: SteeringTranscriptStatus.SENT,
				steeringTranscriptStatus: ProtoSteeringTranscriptStatus.STEERING_TRANSCRIPT_STATUS_QUEUED,
			},
		})
		const enumConverted = convertProtoToDiracMessage(enumMessage)
		if (enumConverted.content.type !== DiracMessageType.MARKDOWN) assert.fail("Expected markdown")
		assert.equal(enumConverted.content.steering?.status, SteeringTranscriptStatus.QUEUED)

		const legacyMessage = ProtoDiracMessage.create({
			id: "legacy",
			ts: 2,
			markdown: {
				content: "legacy",
				isReasoning: false,
				images: [],
				files: [],
				steeringStatus: SteeringTranscriptStatus.SENT,
				steeringTranscriptStatus: ProtoSteeringTranscriptStatus.STEERING_TRANSCRIPT_STATUS_UNSPECIFIED,
			},
		})
		const legacyConverted = convertProtoToDiracMessage(legacyMessage)
		if (legacyConverted.content.type !== DiracMessageType.MARKDOWN) assert.fail("Expected markdown")
		assert.equal(legacyConverted.content.steering?.status, SteeringTranscriptStatus.SENT)
	})

	it("round trips structured card tool metadata, diffs, and exact locations", () => {
		const rawInput = {
			tool: "edit_ast",
			operation: "replace",
			targets: [{ path: "src/service.ts", symbol: "UserService.load" }],
		}
		const rawOutput = { status: "planned", fileCount: 1 }
		const diffs = [{ path: "src/service.ts", oldText: "old", newText: "new" }]
		const locations = [{ path: "src/service.ts", line: 12 }]
		const message: import("@shared/ExtensionMessage").DiracMessage = {
			id: "ast-card-message",
			ts: 4,
			content: {
				type: DiracMessageType.CARD,
				card: {
					id: "ast-card",
					header: "Replacing UserService.load",
					toolName: "edit_ast",
					status: CardStatus.WAITING_FOR_INPUT,
					renderType: "diff",
					rawInput,
					rawOutput,
					diffs,
					locations,
					autoScroll: true,
					actions: [{ label: "Documentation", value: "docs", url: "https://example.com/docs" }],
				},
			},
		}

		const proto = convertDiracMessageToProto(message)
		assert.equal(proto.card?.toolName, "edit_ast")
		assert.equal(proto.card?.rawInputJson, JSON.stringify(rawInput))
		assert.deepEqual(proto.card?.diffs, [{ path: "src/service.ts", oldText: "old", newText: "new" }])
		assert.deepEqual(proto.card?.locations, [{ path: "src/service.ts", line: 12 }])

		const roundTripped = convertProtoToDiracMessage(proto)
		if (roundTripped.content.type !== DiracMessageType.CARD) assert.fail("Expected card")
		assert.equal(roundTripped.content.card.toolName, "edit_ast")
		assert.deepEqual(roundTripped.content.card.rawInput, rawInput)
		assert.deepEqual(roundTripped.content.card.rawOutput, rawOutput)
		assert.deepEqual(roundTripped.content.card.diffs, diffs)
		assert.deepEqual(roundTripped.content.card.locations, locations)
		assert.equal(roundTripped.content.card.autoScroll, true)
		assert.deepEqual(roundTripped.content.card.actions, [
			{ label: "Documentation", value: "docs", primary: undefined, style: undefined, url: "https://example.com/docs" },
		])
	})

	it("preserves communication identity, exact content, secondary detail and receipts over the wire", () => {
		const card: import("@shared/ExtensionMessage").Card = {
			id: "communication:child:1",
			header: "Dirac guided Curie",
			status: CardStatus.SUCCESS,
			renderType: "text",
			body: "Inspect Anchor§literal <button>not a control</button>\nKeep all content",
			communication: { actor: "Dirac", detail: "Queued · publication-123" },
			taskletReceipt: {
				operation: "message",
				outcome: "queued",
				rows: [{ operation: "guidance", taskletId: "Curie", title: "Audit", outcome: "queued", message: "Inspect" }],
			},
		}
		const proto = convertDiracMessageToProto({ id: card.id, ts: 1, content: { type: DiracMessageType.CARD, card } })
		const decoded = ProtoDiracMessage.decode(ProtoDiracMessage.encode(proto).finish())
		const restored = convertProtoToDiracMessage(decoded)
		if (restored.content.type !== DiracMessageType.CARD) assert.fail("Expected card")
		assert.equal(restored.content.card.id, card.id)
		assert.equal(restored.content.card.header, card.header)
		assert.equal(restored.content.card.body, card.body)
		assert.deepEqual(restored.content.card.communication, card.communication)
		assert.deepEqual(restored.content.card.taskletReceipt, card.taskletReceipt)
	})

	it("preserves unspecified card identity for legacy header compatibility", () => {
		const legacy = ProtoDiracMessage.create({
			id: "legacy-card",
			ts: 3,
			card: {
				id: "card",
				header: "Task Completed",
				status: ProtoCardStatus.CARD_SUCCESS,
				kind: ProtoCardKind.CARD_KIND_UNSPECIFIED,
			},
		})
		const converted = convertProtoToDiracMessage(legacy)
		if (converted.content.type !== DiracMessageType.CARD) assert.fail("Expected card")
		assert.equal(converted.content.card.kind, undefined)
	})
})
