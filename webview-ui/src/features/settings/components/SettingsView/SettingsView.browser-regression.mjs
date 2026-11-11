// Run from the repository root: node --test webview-ui/src/features/settings/components/SettingsView/SettingsView.browser-regression.mjs
// SETTINGS_NAV_BASELINE=1 runs the same regression against HEAD's pre-fix component/CSS.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { chromium } from "playwright"

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, "../../../../../..")
const webview = resolve(root, "webview-ui")
const require = createRequire(resolve(webview, "package.json"))
const componentPath = "webview-ui/src/features/settings/components/SettingsView/SettingsView.tsx"
const cssPath = "webview-ui/src/app/styles/main.css"
const source = (path) =>
	process.env.SETTINGS_NAV_BASELINE
		? Promise.resolve(execFileSync("git", ["show", `HEAD:${path}`], { cwd: root, encoding: "utf8" }))
		: readFile(resolve(root, path), "utf8")

// Isolate settings content/backend services, but retain the real Tab components, Radix tooltips,
// navigation component and navigation CSS. No application/login/extension host is required.
const fixturePlugin = {
	name: "settings-navigation-fixture",
	setup(builder) {
		builder.onResolve(
			{
				filter: /^(\.\.\/sections\/|@\/shared\/ui\/ViewHeader$|@\/features\/settings\/store\/settingsStore$|@\/shared\/api\/grpc-client$|@shared\/proto\/dirac\/state$)/,
			},
			(args) => ({ path: args.path, namespace: "fixture" }),
		)
		builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => {
			if (path.endsWith("settingsStore"))
				return {
					contents: 'export const useSettingsStore = selector => selector({version:"test", environment:"production"})',
				}
			if (path.endsWith("grpc-client")) return { contents: "export const StateServiceClient = {}" }
			if (path.endsWith("dirac/state")) return { contents: "export const ResetStateRequest = {}" }
			return { contents: "export default () => null" }
		})
		builder.onLoad({ filter: /SettingsView\.tsx$/ }, async () => ({
			contents: await source(componentPath),
			loader: "tsx",
			resolveDir: directory,
		}))
	},
}

