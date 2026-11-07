import { describe, expect, it, vi } from "vitest"
import {
	executeLocalSlashCommand,
	executeStandaloneLocalSlashCommand,
	mergeCliSlashCommands,
	type LocalSlashCommandContext,
} from "./slash-commands"
import { CliPanelType } from "../types"

function localCommandContext(): LocalSlashCommandContext {
	return {
		mode: "act",
		setActivePanel: vi.fn(),
		resetInputLine: vi.fn(),
		clearViewAndResetTask: vi.fn(),
		handleExit: vi.fn(),
		enableFastMode: vi.fn(),
		toggleQuietMode: vi.fn(),
		showAgentSnapshot: vi.fn(),
	}
}

describe("executeLocalSlashCommand", () => {
	it("prints a local snapshot without opening the inspector for /agents", () => {
		const context = localCommandContext()
		expect(executeStandaloneLocalSlashCommand(" /agents ", context)).toBe(true)
		expect(context.showAgentSnapshot).toHaveBeenCalledOnce()
		expect(context.setActivePanel).not.toHaveBeenCalled()
		expect(context.resetInputLine).toHaveBeenCalledOnce()
	})
	it("toggles quiet mode and clears the input for /quiet", () => {
		const context = localCommandContext()

		expect(executeLocalSlashCommand("quiet", context)).toBe(true)
		expect(context.toggleQuietMode).toHaveBeenCalledOnce()
		expect(context.resetInputLine).toHaveBeenCalledOnce()
	})

	it("enables Fast Mode and clears the input for /fast", () => {
		const context = localCommandContext()

		expect(executeLocalSlashCommand("fast", context)).toBe(true)
		expect(context.enableFastMode).toHaveBeenCalledOnce()
		expect(context.resetInputLine).toHaveBeenCalledOnce()
	})

	it("opens the ChatGPT usage panel for /usage", () => {
		const context = localCommandContext()

		expect(executeLocalSlashCommand("usage", context)).toBe(true)
		expect(context.setActivePanel).toHaveBeenCalledWith({ type: CliPanelType.USAGE })
		expect(context.resetInputLine).toHaveBeenCalledOnce()
	})

	it("opens the agent selector for /agent", () => {
		const context = localCommandContext()

		expect(executeLocalSlashCommand("agent", context)).toBe(true)
		expect(context.setActivePanel).toHaveBeenCalledWith({ type: CliPanelType.AGENTS })
		expect(context.resetInputLine).toHaveBeenCalledOnce()
	})

	it("executes a standalone local command with trailing whitespace", () => {
		const context = localCommandContext()

		expect(executeStandaloneLocalSlashCommand("  /agent  ", context)).toBe(true)
		expect(context.setActivePanel).toHaveBeenCalledWith({ type: CliPanelType.AGENTS })
	})

	it("does not execute a local command embedded in prompt text", () => {
		const context = localCommandContext()

		expect(executeStandaloneLocalSlashCommand("Please inspect /agent", context)).toBe(false)
		expect(context.setActivePanel).not.toHaveBeenCalled()
		expect(executeStandaloneLocalSlashCommand('/agents "image.png"', context)).toBe(false)
		expect(context.showAgentSnapshot).not.toHaveBeenCalled()
	})

	it("reserves local command names when backend workflows are merged", () => {
		const local = [{ name: "agent", description: "Local", section: "default", cliCompatible: true }]
		const backend = [
			{ name: "agent", description: "Workflow", section: "custom", cliCompatible: true },
			{ name: "review", description: "Workflow", section: "custom", cliCompatible: true },
		]

		const commands = mergeCliSlashCommands(local, backend)

		expect(commands.map((command) => command.name)).toEqual(["agent", "review"])
	})
})
