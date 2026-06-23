import { Controller } from "@core/controller"
import { BrowserActionResult } from "@shared/ExtensionMessage"
import { fileExistsAtPath } from "@utils/fs"
import axios from "axios"
import { spawn } from "child_process"
import * as chromeLauncher from "chrome-launcher"
import os from "os"
import * as path from "path"
import { Browser, connect, launch, Page } from "puppeteer-core"
import { StateManager } from "@/core/storage/StateManager"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { discoverChromeInstances, isPortOpen, testBrowserConnection } from "./BrowserDiscovery"
import { ensureChromiumExists } from "./utils"

export interface BrowserConnectionInfo {
	isConnected: boolean
	isRemote: boolean
	host?: string
}

const DEBUG_PORT = 9222 // Chrome's default debugging port

// helper to append custom browser args from UI; splits on spaces but keeps quoted chunks
function splitArgs(str?: string | null): string[] {
	if (!str) {
		return []
	}
	return (str.match(/"[^"]+"|\S+/g) || []).map((s) => s.replace(/^"(.*)"$/, "$1"))
}

/**
 * Owns the browser/page connection lifecycle: launch, connect, disconnect,
 * Chrome discovery, and connection-related telemetry. Action execution lives
 * in BrowserSession, which reads page/remote state from here.
 */
export class BrowserConnectionManager {
	private browser?: Browser
	private page?: Page
	private cachedWebSocketEndpoint?: string
	private lastConnectionAttempt = 0
	private isConnectedToRemote = false

	// Telemetry tracking — connection lifecycle emits start/end/error events
	private sessionStartTime = 0
	private browserActions: string[] = []
	private ulid?: string
	private stateManager: StateManager

	constructor(stateManager: StateManager) {
		this.stateManager = stateManager
	}

	// --- accessors for the action layer ---

	getPage(): Page | undefined {
		return this.page
	}

	setPage(page?: Page) {
		this.page = page
	}

	getBrowser(): Browser | undefined {
		return this.browser
	}

	getIsConnectedToRemote(): boolean {
		return this.isConnectedToRemote
	}

	getUlid(): string | undefined {
		return this.ulid
	}

	setUlid(ulid: string) {
		this.ulid = ulid
	}

	// record an action name for telemetry; called by BrowserSession action methods
	trackAction(name: string) {
		this.browserActions.push(name)
	}

	getLastAction(): string | undefined {
		return this.browserActions[this.browserActions.length - 1]
	}

	// --- connection info ---

	getConnectionInfo(): BrowserConnectionInfo {
		return {
			isConnected: !!this.browser,
			isRemote: this.isConnectedToRemote,
			host: this.isConnectedToRemote
				? this.stateManager.getGlobalSettingsKey("browserSettings").remoteBrowserHost
				: undefined,
		}
	}

	// --- discovery / testing ---

	async testConnection(host: string): Promise<{ success: boolean; message: string; endpoint?: string }> {
		return testBrowserConnection(host)
	}

	async getDetectedChromePath(): Promise<{ path: string; isBundled: boolean }> {
		// First check browserSettings (from UI, stored in global state)
		const browserSettings = this.stateManager.getGlobalSettingsKey("browserSettings")
		if (browserSettings.chromeExecutablePath && (await fileExistsAtPath(browserSettings.chromeExecutablePath))) {
			return {
				path: browserSettings.chromeExecutablePath,
				isBundled: false,
			}
		}

		// Then try to find system Chrome
		try {
			const systemPath = chromeLauncher.Launcher.getFirstInstallation()
			// validate path is not in Trash — chrome-launcher can return trashed paths on macOS
			if (systemPath && !systemPath.includes(".Trash") && (await fileExistsAtPath(systemPath))) {
				return { path: systemPath, isBundled: false }
			}
		} catch (error) {
			Logger.info("Could not find system Chrome:", error)
		}

		// Finally fall back to PCR's bundled version
		const stats = await ensureChromiumExists()
		return { path: stats.executablePath, isBundled: true }
	}

	async relaunchChromeDebugMode(_controller: Controller): Promise<string> {
		try {
			const userDataDir = path.join(os.tmpdir(), "chrome-debug-profile")
			const installation = chromeLauncher.Launcher.getFirstInstallation()
			if (!installation) {
				throw new Error("Could not find Chrome installation on this system")
			}
			Logger.info("chrome installation", installation)

			const userArgs = splitArgs(this.stateManager.getGlobalSettingsKey("browserSettings").customArgs)

			const args = [
				`--remote-debugging-port=${DEBUG_PORT}`,
				`--user-data-dir=${userDataDir}`,
				"--disable-notifications",
				...userArgs,
				"chrome://newtab",
			]

			// Spawn Chrome detached so it survives the parent process
			const chromeProcess = spawn(installation, args, {
				detached: true,
				stdio: "ignore",
				shell: false,
			})
			chromeProcess.unref()

			// Give Chrome a moment to start
			await new Promise((resolve) => setTimeout(resolve, 1000))

			const isRunning = await isPortOpen("localhost", DEBUG_PORT, 2000)
			if (!isRunning) {
				throw new Error("Chrome was launched but debug port is not responding")
			}

			return `Browser successfully launched with debug mode\nUsing: ${installation}`
		} catch (error) {
			throw new Error(`Failed to relaunch Chrome: ${error instanceof Error ? error.message : globalThis.String(error)}`)
		}
	}

	// --- launch / connect ---

	async launchBrowser() {
		if (this.browser) {
			await this.closeBrowser() // re-launch after a previous session
		}

		// Reset tracking + remote status for a fresh session
		this.sessionStartTime = Date.now()
		this.browserActions = []
		this.isConnectedToRemote = false

		const browserSettings = this.stateManager.getGlobalSettingsKey("browserSettings")

		if (browserSettings.remoteBrowserEnabled) {
			Logger.log(`launch browser called -- remote host mode (non-headless)`)
			try {
				await this.launchRemoteBrowser()
				// page is created inside launchRemoteBrowser
				if (this.ulid) {
					telemetryService.captureBrowserToolStart(this.ulid, browserSettings)
				}
				return
			} catch (error) {
				Logger.error("Failed to launch remote browser, falling back to local mode:", error)
				if (this.ulid) {
					telemetryService.captureBrowserError(
						this.ulid,
						"remote_browser_launch_error",
						error instanceof Error ? error.message : String(error),
						{
							isRemote: true,
							remoteBrowserHost: browserSettings.remoteBrowserHost,
						},
					)
				}
				await this.launchLocalBrowser()
			}
		} else {
			Logger.log(`launch browser called -- local mode (headless)`)
			await this.launchLocalBrowser()
		}

		this.page = await this.browser?.newPage()

		if (this.ulid) {
			telemetryService.captureBrowserToolStart(this.ulid, browserSettings)
		}
	}

	async launchLocalBrowser() {
		const browserSettings = this.stateManager.getGlobalSettingsKey("browserSettings")
		const { path } = await this.getDetectedChromePath()
		const userArgs = splitArgs(browserSettings.customArgs)
		this.browser = await launch({
			args: [
				"--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
				...userArgs,
			],
			executablePath: path,
			defaultViewport: browserSettings.viewport,
			headless: "shell", // Always headless for local connections
		})
		this.isConnectedToRemote = false
	}

	async launchRemoteBrowser() {
		const browserSettings = this.stateManager.getGlobalSettingsKey("browserSettings")
		let remoteBrowserHost = browserSettings.remoteBrowserHost
		let browserWSEndpoint: string | undefined = this.cachedWebSocketEndpoint
		let _reconnectionAttempted = false

		const getViewport = () => browserSettings.viewport

		// Auto-discover when no host is configured
		if (!remoteBrowserHost) {
			try {
				Logger.info("No remote browser host provided, trying auto-discovery")
				const discoveredHost = await discoverChromeInstances()
				if (discoveredHost) {
					Logger.info(`Auto-discovered Chrome at ${discoveredHost}`)
					remoteBrowserHost = discoveredHost
				}
			} catch (error) {
				Logger.log(`Auto-discovery failed: ${error}`)
			}
		}

		// Try cached endpoint first if recent (< 1 hour)
		if (browserWSEndpoint && Date.now() - this.lastConnectionAttempt < 3600000) {
			try {
				Logger.info(`Attempting to connect using cached WebSocket endpoint: ${browserWSEndpoint}`)
				this.browser = await connect({
					browserWSEndpoint,
					defaultViewport: getViewport(),
				})
				this.page = await this.browser?.newPage()
				this.isConnectedToRemote = true
				return
			} catch (error) {
				Logger.log(`Failed to connect using cached endpoint: ${error}`)
				if (this.ulid) {
					telemetryService.captureBrowserError(
						this.ulid,
						"cached_endpoint_connection_error",
						error instanceof Error ? error.message : String(error),
						{
							isRemote: true,
							endpoint: browserWSEndpoint,
						},
					)
				}
				this.cachedWebSocketEndpoint = undefined
				if (remoteBrowserHost) {
					_reconnectionAttempted = true
				}
			}
		}

		// Connect via host (user-provided or auto-discovered)
		if (remoteBrowserHost) {
			try {
				const versionUrl = `${remoteBrowserHost.replace(/\/$/, "")}/json/version`
				Logger.info(`Fetching WebSocket endpoint from ${versionUrl}`)

				const response = await axios.get(versionUrl)
				browserWSEndpoint = response.data.webSocketDebuggerUrl
				if (!browserWSEndpoint) {
					throw new Error("Could not find webSocketDebuggerUrl in the response")
				}

				Logger.info(`Found WebSocket browser endpoint: ${browserWSEndpoint}`)
				this.cachedWebSocketEndpoint = browserWSEndpoint
				this.lastConnectionAttempt = Date.now()

				this.browser = await connect({
					browserWSEndpoint,
					defaultViewport: getViewport(),
				})
				this.page = await this.browser?.newPage()
				this.isConnectedToRemote = true
				return
			} catch (error) {
				Logger.log(`Failed to connect to remote browser: ${error}`)
				if (this.ulid) {
					telemetryService.captureBrowserError(
						this.ulid,
						"remote_host_connection_error",
						error instanceof Error ? error.message : String(error),
						{
							isRemote: true,
							remoteBrowserHost,
						},
					)
				}
			}
		}

		throw new Error(
			"Failed to connect to remote browser. Make sure Chrome is running with remote debugging enabled (--remote-debugging-port=9222).",
		)
	}

	// --- disconnect ---

	async closeBrowser(): Promise<BrowserActionResult> {
		if (this.browser || this.page) {
			// Emit end telemetry for the session
			if (this.ulid && this.sessionStartTime > 0) {
				const sessionDuration = Date.now() - this.sessionStartTime
				telemetryService.captureBrowserToolEnd(this.ulid, {
					actionCount: this.browserActions.length,
					duration: sessionDuration,
					actions: this.browserActions,
				})
			}

			if (this.isConnectedToRemote && this.browser) {
				if (this.page) {
					await this.page.close().catch(() => {})
					Logger.info("closed remote browser tab...")
				}
				await this.browser.disconnect().catch(() => {})
				Logger.info("disconnected from remote browser...")
			} else if (this.isConnectedToRemote === false) {
				await this.browser?.close().catch(() => {})
				Logger.info("closed local browser...")
			}

			this.browser = undefined
			this.page = undefined
			this.isConnectedToRemote = false

			this.sessionStartTime = 0
			this.browserActions = []
		}
		return {}
	}

	async dispose() {
		await this.closeBrowser()
	}
}
