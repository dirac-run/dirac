import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AcpAgent } from "./AcpAgent.js"

const mocks = vi.hoisted(() => {
	const callOrder: string[] = []
	const diracAgentInstance = {
		setPermissionHandler: vi.fn(),
		initialize: vi.fn(),
		newSession: vi.fn(),
		loadSession: vi.fn(),
		publishSessionSetupUpdates: vi.fn(),
		emitterForSession: vi.fn(),
		prompt: vi.fn(),
		cancel: vi.fn(),
		setSessionMode: vi.fn(),
		unstable_setSessionModel: vi.fn(),
		unstable_setSessionConfigOption: vi.fn(),
		authenticate: vi.fn(),
		shutdown: vi.fn(),
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
	} as any

	beforeEach(() => {
		mocks.callOrder.length = 0
		vi.clearAllMocks()
		vi.useRealTimers()
		mocks.diracAgentInstance.newSession.mockResolvedValue({ sessionId: "session-1" })
		mocks.diracAgentInstance.loadSession.mockResolvedValue({})
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

	it("passes config and cwd through to DiracAgent", () => {
		new AcpAgent(connection, { diracDir: "/tmp/dirac-config", cwd: "/tmp/workspace", hooksDir: "/tmp/hooks" })

		expect(mocks.DiracAgent).toHaveBeenCalledWith({
			diracDir: "/tmp/dirac-config",
			cwd: "/tmp/workspace",
			hooksDir: "/tmp/hooks",
		})
	})

	it("delegates unstable_setSessionConfigOption", async () => {
		mocks.diracAgentInstance.unstable_setSessionConfigOption.mockResolvedValue({ configOptions: [] })
		const agent = new AcpAgent(connection, {})

		await expect(
			agent.unstable_setSessionConfigOption({ sessionId: "session-1", configId: "mode", value: "plan" }),
		).resolves.toEqual({ configOptions: [] })

		expect(mocks.diracAgentInstance.unstable_setSessionConfigOption).toHaveBeenCalledWith({
			sessionId: "session-1",
			configId: "mode",
			value: "plan",
		})
	})

	it("publishes setup updates after loadSession", async () => {
		vi.useFakeTimers()
		const agent = new AcpAgent(connection, {})

		await expect(agent.loadSession({ sessionId: "session-1", cwd: "/tmp/workspace", mcpServers: [] })).resolves.toEqual({})

		expect(mocks.diracAgentInstance.loadSession).toHaveBeenCalledWith({
			sessionId: "session-1",
			cwd: "/tmp/workspace",
			mcpServers: [],
		})
		expect(mocks.callOrder).toEqual(["subscribe"])

		await vi.runAllTimersAsync()
		expect(mocks.callOrder).toEqual(["subscribe", "publish"])
		expect(mocks.diracAgentInstance.publishSessionSetupUpdates).toHaveBeenCalledWith("session-1")
	})
})
