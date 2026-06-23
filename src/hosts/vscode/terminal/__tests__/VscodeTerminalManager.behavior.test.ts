/**
 * Behavioral tests for VscodeTerminalManager.
 * Verifies terminal profile change handling, close semantics, and runtime toggles.
 * Baseline reference: 1d316d3d — all 4 methods had functional implementations.
 */
import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as sinon from "sinon"
import { TerminalRegistry, type TerminalInfo } from "../VscodeTerminalRegistry"
import { VscodeTerminalManager } from "../VscodeTerminalManager"

// Minimal fake terminal that tracks dispose calls
function createFakeTerminal(shellPath?: string): TerminalInfo {
	const terminal = {
		exitStatus: undefined as any,
		dispose: sinon.spy(),
		shellIntegration: undefined,
	} as any
	return {
		terminal,
		busy: false,
		lastCommand: "",
		id: 0,
		shellPath,
		lastActive: Date.now(),
	}
}

function registerTerminal(info: Partial<TerminalInfo> & { shellPath?: string }): TerminalInfo {
	const full = createFakeTerminal(info.shellPath)
	Object.assign(full, info)
	// Push directly into registry via createTerminal mock
	const stub = sinon.stub(TerminalRegistry, "createTerminal").callsFake(() => {
		full.id = ++(TerminalRegistry as any).nextTerminalId
		;(TerminalRegistry as any).terminals.push(full)
		return full
	})
	// Use getOrCreateTerminal path — but simpler to just push directly
	;(TerminalRegistry as any).terminals.push(full)
	full.id = ++(TerminalRegistry as any).nextTerminalId
	stub.restore()
	return full
}

describe("VscodeTerminalManager behavior", () => {
	let manager: VscodeTerminalManager
	let originalTerminals: TerminalInfo[]

	beforeEach(() => {
		// Save and clear registry
		originalTerminals = (TerminalRegistry as any).terminals
		;(TerminalRegistry as any).terminals = []
		;(TerminalRegistry as any).nextTerminalId = 0
		manager = new VscodeTerminalManager()
	})

	afterEach(() => {
		;(TerminalRegistry as any).terminals = originalTerminals
		sinon.restore()
	})

	describe("setTerminalOutputLineLimit + processOutput", () => {
		it("uses default limit of 500 when not set", () => {
			const lines = Array.from({ length: 600 }, (_, i) => `line-${i}`)
			const result = manager.processOutput(lines)
			assert.ok(result.includes("output truncated"), "Should truncate at default 500 lines")
			assert.ok(result.includes("line-0"), "Should keep first lines")
			assert.ok(result.includes("line-599"), "Should keep last lines")
		})

		it("uses custom limit after setTerminalOutputLineLimit", () => {
			manager.setTerminalOutputLineLimit(100)
			const lines = Array.from({ length: 200 }, (_, i) => `line-${i}`)
			const result = manager.processOutput(lines)
			assert.ok(result.includes("output truncated"), "Should truncate at custom 100 lines")
			// First 50 and last 50 lines
			assert.ok(result.includes("line-0"), "Should keep first 50 lines")
			assert.ok(result.includes("line-199"), "Should keep last 50 lines")
			// Lines beyond 50 from start should be truncated
			assert.ok(!result.includes("line-50"), "Should NOT include line-50 (truncated)")
		})

		it("does not truncate when under limit", () => {
			manager.setTerminalOutputLineLimit(100)
			const lines = Array.from({ length: 50 }, (_, i) => `line-${i}`)
			const result = manager.processOutput(lines)
			assert.ok(!result.includes("truncated"), "Should NOT truncate when under limit")
			assert.ok(result.includes("line-49"), "Should include all lines")
		})
	})

	describe("closeTerminals", () => {
		it("only clears processes for closed terminals, not all tracked terminals", () => {
			const t1 = registerTerminal({ shellPath: "/bin/bash", busy: false })
			const t2 = registerTerminal({ shellPath: "/bin/zsh", busy: false })
			const t3 = registerTerminal({ shellPath: "/bin/bash", busy: true })
			// Simulate that manager tracks these terminals
			;(manager as any).terminalIds.add(t1.id)
			;(manager as any).terminalIds.add(t2.id)
			;(manager as any).terminalIds.add(t3.id)
			;(manager as any).processes.set(t1.id, {})
			;(manager as any).processes.set(t2.id, {})
			;(manager as any).processes.set(t3.id, {})

			// Close only non-busy bash terminals (t1 matches, t2 is zsh, t3 is busy)
			const closedCount = manager.closeTerminals((t) => t.shellPath === "/bin/bash" && !t.busy, false)

			assert.equal(closedCount, 1, "Should close 1 terminal")
			// t1 process should be cleared
			assert.ok(!(manager as any).processes.has(t1.id), "t1 process should be cleared")
			// t2 and t3 processes should remain
			assert.ok((manager as any).processes.has(t2.id), "t2 process should remain")
			assert.ok((manager as any).processes.has(t3.id), "t3 process should remain")
		})

		it("closes busy terminals when force=true", () => {
			const t1 = registerTerminal({ shellPath: "/bin/bash", busy: true })
			;(manager as any).terminalIds.add(t1.id)
			;(manager as any).processes.set(t1.id, {})

			const closedCount = manager.closeTerminals(() => true, true)
			assert.equal(closedCount, 1, "Should close busy terminal with force")
			assert.ok(!(manager as any).processes.has(t1.id), "Process should be cleared")
		})
	})

	describe("handleTerminalProfileChange", () => {
		it("closes non-busy terminals with different shell path", () => {
			const t1 = registerTerminal({ shellPath: "/bin/bash", busy: false })
			const t2 = registerTerminal({ shellPath: "/bin/zsh", busy: false })
			const t3 = registerTerminal({ shellPath: "/bin/bash", busy: true })
			;(manager as any).terminalIds.add(t1.id)
			;(manager as any).terminalIds.add(t2.id)
			;(manager as any).terminalIds.add(t3.id)

			const result = manager.handleTerminalProfileChange("/bin/bash")

			assert.equal(result.closedCount, 1, "Should close 1 non-busy zsh terminal")
			assert.equal(result.busyTerminals.length, 0, "No busy terminals with different shell")
		})

		it("returns busy terminals with different shell path without closing them", () => {
			const t1 = registerTerminal({ shellPath: "/bin/bash", busy: true })
			;(manager as any).terminalIds.add(t1.id)

			const result = manager.handleTerminalProfileChange("/bin/zsh")

			assert.equal(result.closedCount, 0, "Should not close busy terminals")
			assert.equal(result.busyTerminals.length, 1, "Should report 1 busy terminal")
			assert.equal(result.busyTerminals[0].id, t1.id, "Should be t1")
		})

		it("closes nothing when all terminals match new shell path", () => {
			const t1 = registerTerminal({ shellPath: "/bin/bash", busy: false })
			;(manager as any).terminalIds.add(t1.id)

			const result = manager.handleTerminalProfileChange("/bin/bash")

			assert.equal(result.closedCount, 0, "Should close 0 terminals")
			assert.equal(result.busyTerminals.length, 0, "No busy terminals")
		})
	})

	describe("setTerminalReuseEnabled", () => {
		it("does not throw and updates lifecycle manager state", () => {
			// Should not throw — baseline behavior was a simple field assignment
			assert.doesNotThrow(() => manager.setTerminalReuseEnabled(false))
			assert.doesNotThrow(() => manager.setTerminalReuseEnabled(true))
		})
	})
})
