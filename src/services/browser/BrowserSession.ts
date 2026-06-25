import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { Controller } from "@core/controller"
import { BrowserActionResult } from "@shared/ExtensionMessage"
import pWaitFor from "p-wait-for"
// @ts-expect-error
import type { LoggerMessage, ScreenshotOptions } from "puppeteer-core"
import { Page, TimeoutError } from "puppeteer-core"
import { StateManager } from "@/core/storage/StateManager"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { BrowserConnectionInfo, BrowserConnectionManager } from "./BrowserConnectionManager"

// Re-export so existing imports of BrowserConnectionInfo from BrowserSession keep working
export type { BrowserConnectionInfo }

/**
 * Browser action execution + screenshot capture. Connection lifecycle
 * (launch/connect/disconnect/discover) is delegated to BrowserConnectionManager.
 */
export class BrowserSession {
	private connection: BrowserConnectionManager
	private currentMousePosition?: string
	private useWebp: boolean

	constructor(stateManager: StateManager, useWebp = true) {
		this.connection = new BrowserConnectionManager(stateManager)
		this.useWebp = useWebp
	}

	// --- connection lifecycle (delegated) ---

	async testConnection(host: string): Promise<{ success: boolean; message: string; endpoint?: string }> {
		return this.connection.testConnection(host)
	}

	getConnectionInfo(): BrowserConnectionInfo {
		return this.connection.getConnectionInfo()
	}

	async getDetectedChromePath(): Promise<{ path: string; isBundled: boolean }> {
		return this.connection.getDetectedChromePath()
	}

	async relaunchChromeDebugMode(controller: Controller): Promise<string> {
		return this.connection.relaunchChromeDebugMode(controller)
	}

	async launchBrowser() {
		await this.connection.launchBrowser()
	}

	async launchLocalBrowser() {
		await this.connection.launchLocalBrowser()
	}

	async launchRemoteBrowser() {
		await this.connection.launchRemoteBrowser()
	}

	async closeBrowser(): Promise<BrowserActionResult> {
		const result = await this.connection.closeBrowser()
		this.currentMousePosition = undefined // reset mouse state on close
		return result
	}

	async dispose() {
		await this.connection.dispose()
	}

	setUlid(ulid: string) {
		this.connection.setUlid(ulid)
	}

	// --- action execution ---

	async executePageAction(action: (page: Page) => Promise<void>): Promise<BrowserActionResult> {
		const page = this.connection.getPage()
		if (!page) {
			throw new Error(
				"Browser is not launched. This may occur if the browser was automatically closed by a non-`browser_action` tool.",
			)
		}

		const logs: string[] = []
		let lastLogTs = Date.now()

		const LoggerListener = (msg: LoggerMessage) => {
			if (msg.type() === "log") {
				logs.push(msg.text())
			} else {
				logs.push(`[${msg.type()}] ${msg.text()}`)
			}
			lastLogTs = Date.now()
		}

		const errorListener = (err: Error) => {
			logs.push(`[Page Error] ${err.toString()}`)
			lastLogTs = Date.now()
		}

		page.on("Logger", LoggerListener)
		page.on("pageerror", errorListener)

		const isRemote = this.connection.getIsConnectedToRemote()
		const ulid = this.connection.getUlid()

		try {
			await action(page)
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err)

			if (!(err instanceof TimeoutError)) {
				logs.push(`[Error] ${errorMessage}`)
				if (ulid) {
					telemetryService.captureBrowserError(ulid, "browser_action_error", errorMessage, {
						isRemote,
						action: this.connection.getLastAction(),
					})
				}
			}
		}

		// Wait for console inactivity, with a timeout
		await pWaitFor(() => Date.now() - lastLogTs >= 500, {
			timeout: 3_000,
			interval: 100,
		}).catch(() => {})

		const options: ScreenshotOptions = { encoding: "base64" }
		const screenshotType = this.useWebp ? "webp" : "png"
		let screenshotBase64 = await page.screenshot({ ...options, type: screenshotType })
		let screenshot = `data:image/${screenshotType};base64,${screenshotBase64}`

