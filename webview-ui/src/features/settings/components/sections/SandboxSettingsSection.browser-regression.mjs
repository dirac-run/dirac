// Run from the repository root:
// node --test webview-ui/src/features/settings/components/sections/SandboxSettingsSection.browser-regression.mjs
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { build } from "esbuild"
import { chromium } from "playwright"
import { build as buildCss } from "vite"

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, "../../../../../..")
const webview = resolve(root, "webview-ui")
const require = createRequire(resolve(webview, "package.json"))
const section = resolve(directory, "SandboxSettingsSection.tsx")
const longName = `Personal offline ${"long-custom-profile-name-".repeat(3)}policy`

// Keep the actual section, editor, toolkit checkbox, shared Select/Button and
// policy validation. Only store, persistence and host RPC boundaries are replaced.
const storeFixture = `
import {create} from "zustand";
import {DEFAULT_SANDBOX_SETTINGS} from "@shared/SandboxSettings";
import {sandboxProfileDraft, sandboxProfileFromDraft} from "@shared/settings-presentation";
const parameters = new URLSearchParams(location.search);
const saved = localStorage.getItem("sandbox-browser-settings");
const initial = saved ? JSON.parse(saved) : {
  ...DEFAULT_SANDBOX_SETTINGS, enabled: !parameters.has("off"),
  profiles: [sandboxProfileFromDraft({...sandboxProfileDraft(), name: ${JSON.stringify(longName)}, network: "deny"}, "personal-offline", 3)]
};
export const useSettingsStore = create(set => ({sandboxSettings: initial, setSettings: updates => set(updates)}));
window.fixtureStore = useSettingsStore;
window.fixtureRequests = [];
window.fixtureFailSave = false;
window.fixtureFailStatus = parameters.has("status-error");
window.fixtureStatus = {
  hostPlatform: "linux", backend: "bubblewrap", available: true, effectiveState: "native", limitations: [],
  ...(parameters.has("blocked") ? {effectiveState: "blocked", error: "Sandbox backend unavailable", remediation: "Install the host sandbox backend", limitations: ["Fixture host limitation"]} : {})
};
`

const fixturePlugin = {
	name: "sandbox-browser-fixture",
	setup(builder) {
		builder.onResolve(
			{ filter: /^(@\/features\/settings\/store\/settingsStore|@\/shared\/api\/grpc-client|\.\.\/utils\/settingsHandlers)$/ },
			(args) => ({ path: args.path, namespace: "fixture" }),
		)
		builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => {
			if (path.endsWith("settingsStore")) return { contents: storeFixture, resolveDir: webview }
			if (path.endsWith("settingsHandlers")) return {
				contents: `export async function persistSetting(key, value) {
          window.fixtureRequests.push({key, value: structuredClone(value)});
          if (window.fixtureFailSave) throw new Error("Fixture save rejected");
          localStorage.setItem("sandbox-browser-settings", JSON.stringify(value));
          window.fixtureStore.getState().setSettings({[key]: value});
        }`,
			}
			return {
				contents: `export const StateServiceClient = {async getSandboxStatus() {
          if (window.fixtureFailStatus) throw new Error("Fixture host disconnected");
          return structuredClone(window.fixtureStatus);
        }};`,
			}
		})
	},
}

