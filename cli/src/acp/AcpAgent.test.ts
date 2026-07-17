import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AcpAgent } from "./AcpAgent.js"

const mocks = vi.hoisted(() => {
	const callOrder: string[] = []
	const diracAgentInstance = {
		setPermissionHandler: vi.fn(),

		setElicitationHandler: vi.fn(),
		initialize: vi.fn(),
		newSession: vi.fn(),
		loadSession: vi.fn(),
		unstable_resumeSession: vi.fn(),
		replayLoadedSessionHistory: vi.fn(),
		unstable_listSessions: vi.fn(),
		publishSessionSetupUpdates: vi.fn(),
		emitterForSession: vi.fn(),
		prompt: vi.fn(),
		cancel: vi.fn(),
		setSessionMode: vi.fn(),
		setSessionModel: vi.fn(),
		setSessionConfigOption: vi.fn(),
		authenticate: vi.fn(),
		logout: vi.fn(),

		closeSession: vi.fn(),
		deleteSession: vi.fn(),

		listPermissionRules: vi.fn(),
		deletePermissionRule: vi.fn(),

		listWorkspaceCheckpoints: vi.fn(),
		restoreWorkspaceCheckpoint: vi.fn(),
		integrateSessionWorktree: vi.fn(),
		shutdown: vi.fn(),

		queueWhisper: vi.fn(),
		recordClientAnnotation: vi.fn(),
		pinMessage: vi.fn(),
		unpinMessage: vi.fn(),
		listPinnedMessages: vi.fn(),
	}

	return {
		callOrder,
		diracAgentInstance,
		DiracAgent: vi.fn(function DiracAgent() {
			return diracAgentInstance
		}),
	}
})

vi.mock("../agent/DiracAgent.js", () => ({
	DiracAgent: mocks.DiracAgent,
}))

