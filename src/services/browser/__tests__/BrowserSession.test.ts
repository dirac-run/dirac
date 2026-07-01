/**
 * Characterization tests for BrowserSession — verifies the public API contract
 * without launching a real browser. Focuses on connection-info, no-op close,
 * action-execution guard, and telemetry tracking wiring.
 */
import { beforeEach, describe, it } from "mocha"
import "should"
import type { BrowserSettings } from "@shared/BrowserSettings"
import { DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings"
import { BrowserConnectionInfo, BrowserSession } from "../BrowserSession"
import { expectLoggerErrors } from "@/test/loggerGuard"

// Minimal StateManager stub — only getGlobalSettingsKey is used by BrowserSession
function makeStateManager(settings: BrowserSettings = DEFAULT_BROWSER_SETTINGS) {
	return {
		getGlobalSettingsKey: (key: "browserSettings") => (key === "browserSettings" ? settings : (undefined as never)),
	}
}

describe("BrowserSession", () => {
	let session: BrowserSession

	beforeEach(() => {
		session = new BrowserSession(makeStateManager() as never)
	})

	describe("getConnectionInfo", () => {
		it("reports disconnected when no browser launched", () => {
			const info: BrowserConnectionInfo = session.getConnectionInfo()
			info.isConnected.should.be.false()
			info.isRemote.should.be.false()
			should(info.host).be.undefined()
		})
	})

	describe("closeBrowser", () => {
		it("returns empty result when nothing is open (no-op)", async () => {
			const result = await session.closeBrowser()
			result.should.eql({})
		})
	})

	describe("executePageAction", () => {
		it("throws when no page is launched", async () => {
			await session.executePageAction(async () => { }).should.be.rejectedWith(/Browser is not launched/)
		})
	})

	describe("setUlid", () => {
		it("accepts a task id without throwing", () => {
			session.setUlid("task-123")
			// setUlid is a fire-and-forget setter — no return value to assert, no throw is the contract
		})
	})

	describe("dispose", () => {
		it("resolves without throwing when nothing is open", async () => {
			await session.dispose()
			// dispose is a cleanup no-op when nothing is open — no throw is the contract
		})
	})

	describe("testConnection", () => {
		it("returns a failure result for an unreachable host", async () => {
			expectLoggerErrors()
			// Guaranteed-unreachable port exercises the failure path without throwing
			const result = await session.testConnection("http://127.0.0.1:1")
			result.success.should.be.false()
			result.message.should.containEql("Failed to connect")
		})
	})
})