let browser
let server
let origin
before(async () => {
	const [bundle, cssBuild] = await Promise.all([
		build({
			stdin: {
				contents: `import React from "react"; import {createRoot} from "react-dom/client"; import SandboxSettingsSection from ${JSON.stringify(section)}; createRoot(document.getElementById("root")).render(React.createElement(SandboxSettingsSection, {renderSectionHeader: () => null}));`,
				resolveDir: webview,
				loader: "tsx",
			},
			bundle: true,
			write: false,
			format: "iife",
			jsx: "automatic",
			define: { __PLATFORM__: '"vscode"', "process.env.IS_DEV": '"false"', "process.env.NODE_ENV": '"test"' },
			alias: {
				"@": resolve(webview, "src"),
				"@shared": resolve(root, "src/shared"),
				react: dirname(require.resolve("react/package.json")),
				"react-dom": dirname(require.resolve("react-dom/package.json")),
			},
			plugins: [fixturePlugin],
		}),
		// Compile the real application stylesheet and Tailwind theme/source scan.
		// No fixture CSS imitates utilities, popup layout or component styling.
		buildCss({
			configFile: false,
			root: webview,
			logLevel: "error",
			plugins: [tailwindcss()],
			build: {
				write: false,
				minify: false,
				rollupOptions: { input: resolve(webview, "src/app/styles/index.css") },
			},
		}),
	])
	const css = cssBuild.output.filter((output) => output.type === "asset" && output.fileName.endsWith(".css")).map((output) => output.source).join("\n")
	assert.ok(css.includes(".bg-button-background"), "Compile the real shared Button styling")
	server = createServer((request, response) => {
		if (request.url === "/fixture.js") {
			response.setHeader("Content-Type", "text/javascript")
			response.end(bundle.outputFiles[0].text)
			return
		}
		if (request.url === "/fixture.css") {
			response.setHeader("Content-Type", "text/css")
			response.end(css)
			return
		}
		response.setHeader("Content-Type", "text/html")
		response.end(`<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"><style>
      /* VS Code supplies tokens; all layout/control rules are application CSS. */
      :root { --vscode-font-family: sans-serif; --vscode-font-size: 13px;
        --vscode-foreground: #eeeeee; --vscode-editor-background: #202020; --vscode-sideBar-background: #202020;
        --vscode-descriptionForeground: #cccccc; --vscode-panel-border: #555555; --vscode-errorForeground: #ff9999;
        --vscode-button-background: #007acc; --vscode-button-hoverBackground: #006ab1; --vscode-button-foreground: #ffffff;
        --vscode-button-secondaryBackground: #3a3d41; --vscode-button-secondaryForeground: #ffffff;
        --vscode-button-secondaryHoverBackground: #45494e;
        --vscode-input-background: #333333; --vscode-input-foreground: #ffffff; --vscode-input-border: #777777;
        --vscode-dropdown-background: #333333; --vscode-dropdown-foreground: #ffffff; --vscode-dropdown-border: #777777;
        --vscode-list-activeSelectionBackground: #094771; --vscode-list-activeSelectionForeground: #ffffff;
        --vscode-focusBorder: #00aaff;
      }
    </style></head><body class="vscode-dark"><div id="root"></div><script src="/fixture.js"></script></body></html>`)
	})
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
	origin = `http://127.0.0.1:${server.address().port}`
	browser = await chromium.launch({ headless: true })
})
after(async () => {
	await browser?.close()
	if (server) await new Promise((resolve) => server.close(resolve))
})

async function openPage(query = "", width = 800) {
	const page = await browser.newPage({ viewport: { width, height: 900 } })
	page.fixtureErrors = []
	page.on("pageerror", (error) => page.fixtureErrors.push(error.message))
	page.setDefaultTimeout(5000)
	await page.goto(`${origin}/${query}`)
	await page.getByRole("checkbox", { name: "Sandbox commands", exact: true }).waitFor()
	return page
}

const assignments = (page) => page.evaluate(() => window.fixtureStore.getState().sandboxSettings)
const mainProfile = (page) => page.getByRole("combobox", { name: "Main-agent profile", exact: true })
const subagentProfile = (page) => page.getByRole("combobox", { name: "Subagent profile", exact: true })

async function closePage(page) {
	assert.deepEqual(page.fixtureErrors, [], "No uncaught browser errors")
	await page.close()
}

async function assertFocus(locator) {
	await locator.page().waitForFunction((element) => document.activeElement === element, await locator.elementHandle())
}