describe("AcpAgent", () => {
	const connection = {
		requestPermission: vi.fn(),
		sessionUpdate: vi.fn(),
		extNotification: vi.fn().mockResolvedValue(undefined),

		extMethod: vi.fn(),
		unstable_createElicitation: vi.fn().mockResolvedValue({ action: "accept", content: { optionId: "option-1" } }),
	} as any

	beforeEach(() => {
		mocks.callOrder.length = 0
		vi.clearAllMocks()
		vi.useRealTimers()
		mocks.diracAgentInstance.newSession.mockResolvedValue({ sessionId: "session-1" })
		mocks.diracAgentInstance.loadSession.mockResolvedValue({})
		mocks.diracAgentInstance.unstable_resumeSession.mockResolvedValue({})
		mocks.diracAgentInstance.replayLoadedSessionHistory.mockResolvedValue(undefined)
		mocks.diracAgentInstance.unstable_listSessions.mockResolvedValue({ sessions: [] })
		mocks.diracAgentInstance.publishSessionSetupUpdates.mockImplementation(async () => {
			mocks.callOrder.push("publish")
		})
		mocks.diracAgentInstance.emitterForSession.mockImplementation(() => {
			mocks.callOrder.push("subscribe")
			return new EventEmitter()
		})
	})

	it("publishes initial session updates after returning from newSession", async () => {
		vi.useFakeTimers()
		const agent = new AcpAgent(connection, { diracDir: "/tmp/dirac-config", cwd: "/tmp/workspace" })

		await expect(agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] })).resolves.toEqual({ sessionId: "session-1" })

		expect(mocks.diracAgentInstance.newSession).toHaveBeenCalledWith({ cwd: "/tmp/workspace", mcpServers: [] })
		expect(mocks.callOrder).toEqual(["subscribe"])
		expect(mocks.diracAgentInstance.publishSessionSetupUpdates).not.toHaveBeenCalled()

		await vi.runAllTimersAsync()

		expect(mocks.callOrder).toEqual(["subscribe", "publish"])
		expect(mocks.diracAgentInstance.publishSessionSetupUpdates).toHaveBeenCalledWith("session-1")
	})

	it("publishes initial session updates before the first prompt if needed", async () => {
		vi.useFakeTimers()
		mocks.diracAgentInstance.prompt.mockImplementation(async () => {
			mocks.callOrder.push("prompt")
			return { stopReason: "end_turn" }
		})

		const agent = new AcpAgent(connection, {})
		await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] })

		await expect(
			agent.prompt({
				sessionId: "session-1",
				prompt: [{ type: "text", text: "hello" }],
			} as any),
		).resolves.toEqual({ stopReason: "end_turn" })

		expect(mocks.callOrder).toEqual(["subscribe", "publish", "prompt"])
		expect(mocks.diracAgentInstance.publishSessionSetupUpdates).toHaveBeenCalledTimes(1)

		await vi.runAllTimersAsync()
		expect(mocks.diracAgentInstance.publishSessionSetupUpdates).toHaveBeenCalledTimes(1)
	})

	it("disconnects a transport without shutting down its shared DiracAgent", async () => {
		const emitter = new EventEmitter()
		mocks.diracAgentInstance.emitterForSession.mockReturnValue(emitter)
		const agent = new AcpAgent(connection, {})

		await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] })
		agent.disconnect()
		emitter.emit("agent_message_chunk", { content: { type: "text", text: "not forwarded" } })
		await Promise.resolve()

		expect(mocks.diracAgentInstance.shutdown).not.toHaveBeenCalled()
		expect(connection.sessionUpdate).not.toHaveBeenCalled()
	})

	it("passes config and cwd through to DiracAgent", () => {
		new AcpAgent(connection, { diracDir: "/tmp/dirac-config", cwd: "/tmp/workspace", hooksDir: "/tmp/hooks" })

		expect(mocks.DiracAgent).toHaveBeenCalledWith({
			diracDir: "/tmp/dirac-config",
			cwd: "/tmp/workspace",
			hooksDir: "/tmp/hooks",
		})
	})


	it("bridges ACP form elicitation responses unchanged", async () => {
		new AcpAgent(connection, {})
		const handler = mocks.diracAgentInstance.setElicitationHandler.mock.calls[0][0]
		const resolve = vi.fn()
		const request = {
			mode: "form",
			sessionId: "session-1",
			toolCallId: "question-1",
			message: "Choose a target",
			requestedSchema: { type: "object", properties: {} },
		}

		handler(request, resolve)
		await Promise.resolve()

		expect(connection.unstable_createElicitation).toHaveBeenCalledWith(request)
		expect(connection.extMethod).not.toHaveBeenCalledWith("dev.dirac/elicitation.request", expect.anything())
		expect(resolve).toHaveBeenCalledWith({ action: "accept", content: { optionId: "option-1" } })
	})

	it.each([
		{ action: "decline" },
		{ action: "cancel" },
	])("forwards $action elicitation responses unchanged", async (response) => {
		connection.unstable_createElicitation.mockResolvedValueOnce(response)
		new AcpAgent(connection, {})
		const handler = mocks.diracAgentInstance.setElicitationHandler.mock.calls[0][0]
		const resolve = vi.fn()

		handler({ mode: "form", sessionId: "session-1", message: "Question", requestedSchema: {} }, resolve)
		await Promise.resolve()

		expect(resolve).toHaveBeenCalledWith(response)
	})

	it("cancels elicitation when the transport rejects", async () => {
		connection.unstable_createElicitation.mockRejectedValueOnce(new Error("disconnected"))
		new AcpAgent(connection, {})
		const handler = mocks.diracAgentInstance.setElicitationHandler.mock.calls[0][0]
		const resolve = vi.fn()

		handler({ mode: "form", sessionId: "session-1", message: "Question", requestedSchema: {} }, resolve)
		await new Promise((settle) => setTimeout(settle, 0))

		expect(resolve).toHaveBeenCalledWith({ action: "cancel" })
	})

	it("delegates setSessionConfigOption", async () => {
		mocks.diracAgentInstance.setSessionConfigOption.mockResolvedValue({ configOptions: [] })
		const agent = new AcpAgent(connection, {})

		await expect(
			agent.setSessionConfigOption({ sessionId: "session-1", configId: "mode", value: "plan" }),
		).resolves.toEqual({ configOptions: [] })

		expect(mocks.diracAgentInstance.setSessionConfigOption).toHaveBeenCalledWith({
			sessionId: "session-1",
			configId: "mode",
			value: "plan",
		})
	})

	it("publishes setup updates after loadSession", async () => {
		vi.useFakeTimers()
		mocks.diracAgentInstance.replayLoadedSessionHistory.mockImplementation(async () => {
			mocks.callOrder.push("replay")
		})
		const agent = new AcpAgent(connection, {})

		await expect(agent.loadSession({ sessionId: "session-1", cwd: "/tmp/workspace", mcpServers: [] })).resolves.toEqual({})

		expect(mocks.diracAgentInstance.loadSession).toHaveBeenCalledWith({
			sessionId: "session-1",
			cwd: "/tmp/workspace",
			mcpServers: [],
		})
		expect(mocks.callOrder).toEqual(["subscribe", "replay"])
		expect(mocks.diracAgentInstance.replayLoadedSessionHistory).toHaveBeenCalledWith("session-1")

		await vi.runAllTimersAsync()
		expect(mocks.callOrder).toEqual(["subscribe", "replay", "publish", "publish"])
		expect(mocks.diracAgentInstance.publishSessionSetupUpdates).toHaveBeenCalledWith("session-1")
	})

	it("resumes without replaying session history", async () => {
		vi.useFakeTimers()
		const agent = new AcpAgent(connection, {})

		await expect(
			agent.unstable_resumeSession({ sessionId: "session-1", cwd: "/tmp/workspace", mcpServers: [] }),
		).resolves.toEqual({})

		expect(mocks.diracAgentInstance.unstable_resumeSession).toHaveBeenCalledWith({
			sessionId: "session-1",
			cwd: "/tmp/workspace",
			mcpServers: [],
		})
		expect(mocks.diracAgentInstance.replayLoadedSessionHistory).not.toHaveBeenCalled()
		expect(mocks.callOrder).toEqual(["subscribe"])

		await vi.runAllTimersAsync()
		expect(mocks.callOrder).toEqual(["subscribe", "publish"])
	})

	it("delegates unstable_listSessions", async () => {
		mocks.diracAgentInstance.unstable_listSessions.mockResolvedValue({
			sessions: [{ sessionId: "task-1", cwd: "/tmp/workspace", title: "Task", updatedAt: "2026-05-27T00:00:00.000Z" }],
		})
		const agent = new AcpAgent(connection, {})

		await expect(agent.unstable_listSessions({ cwd: "/tmp/workspace" })).resolves.toEqual({
			sessions: [{ sessionId: "task-1", cwd: "/tmp/workspace", title: "Task", updatedAt: "2026-05-27T00:00:00.000Z" }],
		})

		expect(mocks.diracAgentInstance.unstable_listSessions).toHaveBeenCalledWith({ cwd: "/tmp/workspace" })
	})

	it("forwards persisted sequence metadata on session updates", async () => {
		const emitter = new EventEmitter()
		mocks.diracAgentInstance.emitterForSession.mockReturnValue(emitter)
		const agent = new AcpAgent(connection, {})

		connection.sessionUpdate.mockResolvedValue(undefined)

		await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] })
		emitter.emit("agent_message_chunk", {
			content: { type: "text", text: "hello" },
			_meta: { "dev.dirac/seq": 7 },
		})
		await Promise.resolve()

		expect(connection.sessionUpdate).toHaveBeenCalledWith({
			sessionId: "session-1",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "hello" },
				_meta: { "dev.dirac/seq": 7 },
			},
		})
	})


	it("forwards replayed client annotations through the capability-gated extension", async () => {
		const emitter = new EventEmitter()
		mocks.diracAgentInstance.emitterForSession.mockReturnValue(emitter)
		const agent = new AcpAgent(connection, {})

		await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] })
		emitter.emit("client_annotation", {
			kind: "permission_decision",
			outcome: "allow_once",
			_meta: { "dev.dirac/seq": 7 },
		})
		await Promise.resolve()

		expect(connection.extNotification).toHaveBeenCalledWith("dev.dirac/client_annotation", {
			sessionId: "session-1",
			kind: "permission_decision",
			outcome: "allow_once",
			_meta: { "dev.dirac/seq": 7 },
		})
	})


	it("forwards usage updates through the capability-gated extension", async () => {
		const emitter = new EventEmitter()
		mocks.diracAgentInstance.emitterForSession.mockReturnValue(emitter)
		const agent = new AcpAgent(connection, {})

		await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] })
		emitter.emit("usage_update", {
			tokensIn: 100,
			tokensOut: 25,
			totalCost: 0.01,
			contextTokens: 125,
			contextWindow: 200_000,
			contextUsagePercentage: 1,
		})
		await Promise.resolve()

		expect(connection.extNotification).toHaveBeenCalledWith("dev.dirac/usage_update", {
			sessionId: "session-1",
			tokensIn: 100,
			tokensOut: 25,
			totalCost: 0.01,
			contextTokens: 125,
			contextWindow: 200_000,
			contextUsagePercentage: 1,
		})
	})

	it("delegates authentication", async () => {
		mocks.diracAgentInstance.authenticate.mockResolvedValue({})
		const agent = new AcpAgent(connection, {})

		await expect(agent.authenticate({ methodId: "openai-codex-oauth" })).resolves.toEqual({})
		expect(mocks.diracAgentInstance.authenticate).toHaveBeenCalledWith({ methodId: "openai-codex-oauth" })
	})

	it("handles the capability-advertised logout extension", async () => {
		mocks.diracAgentInstance.logout.mockResolvedValue(undefined)
		const agent = new AcpAgent(connection, {})

		await expect(agent.extMethod("dev.dirac/auth.logout", {})).resolves.toEqual({})
		expect(mocks.diracAgentInstance.logout).toHaveBeenCalledTimes(1)
	})

	it("handles the close-session extension and releases its wrapper state", async () => {
		const agent = new AcpAgent(connection, {})

		await expect(agent.extMethod("dev.dirac/session.close", { sessionId: "session-1" })).resolves.toEqual({})

		expect(mocks.diracAgentInstance.closeSession).toHaveBeenCalledWith({ sessionId: "session-1" })
	})

	it("handles the delete-session extension and removes its wrapper state", async () => {
		const agent = new AcpAgent(connection, {})

		await expect(agent.extMethod("dev.dirac/session.delete", { sessionId: "session-1" })).resolves.toEqual({})

		expect(mocks.diracAgentInstance.deleteSession).toHaveBeenCalledWith({ sessionId: "session-1" })
	})


	it("delegates standard closeSession", async () => {
		mocks.diracAgentInstance.closeSession.mockResolvedValue({})
		const agent = new AcpAgent(connection, {})

		await expect(agent.closeSession({ sessionId: "session-1" })).resolves.toEqual({})

		expect(mocks.diracAgentInstance.closeSession).toHaveBeenCalledWith({ sessionId: "session-1" })
	})

	it("delegates standard deleteSession", async () => {
		mocks.diracAgentInstance.deleteSession.mockResolvedValue({})
		const agent = new AcpAgent(connection, {})

		await expect(agent.deleteSession({ sessionId: "session-1" })).resolves.toEqual({})

		expect(mocks.diracAgentInstance.deleteSession).toHaveBeenCalledWith({ sessionId: "session-1" })
	})

	it("lists and deletes rules through capability-advertised permission extensions", async () => {
		mocks.diracAgentInstance.listPermissionRules.mockResolvedValue([
			{ tool: "execute_command", pattern: "npm test", action: "allow" },
		])
		const agent = new AcpAgent(connection, {})

		await expect(agent.extMethod("dev.dirac/permissions.list", { sessionId: "session-1" })).resolves.toEqual({
			rules: [{ tool: "execute_command", pattern: "npm test", action: "allow" }],
		})
		expect(mocks.diracAgentInstance.listPermissionRules).toHaveBeenCalledWith("session-1")

		await expect(
			agent.extMethod("dev.dirac/permissions.delete", {
				sessionId: "session-1",
				rule: { tool: "execute_command", pattern: "npm test", action: "allow" },
			}),
		).resolves.toEqual({})
		expect(mocks.diracAgentInstance.deletePermissionRule).toHaveBeenCalledWith("session-1", {
			tool: "execute_command",
			pattern: "npm test",
			action: "allow",
		})
	})


	it("pins, unpins, and lists messages through capability-advertised extensions", async () => {
		mocks.diracAgentInstance.listPinnedMessages.mockReturnValue([{ messageId: "message-1", content: "keep this", pinnedAt: "2026-05-27T00:00:00.000Z" }])
		const agent = new AcpAgent(connection, {})
		await expect(agent.extMethod("dev.dirac/messages.pin", { sessionId: "session-1", messageId: "message-1" })).resolves.toEqual({})
		expect(mocks.diracAgentInstance.pinMessage).toHaveBeenCalledWith("session-1", "message-1")
		await expect(agent.extMethod("dev.dirac/messages.unpin", { sessionId: "session-1", messageId: "message-1" })).resolves.toEqual({})
		expect(mocks.diracAgentInstance.unpinMessage).toHaveBeenCalledWith("session-1", "message-1")
		await expect(agent.extMethod("dev.dirac/messages.pinned", { sessionId: "session-1" })).resolves.toEqual({
			messages: [{ messageId: "message-1", content: "keep this", pinnedAt: "2026-05-27T00:00:00.000Z" }],
		})
	})

	it("forwards pinned-message updates through the capability-gated extension", async () => {
		const emitter = new EventEmitter()
		mocks.diracAgentInstance.emitterForSession.mockReturnValue(emitter)
		const agent = new AcpAgent(connection, {})
		await agent.newSession({ cwd: "/tmp/workspace", mcpServers: [] })
		emitter.emit("pinned_messages_update", { event: "compacted", messages: [{ messageId: "message-1" }] })
		await Promise.resolve()
		expect(connection.extNotification).toHaveBeenCalledWith("dev.dirac/pinned_messages_update", {
			sessionId: "session-1",
			event: "compacted",
			messages: [{ messageId: "message-1" }],
		})
	})


	it("lists and restores workspace checkpoints through capability-advertised extensions", async () => {
		mocks.diracAgentInstance.listWorkspaceCheckpoints.mockResolvedValue([
			{ id: "checkpoint-1", createdAt: "2026-05-27T00:00:00.000Z", messageId: "checkpoint-1", commitHash: "abc123" },
		])
		const agent = new AcpAgent(connection, {})

		await expect(agent.extMethod("dev.dirac/checkpoints.list", { sessionId: "session-1" })).resolves.toEqual({
			checkpoints: [{ id: "checkpoint-1", createdAt: "2026-05-27T00:00:00.000Z", messageId: "checkpoint-1", commitHash: "abc123" }],
		})
		expect(mocks.diracAgentInstance.listWorkspaceCheckpoints).toHaveBeenCalledWith("session-1")

		await expect(
			agent.extMethod("dev.dirac/checkpoints.restore", { sessionId: "session-1", checkpointId: "checkpoint-1" }),
		).resolves.toEqual({})
		expect(mocks.diracAgentInstance.restoreWorkspaceCheckpoint).toHaveBeenCalledWith("session-1", "checkpoint-1")
	})


	it("rejects malformed worktree integration parameters", async () => {
		const agent = new AcpAgent(connection, {})

		await expect(
			agent.extMethod("dev.dirac/worktree.integrate", { sessionId: "session-1", deleteAfterMerge: "yes" }),
		).rejects.toMatchObject({ code: -32602 })
	})


	it("integrates a session-owned worktree through the capability-advertised extension", async () => {
		mocks.diracAgentInstance.integrateSessionWorktree.mockResolvedValue({
			sourceBranch: "dirac/acp-session-1",
			targetBranch: "main",
			worktreePath: "/tmp/.dirac-worktrees/workspace-session-1",
		})
		const agent = new AcpAgent(connection, {})

		await expect(
			agent.extMethod("dev.dirac/worktree.integrate", {
				sessionId: "session-1",
				targetBranch: "main",
				deleteAfterMerge: false,
			}),
		).resolves.toEqual({
			sourceBranch: "dirac/acp-session-1",
			targetBranch: "main",
			worktreePath: "/tmp/.dirac-worktrees/workspace-session-1",
		})
		expect(mocks.diracAgentInstance.integrateSessionWorktree).toHaveBeenCalledWith("session-1", "main", false)
	})

	it("rejects a workspace-checkpoint restore without a checkpoint id", async () => {
		const agent = new AcpAgent(connection, {})

		await expect(agent.extMethod("dev.dirac/checkpoints.restore", { sessionId: "session-1" })).rejects.toMatchObject({
			code: -32602,
		})
	})

	it("rejects malformed permission-rule extension parameters", async () => {
		const agent = new AcpAgent(connection, {})

		await expect(
			agent.extMethod("dev.dirac/permissions.delete", {
				sessionId: "session-1",
				rule: { tool: "execute_command", action: "maybe" },
			}),
		).rejects.toMatchObject({ code: -32602 })
	})
	it("rejects unsupported extension requests as JSON-RPC method-not-found", async () => {
		const agent = new AcpAgent(connection, {})

		await expect(agent.extMethod("dev.dirac/unknown", { sessionId: "session-1" })).rejects.toMatchObject({
			code: -32601,
			message: '"Method not found": dev.dirac/unknown',
		})
	})

	it("ignores unsupported extension notifications", async () => {
		const agent = new AcpAgent(connection, {})

		await expect(agent.extNotification("dev.dirac/unknown", { sessionId: "session-1" })).resolves.toBeUndefined()
		expect(mocks.diracAgentInstance.prompt).not.toHaveBeenCalled()
	})

	it("forwards active-turn whisper guidance to DiracAgent", async () => {
		const agent = new AcpAgent(connection, {})

		await expect(agent.extNotification("dev.dirac/whisper", { sessionId: "session-1", text: "Use the existing helper." })).resolves.toBeUndefined()

		expect(mocks.diracAgentInstance.queueWhisper).toHaveBeenCalledWith({
			sessionId: "session-1",
			text: "Use the existing helper.",
		})
	})

	it("persists client annotations through the capability-gated notification", async () => {
		const agent = new AcpAgent(connection, {})
		const annotation = { kind: "permission_decision", outcome: "allow_once" }

		await expect(
			agent.extNotification("dev.dirac/client_annotation", { sessionId: "session-1", annotation }),
		).resolves.toBeUndefined()

		expect(mocks.diracAgentInstance.recordClientAnnotation).toHaveBeenCalledWith({ sessionId: "session-1", annotation })
	})


	it("forwards client _meta without interpreting it", async () => {
		mocks.diracAgentInstance.initialize.mockResolvedValue({ protocolVersion: 1, agentCapabilities: {}, agentInfo: {} })
		const agent = new AcpAgent(connection, {})

		await expect(
			agent.initialize({
				protocolVersion: 1,
				clientCapabilities: {},
				_meta: { "com.example/client": { feature: true } },
			} as any),
		).resolves.toEqual({ protocolVersion: 1, agentCapabilities: {}, agentInfo: {} })

		expect(mocks.diracAgentInstance.initialize).toHaveBeenCalledWith(
			expect.objectContaining({ _meta: { "com.example/client": { feature: true } } }),
			connection,
		)
	})
})
