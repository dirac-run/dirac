import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import proxyquire from "proxyquire"
import sinon from "sinon"
import { DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings"

function resources() {
	const page = { close: sinon.stub().resolves() }
	const browser = { newPage: sinon.stub().resolves(page), close: sinon.stub().resolves(), disconnect: sinon.stub().resolves() }
	return { browser, page }
}

function managerFactory(launch = sinon.stub(), connect = sinon.stub()) {
	const { BrowserConnectionManager } = proxyquire.noCallThru().load("../BrowserConnectionManager", {
		"puppeteer-core": { launch, connect },
		"./BrowserDiscovery": { discoverChromeInstances: sinon.stub().resolves("http://localhost:9222") },
		axios: { get: sinon.stub().resolves({ data: { webSocketDebuggerUrl: "ws://browser" } }) },
	})
	return (remote = false) => {
		const manager = new BrowserConnectionManager({
			...DEFAULT_BROWSER_SETTINGS,
			remoteBrowserEnabled: remote,
			remoteBrowserHost: "http://localhost:9222",
		})
		sinon.stub(manager, "getDetectedChromePath").resolves({ path: "/chrome", isBundled: false })
		return manager
	}
}

describe("browser cleanup ownership", () => {
	it("closes only the owned remote page and disconnects, without closing the shared browser", async () => {
		const first = resources()
		const sibling = resources()
		const connect = sinon.stub().onFirstCall().resolves(first.browser).onSecondCall().resolves(sibling.browser)
		const make = managerFactory(sinon.stub(), connect)
		const owner = make(true)
		const other = make(true)
		await owner.launchBrowser()
		await other.launchBrowser()
		await owner.dispose()
		sinon.assert.calledOnce(first.page.close)
		sinon.assert.calledOnce(first.browser.disconnect)
		sinon.assert.notCalled(first.browser.close)
		sinon.assert.notCalled(sibling.page.close)
		assert.equal(other.getPage(), sibling.page)
		await other.dispose()
	})

	it("does not cache a rejected close or prevent replacement after a transient close failure", async () => {
		const first = resources()
		const next = resources()
		const launch = sinon.stub().onFirstCall().resolves(first.browser).onSecondCall().resolves(next.browser)
		const make = managerFactory(launch)
		const previous = make()
		await previous.launchBrowser()
		first.browser.close.rejects(new Error("temporary protocol failure"))
		await previous.dispose()
		await previous.dispose()
		const replacement = make()
		await replacement.launchBrowser()
		assert.equal(replacement.getPage(), next.page)
		await replacement.dispose()
	})

	it("does not join pending launch during disposal and closes a browser acquired afterwards", async () => {
		const { browser } = resources()
		let finish!: (browser: unknown) => void
		const launch = sinon.stub().returns(new Promise((resolve) => { finish = resolve }))
		const manager = managerFactory(launch)()
		const opening = manager.launchBrowser()
		const rejected = assert.rejects(opening, /disposed/)
		for (let i = 0; i < 20 && !launch.called; i++) await Promise.resolve()
		sinon.assert.calledOnce(launch)
		await manager.dispose()
		finish(browser)
		await rejected
		sinon.assert.calledOnce(browser.close)
		sinon.assert.notCalled(browser.newPage)
		assert.equal(manager.getBrowser(), undefined)
	})
})