		if (!screenshotBase64) {
			// retry screenshot as png regardless of initial type
			Logger.info(`${screenshotType} screenshot failed, trying png`)
			screenshotBase64 = await page.screenshot({ ...options, type: "png" })
			screenshot = `data:image/png;base64,${screenshotBase64}`
		}

		if (!screenshotBase64) {
			if (ulid) {
				telemetryService.captureBrowserError(ulid, "screenshot_error", "Failed to take screenshot", {
					isRemote,
					action: this.connection.getLastAction(),
				})
			}
			throw new Error("Failed to take screenshot.")
		}

		// page.removeAllListeners() crashes the page; just remove our listeners
		page.off("Logger", LoggerListener)
		page.off("pageerror", errorListener)

		return {
			screenshot,
			logs: logs.join("\n"),
			currentUrl: page.url(),
			currentMousePosition: this.currentMousePosition,
		}
	}

	async navigateToUrl(url: string): Promise<BrowserActionResult> {
		this.connection.trackAction(`navigate: url`)
		return this.executePageAction(async (page) => {
			// networkidle2 isn't good enough since page may take some time to load
			await page.goto(url, {
				timeout: 7_000,
				waitUntil: ["domcontentloaded", "networkidle2"],
			})
			await this.waitTillHTMLStable(page) // in case the page is loading more resources
		})
	}

	// page.goto { waitUntil: "networkidle0" } may not ever resolve; waiting ensures js has loaded
	// https://stackoverflow.com/questions/52497252/puppeteer-wait-until-page-is-completely-loaded/61304202#61304202
	private async waitTillHTMLStable(page: Page, timeout = 5_000) {
		const checkDurationMsecs = 500
		const maxChecks = timeout / checkDurationMsecs
		let lastHTMLSize = 0
		let checkCounts = 1
		let countStableSizeIterations = 0
		const minStableSizeIterations = 3

		while (checkCounts++ <= maxChecks) {
			const html = await page.content()
			const currentHTMLSize = html.length
			Logger.info("last: ", lastHTMLSize, " <> curr: ", currentHTMLSize)

			if (lastHTMLSize !== 0 && currentHTMLSize === lastHTMLSize) {
				countStableSizeIterations++
			} else {
				countStableSizeIterations = 0 // reset the counter
			}

			if (countStableSizeIterations >= minStableSizeIterations) {
				Logger.info("Page rendered fully...")
				break
			}

			lastHTMLSize = currentHTMLSize
			await setTimeoutPromise(checkDurationMsecs)
		}
	}

	async click(coordinate: string): Promise<BrowserActionResult> {
		this.connection.trackAction(`click: coordinate`)
		const [x, y] = coordinate.split(",").map(Number)
		return this.executePageAction(async (page) => {
			// monitor network activity to decide whether to wait for navigation
			let hasNetworkActivity = false
			const requestListener = () => {
				hasNetworkActivity = true
			}
			page.on("request", requestListener)

			await page.mouse.click(x, y)
			this.currentMousePosition = coordinate

			await setTimeoutPromise(100)

			if (hasNetworkActivity) {
				await page
					.waitForNavigation({
						waitUntil: ["domcontentloaded", "networkidle2"],
						timeout: 7000,
					})
					.catch(() => {})
				await this.waitTillHTMLStable(page)
			}

			page.off("request", requestListener)
		})
	}

	async type(text: string): Promise<BrowserActionResult> {
		this.connection.trackAction(`type:${text.length} chars`)
		return this.executePageAction(async (page) => {
			await page.keyboard.type(text)
		})
	}

	async scrollDown(): Promise<BrowserActionResult> {
		this.connection.trackAction("scrollDown")
		return this.executePageAction(async (page) => {
			await page.evaluate(() => {
				window.scrollBy({ top: 600, behavior: "auto" })
			})
			await setTimeoutPromise(300)
		})
	}

	async scrollUp(): Promise<BrowserActionResult> {
		this.connection.trackAction("scrollUp")
		return this.executePageAction(async (page) => {
			await page.evaluate(() => {
				window.scrollBy({ top: -600, behavior: "auto" })
			})
			await setTimeoutPromise(300)
		})
	}
}
