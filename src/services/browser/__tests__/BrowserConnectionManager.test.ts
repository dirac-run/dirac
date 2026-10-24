import { describe, it } from "mocha"
import proxyquire from "proxyquire"
import "should"
import sinon from "sinon"
import { DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings"
import { EventEmitter } from "node:events"

describe("BrowserConnectionManager", () => {
	it("reports asynchronous Chrome spawn failures", async () => {
		const child = new EventEmitter() as EventEmitter & { unref: sinon.SinonStub }
		child.unref = sinon.stub()
		const spawn = sinon.stub().callsFake(() => {
			queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")))
			return child
		})
		const { BrowserConnectionManager } = proxyquire.noCallThru().load("../BrowserConnectionManager", {
			child_process: { spawn },
			"chrome-launcher": { Launcher: { getFirstInstallation: () => "/missing/chrome" } },
		})
		const manager = new BrowserConnectionManager({
			getGlobalSettingsKey: () => ({ ...DEFAULT_BROWSER_SETTINGS, customArgs: "" }),
		} as never)

		await manager.relaunchChromeDebugMode().should.be.rejectedWith(/Failed to relaunch Chrome: spawn ENOENT/)

		sinon.assert.calledOnce(child.unref)
	})

	it("removes the Chrome spawn error listener after startup", async () => {
		const clock = sinon.useFakeTimers()
		try {
			const child = new EventEmitter() as EventEmitter & { unref: sinon.SinonStub }
			child.unref = sinon.stub()
			const { BrowserConnectionManager } = proxyquire.noCallThru().load("../BrowserConnectionManager", {
				child_process: { spawn: sinon.stub().returns(child) },
				"chrome-launcher": { Launcher: { getFirstInstallation: () => "/installed/chrome" } },
				"./BrowserDiscovery": { isPortOpen: sinon.stub().resolves(true) },
			})
			const manager = new BrowserConnectionManager({
				getGlobalSettingsKey: () => ({ ...DEFAULT_BROWSER_SETTINGS, customArgs: "" }),
			} as never)

			const launchPromise = manager.relaunchChromeDebugMode({} as never)
			await clock.tickAsync(1000)
			await launchPromise

			child.listenerCount("error").should.equal(0)
		} finally {
			clock.restore()
		}
	})

	it("disconnects a remote browser when opening its page fails", async () => {
		const disconnect = sinon.stub().resolves()
		const browser = {
			newPage: sinon.stub().rejects(new Error("page failed")),
			disconnect,
		}
		const connect = sinon.stub().resolves(browser)
		const { BrowserConnectionManager } = proxyquire.noCallThru().load("../BrowserConnectionManager", {
			"puppeteer-core": {
				connect,
			},
		})
		const stateManager = {
			getGlobalSettingsKey: () => ({
				...DEFAULT_BROWSER_SETTINGS,
				remoteBrowserEnabled: true,
				remoteBrowserHost: undefined,
			}),
		}
		const manager = new BrowserConnectionManager(stateManager as never)
		;(manager as any).cachedWebSocketEndpoint = "ws://cached-browser"
		;(manager as any).lastConnectionAttempt = Date.now()

		await manager.launchRemoteBrowser().should.be.rejectedWith(/Failed to connect to remote browser/)

		sinon.assert.calledOnce(disconnect)
		should(manager.getBrowser()).be.undefined()
		should(manager.getPage()).be.undefined()
	})
})