async function assertThemedPopup(page) {
	const popup = page.getByRole("listbox")
	await popup.waitFor()
	assert.equal(await popup.getAttribute("data-slot"), "select-content", "Use the actual shared Radix popup")
	assert.equal(await popup.evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(51, 51, 51)")
	assert.equal(await popup.evaluate((element) => getComputedStyle(element).color), "rgb(255, 255, 255)")
	assert.equal(await popup.evaluate((element) => getComputedStyle(element).borderTopWidth), "1px")
	// Radix adds a clipped 1px native select inside forms for form submission.
	// Playwright calls that box visible; it must never be a user-visible control.
	const nativeControls = await page.locator("select").evaluateAll((elements) => elements.filter((element) => {
		const box = element.getBoundingClientRect()
		return box.width > 1 && box.height > 1 && getComputedStyle(element).visibility !== "hidden"
	}).length)
	assert.equal(nativeControls, 0, "No visible browser-native dropdown")
}

async function assertNoHorizontalOverflow(page) {
	const dimensions = await page.evaluate(() => ({
		viewport: document.documentElement.clientWidth,
		document: document.documentElement.scrollWidth,
		body: document.body.scrollWidth,
		controls: [...document.querySelectorAll('#sandbox-settings, form, [data-slot="select-trigger"], [data-slot="select-content"]')]
			.filter((element) => element.getClientRects().length)
			.map((element) => ({ slot: element.getAttribute("data-slot") ?? element.tagName, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })),
	}))
	assert.ok(dimensions.document <= dimensions.viewport, JSON.stringify(dimensions))
	assert.ok(dimensions.body <= dimensions.viewport, JSON.stringify(dimensions))
	for (const control of dimensions.controls) {
		assert.ok(control.left >= -1 && control.right <= dimensions.viewport + 1, JSON.stringify({ ...control, viewport: dimensions.viewport }))
	}
}

async function chooseOption(page, trigger, name) {
	await trigger.click()
	await page.getByRole("option", { name, exact: true }).click()
	await page.getByRole("listbox").waitFor({ state: "hidden" })
	await trigger.waitFor({ state: "visible" })
	await page.waitForFunction((element) => !element.disabled, await trigger.elementHandle())
}

describe("Sandbox settings UX in real Chromium", () => {
	it("renders themed controls and groups with runtime details collapsed, preserving the disabled view", async () => {
		const page = await openPage()
		try {
			assert.equal(await page.getByText("Agent profiles", { exact: true }).isVisible(), true)
			assert.equal(await page.getByText("Saved profiles", { exact: true }).isVisible(), true)
			for (const trigger of [mainProfile(page), subagentProfile(page)]) {
				assert.equal(await trigger.getAttribute("data-slot"), "select-trigger")
				assert.equal(await trigger.textContent().then((text) => text.trim()), "Default (unrestricted)")
				assert.equal(await trigger.evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(51, 51, 51)")
			}
			const newButton = page.getByRole("button", { name: "New", exact: true })
			const manage = page.getByRole("button", { name: "Manage", exact: true })
			assert.equal(await newButton.evaluate((element) => element.tagName), "BUTTON")
			assert.equal(await newButton.evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(0, 122, 204)")
			assert.equal(await manage.evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(58, 61, 65)")
			assert.equal(await manage.getAttribute("aria-expanded"), "false")
			assert.equal(await page.getByText(/Host: linux/).isVisible(), false)
			await page.getByText("Details and advanced settings", { exact: true }).click()
			assert.equal(await page.getByText(/Host: linux.*Backend: bubblewrap/).isVisible(), true)
		} finally { await closePage(page) }

		const off = await openPage("?off")
		try {
			assert.equal(await off.getByText("Sandbox is disabled.", { exact: true }).isVisible(), true)
			assert.equal(await off.getByRole("combobox").count(), 0)
			assert.equal(await off.getByRole("button", { name: "New", exact: true }).count(), 0)
			assert.equal(await off.getByText("Details and advanced settings", { exact: true }).count(), 0)
		} finally { await closePage(off) }
	})

	it("opens the actual themed popup, restores focus on Escape, and persists keyboard assignments across reload", async () => {
		const page = await openPage()
		try {
			const main = mainProfile(page)
			await main.focus()
			await main.press("Space")
			await assertThemedPopup(page)
			assert.equal(await page.getByRole("option").count(), 5)
			await page.keyboard.press("Escape")
			await page.getByRole("listbox").waitFor({ state: "hidden" })
			await assertFocus(main)
			assert.equal(await page.evaluate(() => window.fixtureRequests.length), 0, "Escape does not save")
			await main.press("ArrowDown")
			await assertThemedPopup(page)
			await page.keyboard.press("Home")
			await assertFocus(page.getByRole("option", { name: "Default (unrestricted)", exact: true }))
			await page.keyboard.press("ArrowDown")
			await assertFocus(page.getByRole("option", { name: "Workspace", exact: true }))
			await page.keyboard.press("Enter")
			await page.waitForFunction(() => window.fixtureStore.getState().sandboxSettings.mainAgentProfileId === "builtin-workspace")
			await assertFocus(main)
			await chooseOption(page, subagentProfile(page), longName)
			const saved = await assignments(page)
			assert.equal(saved.subagentProfileId, "personal-offline")
			assert.equal(saved.mainAgentProfileId, "builtin-workspace")
			const requests = await page.evaluate(() => window.fixtureRequests)
			assert.equal(requests.length, 2)
			assert.ok(requests.every((request) => request.key === "sandboxSettings"))
			assert.deepEqual(requests[1].value, saved)
			await page.reload()
			await mainProfile(page).waitFor()
			assert.deepEqual(await assignments(page), saved)
			assert.match(await mainProfile(page).textContent(), /Workspace/)
			assert.ok((await subagentProfile(page).textContent()).includes(longName))
		} finally { await closePage(page) }
	})

	it("keeps host and save failures visible outside collapsed details and preserves rejected assignments", async () => {
		const page = await openPage("?blocked&status-error")
		try {
			await page.getByRole("alert").filter({ hasText: "Fixture host disconnected" }).waitFor()
			await page.evaluate(() => { window.fixtureFailStatus = false })
			await page.getByRole("button", { name: "Retry status" }).click()
			await page.getByText("Sandbox backend unavailable", { exact: true }).waitFor()
			assert.equal(await page.getByText("Install the host sandbox backend", { exact: true }).isVisible(), true)
			assert.equal(await page.getByText("Fixture host limitation", { exact: true }).isVisible(), true)
			assert.equal(await page.getByText(/Host: linux/).isVisible(), false)
			const before = await assignments(page)
			await page.evaluate(() => { window.fixtureFailSave = true })
			await chooseOption(page, mainProfile(page), "Workspace")
			await page.getByRole("alert").filter({ hasText: "Could not save sandbox settings: Error: Fixture save rejected" }).waitFor()
			assert.deepEqual(await assignments(page), before)
			assert.match(await mainProfile(page).textContent(), /Default \(unrestricted\)/)
			assert.equal(await page.evaluate(() => localStorage.getItem("sandbox-browser-settings")), null)
		} finally { await closePage(page) }
	})

	for (const width of [320, 800]) {
		it(`fits ${width}px with long names, Manage, editor and themed advanced popup, saving edits without assigning`, async () => {
			const page = await openPage("", width)
			try {
				const before = await assignments(page)
				await chooseOption(page, mainProfile(page), longName)
				await assertNoHorizontalOverflow(page)
				const mainBox = await mainProfile(page).boundingBox()
				const subBox = await subagentProfile(page).boundingBox()
				if (width === 320) {
					assert.ok(subBox.y >= mainBox.y + mainBox.height, "Narrow assignments stack vertically")
				} else {
					assert.ok(Math.abs(subBox.y - mainBox.y) < 1 && subBox.x > mainBox.x, "Wide assignments share a row")
				}
				await mainProfile(page).click()
				await assertThemedPopup(page)
				await assertNoHorizontalOverflow(page)
				await page.keyboard.press("Escape")
				await page.getByRole("button", { name: "Manage", exact: true }).click()
				await page.getByRole("button", { name: `Edit ${longName}`, exact: true }).waitFor()
				assert.equal(await page.getByRole("button", { name: "Manage", exact: true }).getAttribute("aria-expanded"), "true")
				await assertNoHorizontalOverflow(page)
				await page.getByRole("button", { name: `Edit ${longName}`, exact: true }).click()
				const name = page.getByRole("textbox", { name: "Name", exact: true })
				await assertFocus(name)
				assert.equal(await name.inputValue(), longName)
				await assertNoHorizontalOverflow(page)
				await page.getByText("Advanced", { exact: true }).click()
				const base = page.getByRole("combobox", { name: "Filesystem base", exact: true })
				await base.focus()
				await base.press("Space")
				await assertThemedPopup(page)
				await assertNoHorizontalOverflow(page)
				await page.keyboard.press("Escape")
				await page.getByRole("listbox").waitFor({ state: "hidden" })
				await assertFocus(base)
				await base.press("ArrowDown")
				await page.keyboard.press("End")
				await assertFocus(page.getByRole("option", { name: "Entire host filesystem (read-only)", exact: true }))
				await page.keyboard.press("Enter")
				await page.getByRole("listbox").waitFor({ state: "hidden" })
				await assertNoHorizontalOverflow(page)
				await page.getByRole("button", { name: "Save profile", exact: true }).click()
				await mainProfile(page).waitFor()
				const saved = await assignments(page)
				assert.equal(saved.profiles[0].filesystem.base, "broad-read")
				assert.equal(saved.mainAgentProfileId, "personal-offline")
				assert.equal(saved.subagentProfileId, before.subagentProfileId)
				await assertNoHorizontalOverflow(page)
				await page.getByRole("button", { name: "New", exact: true }).click()
				await assertFocus(page.getByRole("textbox", { name: "Name", exact: true }))
				await page.getByRole("button", { name: "Save profile", exact: true }).click()
				await page.getByRole("alert").filter({ hasText: /Invalid sandbox profile name/ }).waitFor()
				await assertNoHorizontalOverflow(page)
				await page.getByRole("button", { name: "Cancel", exact: true }).click()
				assert.deepEqual(await assignments(page), saved, "Invalid draft/cancel never changes saved profiles")
			} finally { await closePage(page) }
		})
	}
})
