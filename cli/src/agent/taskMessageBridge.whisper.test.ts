import { CardStatus, DiracMessageType } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import { TaskMessageBridge } from "./taskMessageBridge.js"

const terminalStatuses = [
	CardStatus.SUCCESS,
	CardStatus.ERROR,
	CardStatus.SKIPPED,
	CardStatus.CANCELLED,
	CardStatus.ABANDONED,
]

describe("TaskMessageBridge whisper guidance", () => {
	it.each(terminalStatuses)("injects queued guidance once at a %s tool boundary", async (status) => {
		const emitSessionUpdate = vi.fn().mockResolvedValue(undefined)
		const clearWhispers = vi.fn()
		const task = { taskState: {} as { pendingUserMessage?: string } }
		const bridge = createBridge({
			task,
			emitSessionUpdate,
			getWhispers: () => ["Prefer the existing helper."],
			clearWhispers,
		})
		const message = terminalCard("tool-1", status)

		await incorporateTerminalBoundary(bridge, message)
		await incorporateTerminalBoundary(bridge, message)

		expect(task.taskState.pendingUserMessage).toBe(
			"[Client guidance received during this turn:\n- Prefer the existing helper.\n]",
		)
		expect(clearWhispers).toHaveBeenCalledTimes(1)
		expect(clearWhispers).toHaveBeenCalledWith("session-1")
		expect(emitSessionUpdate).toHaveBeenCalledTimes(1)
		expect(emitSessionUpdate).toHaveBeenCalledWith("session-1", {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "\nIncorporated your mid-turn guidance.\n" },
		})
	})

	it("retains guidance without a task and delivers it at a later eligible boundary", async () => {
		const emitSessionUpdate = vi.fn().mockResolvedValue(undefined)
		const clearWhispers = vi.fn()
		const task = { taskState: {} as { pendingUserMessage?: string } }
		let activeTask: typeof task | undefined
		const bridge = createBridge({
			getTask: () => activeTask,
			emitSessionUpdate,
			getWhispers: () => ["Keep this for the next boundary."],
			clearWhispers,
		})

		await incorporateTerminalBoundary(bridge, terminalCard("tool-without-task", CardStatus.ERROR))
		expect(clearWhispers).not.toHaveBeenCalled()
		expect(emitSessionUpdate).not.toHaveBeenCalled()

		activeTask = task
		await incorporateTerminalBoundary(bridge, terminalCard("later-tool", CardStatus.SUCCESS))

		expect(task.taskState.pendingUserMessage).toContain("Keep this for the next boundary.")
		expect(clearWhispers).toHaveBeenCalledTimes(1)
		expect(emitSessionUpdate).toHaveBeenCalledTimes(1)
	})

	it("does not acknowledge when no guidance is queued", async () => {
		const emitSessionUpdate = vi.fn().mockResolvedValue(undefined)
		const clearWhispers = vi.fn()
		const bridge = createBridge({
			task: { taskState: {} },
			emitSessionUpdate,
			getWhispers: () => [],
			clearWhispers,
		})

		await incorporateTerminalBoundary(bridge, terminalCard("tool-1", CardStatus.SUCCESS))

		expect(clearWhispers).not.toHaveBeenCalled()
		expect(emitSessionUpdate).not.toHaveBeenCalled()
	})


})

function createBridge(options: {
	task?: { taskState: { pendingUserMessage?: string } }
	getTask?: () => { taskState: { pendingUserMessage?: string } } | undefined
	emitSessionUpdate: (sessionId: string, update: any) => Promise<void>
	getWhispers: () => string[]
	clearWhispers: (sessionId: string) => void
}): TaskMessageBridge {
	return new TaskMessageBridge({
		getSession: () => ({}) as any,
		getController: () => ({ task: options.getTask ? options.getTask() : options.task }) as any,
		requestPermission: vi.fn(),
		emitSessionUpdate: options.emitSessionUpdate,
		getClientCapabilities: () => undefined,
		requestElicitation: vi.fn(),
		getWhispers: options.getWhispers,
		clearWhispers: options.clearWhispers,
		persistPermissionRule: vi.fn(),
	})
}

function terminalCard(id: string, status: CardStatus) {
	return {
		ts: 1,
		content: {
			type: DiracMessageType.CARD,
			card: { id, header: "Tool", body: "", status },
		},
	} as any
}

async function incorporateTerminalBoundary(bridge: TaskMessageBridge, message: unknown): Promise<void> {
	await (bridge as any).incorporateWhispersAtTerminalToolBoundary("session-1", message)
}
