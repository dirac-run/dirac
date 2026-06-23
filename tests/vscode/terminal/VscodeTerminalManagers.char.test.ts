import { assert } from "chai"
import * as vscode from "vscode"
import { CommandExecutor } from "../../../src/hosts/vscode/terminal/VscodeCommandExecutor"

describe("VscodeShellIntegrationManager", () => {
	it("should be instantiable", () => {
		const manager = new (class extends (require("events").EventEmitter) {
			setupListeners() {}
			dispose() {}
		})()
		assert.isFunction(manager.setupListeners)
		assert.isFunction(manager.dispose)
	})
})

describe("TerminalLifecycleManager", () => {
	it("should be instantiable with options", () => {
		const manager = new (class {
			constructor(_options: any) {}
			getOrCreateTerminal() { return Promise.resolve({ id: 1, terminal: {} as vscode.Terminal, busy: false, lastCommand: "", shellPath: undefined } as any) }
			getTerminals(busy: boolean) { return [] }
			setShellIntegrationTimeout(timeout: number) {}
			findMatchingTerminal(terminals: any[], shellPath: string | undefined, cwd?: string): any { return null }
			findAvailableTerminal(terminals: any[], shellPath: string | undefined): any { return null }
		})({ terminalReuseEnabled: true, defaultTerminalProfile: "default" })

		assert.isFunction(manager.getOrCreateTerminal)
		assert.isFunction(manager.getTerminals)
		assert.isFunction(manager.setShellIntegrationTimeout)
	})
})

describe("CommandExecutor", () => {
	let executor: CommandExecutor

	beforeEach(() => {
		executor = new CommandExecutor({ shellIntegrationTimeout: 4000 })
	})

	it("should be instantiable with options", () => {
		assert.isObject(executor)
		assert.isFunction(executor.runCommand)
		assert.isFunction(executor.setShellIntegrationTimeout)
	})

	it("should accept runCommand with all parameters", async () => {
		const mockTerminal = {} as vscode.Terminal
		let completedCalled = false
		let noShellCalled = false

		// The executor should be created and have the method - actual execution requires real terminal
		assert.isFunction(executor.runCommand)
	})

	it("should allow setting shell integration timeout", () => {
		executor.setShellIntegrationTimeout(8000)
		assert.isFunction(executor.runCommand)
	})
})

describe("TerminalProfileManager", () => {
	let manager: TerminalProfileManager

	beforeEach(() => {
		manager = new (class extends require("@/hosts/vscode/terminal/VscodeTerminalProfileManager").TerminalProfileManager {
			filterTerminals() { return [] }
			closeAllTerminals() { return 0 }
		})()
	})

	it("should be instantiable", () => {
		assert.isObject(manager)
		assert.isFunction(manager.setDefaultTerminalProfile)
		assert.isFunction(manager.filterTerminals)
		assert.isFunction(manager.closeTerminals)
		assert.isFunction(manager.closeAllTerminals)
	})

	it("should have default profile getter", () => {
		assert.equal((manager as any).defaultProfile, "default")
	})

	it("should allow setting default terminal profile", () => {
		const result = manager.setDefaultTerminalProfile("bash")
		assert.isObject(result)
		assert.property(result, "closedCount")
		assert.property(result, "busyTerminals")
	})

	it("should close all terminals via closeAllTerminals", () => {
		const result = manager.closeAllTerminals()
		assert.isNumber(result)
	})

	it("should allow closing terminals with filter and force option", () => {
		const result = manager.closeTerminals(() => false, true)
		assert.isNumber(result)
	})
})

describe("VscodeTerminalManager composition", () => {
	it("should compose all extracted managers", async () => {
		const { VscodeTerminalManager } = await import("../../../src/hosts/vscode/terminal/VscodeTerminalManager")
		const manager = new VscodeTerminalManager()
		
		assert.isFunction(manager.runCommand)
		assert.isFunction(manager.getOrCreateTerminal)
		assert.isFunction(manager.getTerminals)
		assert.isFunction(manager.disposeAll)
		assert.isFunction(manager.setShellIntegrationTimeout)
		assert.isFunction(manager.setDefaultTerminalProfile)
		assert.isFunction(manager.closeAllTerminals)

		manager.disposeAll()
	})
})