let browser
let server
let origin
before(async () => {
	const bundle = await build({
		stdin: {
			contents: `import React from "react"; import {createRoot} from "react-dom/client"; import SettingsView from ${JSON.stringify(resolve(root, componentPath))}; createRoot(document.getElementById("root")).render(React.createElement(SettingsView,{onDone(){}}));`,
			resolveDir: webview,
			loader: "tsx",
		},
		bundle: true,
		write: false,
		format: "iife",
		jsx: "automatic",
		define: { "process.env.IS_DEV": '"false"', "process.env.NODE_ENV": '"test"' },
		alias: {
			"@": resolve(webview, "src"),
			"@shared": resolve(root, "src/shared"),
			react: dirname(require.resolve("react/package.json")),
			"react-dom": dirname(require.resolve("react-dom/package.json")),
		},
		plugins: [fixturePlugin],
	})
	const css = await source(cssPath)
	server = createServer((request, response) => {
		if (request.url === "/fixture.js") {
			response.setHeader("Content-Type", "text/javascript")
			response.end(bundle.outputFiles[0].text)
			return
		}
		response.setHeader("Content-Type", "text/html")
		response.end(`<!doctype html><html><head><style>
			${css}
			/* The layout utilities used by the real Tab/SettingsView; navigation rules above are unmodified. */
			.dirac-tab {position:fixed;inset:0;display:flex;flex-direction:column}
			.flex {display:flex}.flex-col {flex-direction:column}.flex-1 {flex:1 1 0%}
			.overflow-hidden {overflow:hidden}.overflow-auto {overflow:auto}.min-w-0 {min-width:0}
			:root {--vscode-editor-background:#202020;--vscode-sideBar-background:#181818;--vscode-foreground:#fff}
			[role=tabpanel] {background:magenta} button {font:13px sans-serif}
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

async function openPage() {
	const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
	await page.goto(origin)
	await page.getByRole("navigation").waitFor({ timeout: 5000 })
	return page
}
async function expanded(page) {
	return page.getByRole("navigation").getAttribute("data-expanded")
}
async function nextFrames(page) {
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

describe("settings navigation in Chromium", () => {
	it("survives rapid movement from the rail into labels before the former width animation completes", async () => {
		const page = await openPage()
		try {
			await page.mouse.move(400, 90)
			await page.mouse.move(18, 90)
			assert.equal(await expanded(page), "true")
			await page.mouse.move(175, 90)
			await page.waitForTimeout(180) // Past the former 140ms animation, not a product hide delay.
			assert.equal(await expanded(page), "true", "rapid in-menu movement must not collapse navigation")
			for (const [x, y] of [
				[50, 120],
				[180, 280],
				[70, 40],
				[170, 330],
			]) {
				await page.mouse.move(x, y)
				assert.equal(await expanded(page), "true")
			}
			await page.mouse.move(350, 330)
			await nextFrames(page)
			assert.equal(await expanded(page), "false", "a confirmed physical exit collapses")
		} finally {
			await page.close()
		}
	})

	it("ignores portal/child leave and focus churn while the pointer is inside the menu", async () => {
		const page = await openPage()
		try {
			await page.mouse.move(18, 18)
			await page.waitForTimeout(180)
			await page.mouse.move(120, 18)
			await page.getByRole("tab", { name: "Tools", exact: true }).click()
			await page.evaluate(() => {
				const nav = document.querySelector("nav")
				const portal =
					document.querySelector('[data-slot="tooltip-content"]') ||
					document.body.appendChild(document.createElement("div"))
				nav.dispatchEvent(
					new PointerEvent("pointerout", {
						bubbles: true,
						pointerType: "mouse",
						clientX: 120,
						clientY: 198,
						relatedTarget: portal,
					}),
				)
				document.activeElement.blur()
			})
			await nextFrames(page)
			assert.equal(await expanded(page), "true")
			await page.mouse.move(400, 198)
			await nextFrames(page)
			assert.equal(await expanded(page), "false")
		} finally {
			await page.close()
		}
	})

	it("keeps keyboard focus open across pointer exits and arrow selection, but Escape dismisses", async () => {
		const page = await openPage()
		try {
			await page.mouse.move(400, 90)
			await page.keyboard.press("Tab")
			await page.keyboard.press("ArrowDown")
			assert.equal(await page.locator("#settings-tab-utility-model").getAttribute("aria-selected"), "true")
			await page.mouse.move(18, 90)
			await page.mouse.move(400, 90)
			await nextFrames(page)
			assert.equal(await expanded(page), "true")
			await page.keyboard.press("Escape")
			assert.equal(await expanded(page), "false")
		} finally {
			await page.close()
		}
	})

	it("has an opaque backing for alpha theme surfaces with VSCode and OS themes mismatched", async () => {
		const page = await openPage()
		try {
			for (const [theme, os, expectedScheme] of [
				["vscode-dark", "light", "dark"],
				["vscode-light", "dark", "light"],
				["vscode-high-contrast", "light", "dark"],
				["vscode-high-contrast-light", "dark", "light"],
			]) {
				await page.emulateMedia({ colorScheme: os })
				await page.evaluate((theme) => {
					document.body.className = theme
					document.documentElement.style.setProperty("--vscode-editor-background", "rgba(60, 80, 100, 0.4)")
				}, theme)
				await page.mouse.move(18, 500)
				await page.waitForTimeout(180)
				const clip = { x: 80, y: 550, width: 8, height: 8 }
				const before = await page.screenshot({ clip })
				await page.getByRole("tabpanel").evaluate((panel) => {
					panel.style.background = "lime"
				})
				const after = await page.screenshot({ clip })
				assert.deepEqual(before, after, `${theme}: underlying content must not show through`)
				assert.equal(await page.locator("nav").evaluate((nav) => getComputedStyle(nav).colorScheme), expectedScheme)
				await page.getByRole("tabpanel").evaluate((panel) => {
					panel.style.background = "magenta"
				})
			}
		} finally {
			await page.close()
		}
	})
})
