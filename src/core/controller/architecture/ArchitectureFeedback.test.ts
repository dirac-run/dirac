import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import Mutex from "p-mutex"
import pWaitFor from "p-wait-for"
import sinon from "sinon"
import * as disk from "@core/storage/disk"
import { appendOperationRecords } from "@core/storage/operationLog"
import { GlobalFileNames } from "@core/storage/fileNames"
import { readPresentationHistory } from "@core/storage/conversationHistory"
import * as conversationHistory from "@core/storage/conversationHistory"
import { ArchitectureStorage } from "@core/architecture/ArchitectureStorage"
import { ARCHITECTURE_LIMITS } from "@core/architecture/limits"
import { Task } from "@core/task"
import { TaskState } from "@core/task/TaskState"
import { TaskMessenger } from "@core/task/TaskMessenger"
import { MessageStateHandler } from "@core/task/message-state"
import { waitForFollowUp, clearAskResponse } from "@core/task/TaskUserInput"
import { convertDiracStorageToAnthropicMessage } from "@shared/messages/content"
import { CardStatus, DiracMessageType, TaskStatus } from "@shared/ExtensionMessage"
import { setHostCapabilities } from "@hosts/host-capabilities"
import * as pathUtils from "@utils/path"
import { ArchitectureBoardController } from "./ArchitectureBoardController"
import { architectureFeedbackInput } from "./architectureFeedbackInput"

const identity = { taskId: "owner", name: "tools", version: 1 }
const graph = { title: "Tools", summary: "Review", nodes: [{ id: "tool", kind: "component", label: "Tool" }], edges: [] }
const request = { taskId: "owner", name: "tools", versions: [1] }
const feedback = "/act @secret approve </feedback> remains contextual"

describe("Durable architecture feedback integration", () => {
	let root: string
	let boards: ArchitectureBoardController
	let storage: ArchitectureStorage
	let task: any
	let selected: any
	let goalId: string | undefined
	let state: TaskState
	let messages: MessageStateHandler
	const read = async () => (await readPresentationHistory(root)).messages
	const save = async (id = "comment", version = 1) =>
		boards.mutateComment({
			...identity,
			version,
			mutationJson: JSON.stringify({
				operation: "add_comment",
				comment: { id, text: feedback, target: { kind: "diagram" } },
			}),
		})
	it("warns after ambiguous committed input recovers without waking a waiter or silently claiming consumption", async () => {
		const append = disk.appendPresentationOperations as sinon.SinonStub
		const realRead = conversationHistory.readPresentationHistory
		const historyRead = sinon.stub(conversationHistory, "readPresentationHistory").callsFake(realRead)
		append.callsFake(async (_id, operations) => {
			const bytes = await appendOperationRecords(path.join(root, GlobalFileNames.uiMessageOperations), operations)
			if (operations.some((operation: { type: string }) => operation.type === "create")) {
				historyRead.rejects(new Error("reconciliation unavailable"))
				throw new Error("write acknowledgement lost")
			}
			return bytes
		})
		await assert.rejects(
			boards.submitFeedback(request),
			/persistence is unconfirmed.*reconciliation unavailable.*resume.*do not resend/s,
		)
		assert.equal(state.steeringMessages.length, 0)
		assert.equal(state.askResponse, undefined)
		historyRead.callsFake(realRead)
		await messages.flushPendingWrites()
		assert.equal(messages.getDiracMessages().length, 1)
		assert.equal(state.steeringMessages.length, 0)
		assert.equal(state.askResponse, undefined)
		let pane = (await boards.read({ taskId: "owner", viewLatest: false })).panes[0]
		assert.equal(JSON.parse(pane.commentsJson!)[0].sent, true)
		assert.match(pane.feedbackWarning!, /saved.*consumption is not yet confirmed.*must not be resent.*resume/s)
		assert.equal((await boards.submitFeedback(request)).submittedCount, 0)
		assert.equal((await read()).length, 1)

		// Ordinary explicit resume restores queued contextual input; board reads never do it.
		task.restoreQueuedSteeringFromTranscript()
		assert.equal(state.steeringMessages.length, 1)
		const content: any[] = []
		const claim = await task.appendQueuedSteeringToUserContent(content)
		await messages.addToApiConversationHistory({ role: "user", content })
		await messages.flushPendingWrites()
		await task.settleConsumedSteeringClaim(claim)
		await messages.flushPendingWrites()
		pane = (await boards.read({ taskId: "owner", viewLatest: false })).panes[0]
		assert.equal(pane.feedbackWarning, undefined)
		task.restoreQueuedSteeringFromTranscript()
		assert.equal(state.steeringMessages.length, 0)
		assert.equal((await boards.submitFeedback(request)).submittedCount, 0)
	})

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "architecture-delivery-"))
		sinon.stub(disk, "ensureTaskDirectoryExists").resolves(root)
		sinon
			.stub(disk, "appendPresentationOperations")
			.callsFake(async (_id, operations) =>
				appendOperationRecords(path.join(root, GlobalFileNames.uiMessageOperations), operations),
			)
		sinon
			.stub(disk, "appendApiConversationOperations")
			.callsFake(async (_id, operations) =>
				appendOperationRecords(path.join(root, GlobalFileNames.apiConversationHistoryOperations), operations),
			)
		sinon.stub(disk, "saveApiConversationProviderState").resolves()
		state = new TaskState()
		state.status = TaskStatus.EXECUTING_TOOL
		messages = new MessageStateHandler({
			taskId: "owner",
			ulid: "owner",
			taskState: state,
			updateTaskHistory: async () => [],
		})
		task = Object.create(Task.prototype)
		Object.assign(task, {
			taskId: "owner",
			executionProfile: "standalone",
			taskState: state,
			messageStateHandler: messages,
			stateMutex: new Mutex(),
			postStateToWebview: sinon.stub().resolves(),
		})
		task.taskMessenger = new TaskMessenger({
			taskState: state,
			messageStateHandler: messages,
			postStateToWebview: task.postStateToWebview,
			taskId: "owner",
			getWorkingConfiguration: () => ({ settings: { hooksEnabled: false }, apiConfiguration: {} }),
		} as any)
		selected = task
		goalId = undefined
		sinon.stub(pathUtils, "getCwd").resolves(root)
		setHostCapabilities({
			architectureViewer: {
				prepare: async () => {},
				createPanel: async () => ({ reveal() {}, dispose() {}, refresh: async () => {} }),
			},
		})
		storage = new ArchitectureStorage("owner", root)
		await storage.upsertDiagram("tools", JSON.stringify(graph))
		boards = new ArchitectureBoardController(
			() => {},
			() => root,
			undefined,
			{
				input: (id) => architectureFeedbackInput(id, () => ({ task: selected, goalId })),
				read,
			},
		)
		await boards.open({ taskId: "owner", name: "tools", mode: "latest" })
		await boards.read({ taskId: "owner", viewLatest: false })
		await save()
	})
	afterEach(async () => {
		state.abort = true
		await messages.retirePersistence()
		boards.dispose()
		setHostCapabilities(undefined)
		sinon.restore()
		await fs.rm(root, { recursive: true, force: true })
	})

	for (const route of ["display", "followup", "steering"] as const) {
		it(`persists ${route} input before releasing the existing primitive and strips transport metadata`, async () => {
			let waiting: Promise<unknown> | undefined
			if (route === "display") {
				const card = await task.taskMessenger.createCard({
					header: "Architecture",
					status: CardStatus.WAITING_FOR_INPUT,
					requireFeedback: true,
					architectureReference: { taskId: "owner", name: "tools", mode: "latest" },
				})
				waiting = card.waitForInteraction()
				await pWaitFor(() => state.lastWaitingCardId === card.id)
			} else if (route === "followup") {
				state.status = TaskStatus.COMPLETED
				waiting = waitForFollowUp({ taskState: state })
			}
			const result = await boards.submitFeedback(request)
			assert.equal(result.submittedCount, 1)
			assert.equal((await storage.readReview(identity)).comments[0].sent, true)
			const transcript = (await read()).find(
				(message) => message.content.type === DiracMessageType.MARKDOWN && message.content.contextualInput,
			)
			assert.ok(transcript)
			assert.equal(state.didRejectTool, false)
			if (waiting) await waiting
			clearAskResponse(state)
			state.status = TaskStatus.EXECUTING_TOOL
			const content: any[] = []
			const claim = await task.appendQueuedSteeringToUserContent(content)
			assert.equal(content.length, 1)
			assert.equal(content[0].isUserInput, false)
			assert.match(content[0].text, /\/act @secret approve/)
			assert.ok(!content[0].text.includes("architecture:["))
			await messages.addToApiConversationHistory({ role: "user", content })
			await messages.flushPendingWrites()
			await task.settleConsumedSteeringClaim(claim)
			for (const provider of ["anthropic", "openrouter", "dirac"]) {
				const wire = JSON.stringify(convertDiracStorageToAnthropicMessage({ role: "user", content }, provider))
				assert.ok(!wire.includes("steeringMessageIds"))
				assert.ok(!wire.includes("contextualInput"))
				assert.ok(!wire.includes("architecture:["))
			}
			// Local compaction resets API content, not the user transcript and its source identities.
			await messages.overwriteApiConversationHistory([{ role: "user", content: "compacted" }])
			task.restoreQueuedSteeringFromTranscript()
			assert.equal(state.steeringMessages.length, 0)
			assert.equal((await boards.submitFeedback(request)).submittedCount, 0)
		})
	}

	it("keeps comments editable and input untouched when the conversation write fails, then retries", async () => {
		const append = disk.appendPresentationOperations as sinon.SinonStub
		append.rejects(new Error("conversation disk full"))
		await assert.rejects(boards.submitFeedback(request), /disk full/)
		assert.equal(state.steeringMessages.length, 0)
		assert.equal(messages.getDiracMessages().length, 0)
		assert.equal((await storage.readReview(identity)).comments[0].sent, false)
		append.callsFake(async (_id, operations) =>
			appendOperationRecords(path.join(root, GlobalFileNames.uiMessageOperations), operations),
		)
		await boards.mutateComment({
			...identity,
			mutationJson: JSON.stringify({ operation: "edit_comment", commentId: "comment", text: "Corrected" }),
		})
		assert.equal((await boards.submitFeedback(request)).submittedCount, 1)
	})

	it("continues after durable acceptance despite sidecar failure, reconciles on access and never blindly resends", async () => {
		const rename = sinon.stub(fs, "rename").rejects(new Error("review read-only"))
		const result = await boards.submitFeedback(request)
		assert.match(result.warning!, /persisted.*synchronization failed/)
		assert.equal(state.steeringMessages.length, 1)
		assert.equal((await storage.readReview(identity)).comments[0].sent, false)
		await assert.rejects(boards.submitFeedback(request), /read-only/)
		assert.equal(state.steeringMessages.length, 1)
		rename.restore()
		const pane = (await boards.read({ taskId: "owner", viewLatest: false })).panes[0]
		assert.equal(JSON.parse(pane.commentsJson!)[0].sent, true)
		assert.equal((await boards.submitFeedback(request)).submittedCount, 0)
		await assert.rejects(
			boards.mutateComment({
				...identity,
				mutationJson: JSON.stringify({ operation: "delete_comment", commentId: "comment" }),
			}),
			/sent|submitted/i,
		)
	})

	it("reconciles older pending-count inventory without blocking the current review when synchronization fails", async () => {
		const rename = sinon.stub(fs, "rename").rejects(new Error("review read-only"))
		await boards.submitFeedback(request)
		rename.restore()
		await storage.upsertDiagram("tools", JSON.stringify(graph))
		const unavailable = sinon.stub(fs, "rename").rejects(new Error("review read-only"))
		let pane = (await boards.read({ taskId: "owner", viewLatest: false })).panes[0]
		assert.equal(pane.commentsJson, "[]")
		assert.match(pane.historyError!, /incomplete.*read-only/)
		unavailable.restore()
		pane = (await boards.read({ taskId: "owner", viewLatest: false })).panes[0]
		assert.equal(pane.historyError, undefined)
		assert.equal(pane.pendingReviewsJson, "[]")
		assert.equal((await storage.readReview(identity)).comments[0].sent, true)
		assert.equal(state.steeringMessages.length, 1)
	})

	for (const fileName of ["v1.json", "v1.review.json"]) {
		for (const operation of ["read", "edit", "submit"] as const) {
			it(`isolates ${operation} on a healthy revision from a corrupt delivered ${fileName}`, async () => {
				await boards.submitFeedback(request)
				await storage.upsertDiagram("tools", JSON.stringify(graph))
				await boards.read({ taskId: "owner", viewLatest: false })
				await save("second", 2)
				const corruptFile = path.join(root, "architecture/tools", fileName)
				await fs.writeFile(corruptFile, "corrupt historical data")

				if (operation === "read") {
					const pane = (await boards.read({ taskId: "owner", viewLatest: false })).panes[0]
					assert.equal(pane.version, 2)
					assert.equal(JSON.parse(pane.commentsJson!)[0].id, "second")
					assert.match(pane.historyError!, /incomplete/)
				} else if (operation === "edit") {
					await boards.mutateComment({
						...identity,
						version: 2,
						mutationJson: JSON.stringify({ operation: "edit_comment", commentId: "second", text: "Healthy edit" }),
					})
					assert.equal((await storage.readReview({ ...identity, version: 2 })).comments[0].text, "Healthy edit")
				} else {
					assert.equal((await boards.submitFeedback({ ...request, versions: [2] })).submittedCount, 1)
					assert.equal((await boards.submitFeedback({ ...request, versions: [2] })).submittedCount, 0)
					assert.equal(state.steeringMessages.length, 2)
				}
				assert.equal(await fs.readFile(corruptFile, "utf8"), "corrupt historical data")
			})
		}
	}

	it("keeps a healthy comparison pane editable while refusing submission of a corrupt displayed review", async () => {
		await boards.submitFeedback(request)
		await storage.upsertDiagram("tools", JSON.stringify(graph))
		await boards.open({ taskId: "owner", name: "tools", mode: "comparison", startVersion: 1, endVersion: 2 })
		await boards.read({ taskId: "owner", viewLatest: false })
		await save("second", 2)
		const file = path.join(root, "architecture/tools/v1.review.json")
		const original = await fs.readFile(file, "utf8")
		await fs.writeFile(file, "corrupt historical data")
		const view = await boards.read({ taskId: "owner", viewLatest: false })
		assert.equal(view.panes[0].commentsJson, undefined)
		assert.match(view.panes[0].reviewError!, /unavailable/)
		assert.equal(JSON.parse(view.panes[1].commentsJson!)[0].id, "second")
		await save("correction", 2)
		await assert.rejects(boards.submitFeedback({ ...request, versions: [1, 2] }))
		assert.equal(state.steeringMessages.length, 1)
		assert.equal((await storage.readReview({ ...identity, version: 2 })).comments[0].sent, false)
		assert.equal(await fs.readFile(file, "utf8"), "corrupt historical data")
		await fs.writeFile(file, original)
		assert.equal((await boards.submitFeedback({ ...request, versions: [1, 2] })).submittedCount, 2)
		assert.equal((await boards.submitFeedback({ ...request, versions: [1, 2] })).submittedCount, 0)
	})

	it("freezes accepting comments, rejects duplicate clicks and waits for actual disk persistence", async () => {
		let release!: () => void
		let entered = false
		const append = disk.appendPresentationOperations as sinon.SinonStub
		append.callsFake(async (_id, operations) => {
			if (!operations.length) return 0
			entered = true
			await new Promise<void>((resolve) => {
				release = resolve
			})
			return appendOperationRecords(path.join(root, GlobalFileNames.uiMessageOperations), operations)
		})
		const sending = boards.submitFeedback(request)
		await pWaitFor(() => entered)
		assert.equal((await storage.readReview(identity)).comments[0].sent, false)
		assert.equal(state.steeringMessages.length, 0)
		await assert.rejects(boards.submitFeedback(request), /already/)
		await assert.rejects(save("another"), /frozen/)
		release()
		await sending
		assert.equal(state.steeringMessages.length, 1)
	})

	it("submits only distinct displayed comparison versions, leaving other versions pending", async () => {
		await storage.upsertDiagram("tools", JSON.stringify(graph))
		await storage.upsertDiagram("tools", JSON.stringify(graph))
		await boards.read({ taskId: "owner", viewLatest: false })
		await save("third", 3)
		await boards.open({ taskId: "owner", name: "tools", mode: "comparison", startVersion: 2, endVersion: 1 })
		await boards.read({ taskId: "owner", viewLatest: false })
		await save("second", 2)
		await assert.rejects(boards.submitFeedback({ ...request, versions: [3] }), /scope changed/)
		assert.equal((await boards.submitFeedback({ ...request, versions: [2, 1] })).submittedCount, 2)
		assert.equal((await storage.readReview({ ...identity, version: 3 })).comments[0].sent, false)
	})

	it("blocks wrong selection, unrelated permission/question, cancellation and private workers", async () => {
		for (const profile of ["tasklet", "private", "standalone"]) {
			task.executionProfile = profile
			if (profile === "standalone") selected = { ...task, taskId: "other" }
			await assert.rejects(boards.submitFeedback(request))
		}
		selected = task
		goalId = "another-goal"
		await assert.rejects(boards.submitFeedback(request), /owning conversation/)
		goalId = undefined
		state.abort = true
		await assert.rejects(boards.submitFeedback(request))
		state.abort = false
		for (const requireApproval of [true, false]) {
			const card = await task.taskMessenger.createCard({
				header: "Unrelated",
				status: CardStatus.WAITING_FOR_INPUT,
				requireApproval,
				requireFeedback: !requireApproval,
			})
			state.waitingCardIds = [card.id]
			await assert.rejects(boards.submitFeedback(request), /unrelated/)
			assert.equal(state.askResponse, undefined)
		}
		assert.equal((await storage.readReview(identity)).comments[0].sent, false)
	})

	it("supports active foreground Goals without selected-task routing or command activation", async () => {
		for (const profile of ["goal_coordinator", "goal_followup"]) {
			task.executionProfile = profile
			goalId = "owner"
			await save(profile)
			await boards.submitFeedback(request)
		}
		assert.equal(state.steeringMessages.length, 2)
		selected = undefined
		await assert.rejects(boards.submitFeedback(request), /Resume/)
	})

	it("keeps contextual feedback separate from raw chat command and mention processing", async () => {
		await task.enqueueSteeringMessage("Ordinary @file guidance")
		await boards.submitFeedback(request)
		const content: any[] = []
		await task.appendQueuedSteeringToUserContent(content)
		assert.equal(content.length, 2)
		assert.equal(content[0].isUserInput, true)
		assert.equal(content[1].isUserInput, false)
		assert.match(content[1].text, /\/act @secret approve/)
	})

	for (const change of ["cancel", "selection", "panel"] as const) {
		it(`does not release or redirect accepted feedback when ${change} changes during persistence`, async () => {
			const append = disk.appendPresentationOperations as sinon.SinonStub
			append.callsFake(async (_id, operations) => {
				if (!operations.length) return 0
				const bytes = await appendOperationRecords(path.join(root, GlobalFileNames.uiMessageOperations), operations)
				if (change === "cancel") state.abort = true
				if (change === "selection") selected = undefined
				if (change === "panel") boards.dispose()
				return bytes
			})
			const result = await boards.submitFeedback(request)
			assert.match(result.warning!, /saved in the conversation/)
			assert.equal(state.askResponse, undefined)
			assert.equal(state.steeringMessages.length, 0)
			assert.equal((await storage.readReview(identity)).comments[0].sent, true)
			// The content remains recoverable without restarting cancelled execution.
			assert.equal((await read()).filter((message) => message.content.type === DiracMessageType.MARKDOWN).length, 1)
		})
	}

	it("waits for a timed-out comment write to actually settle before snapshotting feedback", async () => {
		let release!: () => void
		let entered = false
		const rename = fs.rename.bind(fs)
		const pendingRename = sinon.stub(fs, "rename").callsFake(async (from, to) => {
			entered = true
			await new Promise<void>((resolve) => {
				release = resolve
			})
			return rename(from, to)
		})
		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const saving = boards.mutateComment({
			...identity,
			mutationJson: JSON.stringify({ operation: "edit_comment", commentId: "comment", text: "Late committed edit" }),
		})
		const rejected = assert.rejects(saving, /timed out/)
		while (!entered) await new Promise<void>((resolve) => setImmediate(resolve))
		await clock.tickAsync(ARCHITECTURE_LIMITS.operationTimeoutMs + 1)
		await rejected
		clock.restore()
		const sending = boards.submitFeedback(request)
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.equal(state.steeringMessages.length, 0)
		pendingRename.restore()
		release()
		await sending
		assert.match(state.steeringMessages[0].text, /Late committed edit/)
		assert.equal((await storage.readReview(identity)).comments[0].sent, true)
	})

	it("keeps a timed-out active write frozen until settlement, then reconciles without resending", async () => {
		let release!: () => void
		let entered = false
		const append = disk.appendPresentationOperations as sinon.SinonStub
		append.callsFake(async (_id, operations) => {
			if (!operations.length) return 0
			entered = true
			await new Promise<void>((resolve) => {
				release = resolve
			})
			return appendOperationRecords(path.join(root, GlobalFileNames.uiMessageOperations), operations)
		})
		const clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const sending = boards.submitFeedback(request)
		const rejected = assert.rejects(sending, /timed out/)
		// Native scheduling lets the filesystem reach the intentionally stalled append.
		while (!entered) await new Promise<void>((resolve) => setImmediate(resolve))
		await clock.tickAsync(ARCHITECTURE_LIMITS.operationTimeoutMs + 1)
		await rejected
		clock.restore()
		await assert.rejects(save("too-early"), /frozen/)
		await assert.rejects(boards.submitFeedback(request), /already/)
		release()
		await pWaitFor(() => messages.getDiracMessages().length === 1)
		await boards.read({ taskId: "owner", viewLatest: false })
		assert.equal((await storage.readReview(identity)).comments[0].sent, true)
		assert.equal(state.steeringMessages.length, 0)
		task.restoreQueuedSteeringFromTranscript()
		assert.equal(state.steeringMessages.length, 1)
	})

	it("persists transcript mutations arriving during the initial flush before the accepted input", async () => {
		const append = disk.appendPresentationOperations as sinon.SinonStub
		append.onFirstCall().callsFake(async () => {
			await messages.addToDiracMessages({
				id: "concurrent",
				ts: Date.now(),
				content: { type: DiracMessageType.MARKDOWN, role: "assistant", content: "Concurrent output" },
			})
			return 0
		})
		await boards.submitFeedback(request)
		await messages.flushPendingWrites()
		const persisted = await read()
		assert.equal(persisted.length, 2)
		assert.equal(persisted[0].id, "concurrent")
		assert.equal(persisted[1].content.type, DiracMessageType.MARKDOWN)
		assert.equal(state.steeringMessages.length, 1)
	})

	it("rejects retired conversation persistence without marking or buffering input", async () => {
		await messages.retirePersistence()
		await assert.rejects(boards.submitFeedback(request), /retired/)
		assert.equal((await storage.readReview(identity)).comments[0].sent, false)
		assert.equal(messages.getDiracMessages().length, 0)
	})

	it("reads reconciliation history without creating storage or migrating legacy files", async () => {
		const missing = path.join(root, "missing")
		assert.deepEqual(await readPresentationHistory(missing), { messages: [], lastOffset: -1 })
		await assert.rejects(fs.stat(missing), { code: "ENOENT" })
		const legacy = path.join(root, "claude_messages.json")
		await fs.writeFile(legacy, "[]")
		await readPresentationHistory(root)
		assert.equal(await fs.readFile(legacy, "utf8"), "[]")
		await assert.rejects(fs.stat(path.join(root, GlobalFileNames.uiMessages)), { code: "ENOENT" })
	})

	it("recovers a publish-review-revise-compare loop after reload and a lost sent-status update", async () => {
		const presentation = { positions: { tool: { x: 40, y: 80 } } }
		await boards.savePresentation({ ...identity, presentationJson: JSON.stringify(presentation) })
		await boards.submitFeedback(request)
		await save("older-pending")
		const revised = { ...graph, summary: "Refined after feedback" }
		await storage.upsertDiagram("tools", JSON.stringify(revised))
		let pane = (await boards.read({ taskId: "owner", viewLatest: false })).panes[0]
		assert.deepEqual(JSON.parse(pane.pendingReviewsJson!), [{ version: 1, count: 1 }])
		assert.deepEqual(JSON.parse(pane.presentationJson!), presentation)
		await boards.mutateComment({
			...identity,
			version: 2,
			mutationJson: JSON.stringify({
				operation: "add_comment",
				comment: { id: "node-review", text: "Refinement accepted", target: { kind: "node", id: "tool" } },
			}),
		})
		await boards.open({ taskId: "owner", name: "tools", mode: "comparison", startVersion: 1, endVersion: 2 })
		await boards.read({ taskId: "owner", viewLatest: false })
		const rename = sinon.stub(fs, "rename").rejects(new Error("lost sidecar update"))
		const accepted = await boards.submitFeedback({ ...request, versions: [1, 2] })
		assert.equal(accepted.submittedCount, 2)
		assert.match(accepted.warning!, /persisted.*synchronization failed/)
		rename.restore()

		boards.dispose()
		await messages.retirePersistence()
		state.steeringMessages = []
		messages = new MessageStateHandler({
			taskId: "owner",
			ulid: "owner",
			taskState: state,
			updateTaskHistory: async () => [],
		})
		task.messageStateHandler = messages
		const saved = await readPresentationHistory(root)
		messages.setDiracMessages(saved.messages, saved.lastOffset)
		task.restoreQueuedSteeringFromTranscript()
		assert.equal(state.steeringMessages.length, 2)
		assert.ok(state.steeringMessages.every((message) => message.contextual))
		boards = new ArchitectureBoardController(
			() => {},
			() => root,
			undefined,
			{
				input: (id) => architectureFeedbackInput(id, () => ({ task: selected, goalId })),
				read,
			},
		)
		storage = new ArchitectureStorage("owner", root)
		assert.deepEqual(await storage.listDiagrams(), [{ name: "tools", versions: [1, 2] }])
		assert.deepEqual((await storage.fetchDiagram("tools", 1)).diagram, graph)
		assert.deepEqual((await storage.fetchDiagram("tools")).diagram, revised)
		await boards.open({ taskId: "owner", name: "tools", mode: "comparison", startVersion: 1, endVersion: 2 })
		const recovered = await boards.read({ taskId: "owner", viewLatest: false })
		for (pane of recovered.panes) {
			assert.ok(JSON.parse(pane.commentsJson!).every((comment: { sent: boolean }) => comment.sent))
			assert.deepEqual(JSON.parse(pane.presentationJson!), presentation)
		}
		assert.equal((await boards.submitFeedback({ ...request, versions: [1, 2] })).submittedCount, 0)
		assert.equal((await read()).length, 2)
		const content: any[] = []
		const claim = await task.appendQueuedSteeringToUserContent(content)
		await messages.addToApiConversationHistory({ role: "user", content })
		await messages.flushPendingWrites()
		await task.settleConsumedSteeringClaim(claim)
		await messages.overwriteApiConversationHistory([{ role: "user", content: "Compacted refinement history" }])
		task.restoreQueuedSteeringFromTranscript()
		assert.equal(state.steeringMessages.length, 0)
		assert.equal((await boards.submitFeedback({ ...request, versions: [1, 2] })).submittedCount, 0)
	})

	it("restores a persisted but not yet consumed contextual input after a crash without reinterpreting it", async () => {
		await boards.submitFeedback(request)
		state.steeringMessages = []
		const saved = await readPresentationHistory(root)
		messages.setDiracMessages(saved.messages, saved.lastOffset)
		task.restoreQueuedSteeringFromTranscript()
		assert.equal(state.steeringMessages.length, 1)
		assert.equal(state.steeringMessages[0].contextual, true)
		assert.equal((await boards.submitFeedback(request)).submittedCount, 0)
	})
})
