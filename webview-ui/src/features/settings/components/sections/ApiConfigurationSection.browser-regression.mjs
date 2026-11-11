// Run from the repository root:
// node --test webview-ui/src/features/settings/components/sections/ApiConfigurationSection.browser-regression.mjs
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
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
const section = resolve(directory, "ApiConfigurationSection.tsx")
const options = resolve(directory, "../ApiOptions.tsx")

// Keep the real section, selector, shared Button, VSCodeTextField, summaries and save
// handlers. Only backend/store boundaries and unrelated provider forms are isolated.
const storeFixture = `
import {create} from "zustand";
const parameters = new URLSearchParams(location.search);
export const useSettingsStore = create(set => ({
  configuredApiProviders: parameters.has("empty") ? [] : ["anthropic"],
  apiConfiguration: {
    planModeApiProvider: "anthropic", actModeApiProvider: "anthropic",
    planModeApiModelId: "plan-model", actModeApiModelId: "act-model",
    ...(parameters.has("profiles") ? {openAiCompatibleProfiles: [{
      name: "A very long configured endpoint profile name with spaces",
      baseUrl: "https://example.invalid/" + "long-endpoint-segment/".repeat(8)
    }]} : {})
  },
  remoteConfigSettings: {}, planActSeparateModelsSetting: true,
  pendingApiConfigurationUpdates: {},
  setSettings: updates => set(updates)
}));
window.fixtureStore = useSettingsStore;
window.fixtureRequests = [];
window.fixtureFailSave = false;
`

const fixturePlugin = {
	name: "api-provider-browser-fixture",
	setup(builder) {
		builder.onResolve(
			{ filter: /^(@\/features\/settings\/store\/settingsStore|@\/shared\/api\/grpc-client|@\/shared\/ui\/hooks\/useOpenRouterKeyInfo|\.\/OpenRouterModelPicker)$/ },
			(args) => ({ path: args.path, namespace: "fixture" }),
		)
		builder.onResolve({ filter: /^\.\/providers\// }, (args) => ({ path: args.path, namespace: "provider-fixture" }))
		builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => {
			if (path.endsWith("settingsStore")) return { contents: storeFixture, resolveDir: webview }
			if (path.endsWith("grpc-client")) return {
				contents: `export const ModelsServiceClient = {async updateApiConfigurationPartial(request) {
          window.fixtureRequests.push(request);
          if (window.fixtureFailSave) throw new Error("Fixture save rejected");
          const store = window.fixtureStore.getState();
          if (request.setupProvider && !store.configuredApiProviders.includes(request.setupProvider))
            store.setSettings({configuredApiProviders: [...store.configuredApiProviders, request.setupProvider]});
        }};`,
			}
			if (path.endsWith("useOpenRouterKeyInfo")) return { contents: "export const useOpenRouterKeyInfo = () => ({data:null})" }
			return { contents: "export const OPENROUTER_MODEL_PICKER_Z_INDEX = 1000" }
		})
		builder.onLoad({ filter: /.*/, namespace: "provider-fixture" }, async ({ path }) => {
			const source = await readFile(options, "utf8")
			const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			const match = source.match(new RegExp(`import \\{ (\\w+) \\} from "${escaped}"`))
			assert.ok(match, `Missing provider import for ${path}`)
			return {
				contents: `import React from "react"; export const ${match[1]} = () => React.createElement("div", {"data-provider-content": ${JSON.stringify(match[1])}}, "Provider connection fields");`,
				resolveDir: webview,
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
				contents: `import React from "react"; import {createRoot} from "react-dom/client"; import ApiConfigurationSection from ${JSON.stringify(section)}; createRoot(document.getElementById("root")).render(React.createElement(ApiConfigurationSection));`,
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
		// Compile the actual application CSS with its real Tailwind plugin/theme and
		// source scanning, in memory: no fixture rules imitating utility classes.
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
	assert.ok(css.includes(".bg-button-background"), "Tailwind must generate real shared Button styling")
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
      /* VS Code supplies these theme tokens; layout and button rules come exclusively from application CSS. */
      :root { --vscode-font-family: sans-serif; --vscode-font-size: 13px;
        --vscode-foreground: #eeeeee; --vscode-editor-background: #202020; --vscode-sideBar-background: #202020;
        --vscode-descriptionForeground: #cccccc; --vscode-panel-border: #555555;
        --vscode-button-background: #007acc; --vscode-button-hoverBackground: #006ab1; --vscode-button-foreground: #ffffff;
        --vscode-button-secondaryBackground: #3a3d41; --vscode-button-secondaryForeground: #ffffff;
        --vscode-button-secondaryHoverBackground: #45494e;
        --vscode-input-background: #333333; --vscode-input-foreground: #ffffff; --vscode-input-border: #777777;
        --vscode-dropdown-background: #333333; --vscode-list-activeSelectionBackground: #094771;
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
	const page = await browser.newPage({ viewport: { width, height: 700 } })
	page.fixtureErrors = []
	page.on("pageerror", (error) => page.fixtureErrors.push(error.message))
	await page.goto(`${origin}/${query}`)
	await page.getByRole("button", { name: /Add provider/ }).waitFor({ timeout: 5000 })
	return page
}

function selector(page) {
	// Playwright pierces the actual toolkit web component's shadow root.
	return page.locator("vscode-text-field#api-provider input")
}

async function chooseGroqWithKeyboard(page) {
	await selector(page).fill("Groq")
	await page.getByRole("option", { name: "Groq", exact: true }).waitFor()
	await selector(page).press("ArrowDown")
	await selector(page).press("Enter")
	await page.locator('[data-provider-content="GroqProvider"]').waitFor()
	assert.equal(await page.getByRole("listbox").count(), 0)
}

async function assertNoHorizontalOverflow(page) {
	const dimensions = await page.evaluate(() => ({
		viewport: document.documentElement.clientWidth,
		document: document.documentElement.scrollWidth,
		body: document.body.scrollWidth,
		section: document.querySelector(".settings-section").getBoundingClientRect().right,
	}))
	assert.ok(dimensions.document <= dimensions.viewport, JSON.stringify(dimensions))
	assert.ok(dimensions.body <= dimensions.viewport, JSON.stringify(dimensions))
	assert.ok(dimensions.section <= dimensions.viewport, JSON.stringify(dimensions))
}

async function activeConfiguration(page) {
	return page.evaluate(() => window.fixtureStore.getState().apiConfiguration)
}

async function closePage(page) {
	assert.deepEqual(page.fixtureErrors, [], "No uncaught browser errors")
	await page.close()
}

describe("API providers UX in real Chromium", () => {
	it("renders real styled add/edit buttons and opens a blank add panel instead of editing the active provider", async () => {
		const page = await openPage()
		try {
			const add = page.getByRole("button", { name: /Add provider/ })
			const edit = page.getByRole("button", { name: "Edit Anthropic setup" })
			assert.equal(await add.isVisible(), true)
			assert.equal(await edit.isVisible(), true)
			assert.equal(await add.evaluate((button) => getComputedStyle(button).backgroundColor), "rgb(0, 122, 204)")
			assert.equal(await edit.evaluate((button) => getComputedStyle(button).backgroundColor), "rgb(58, 61, 65)")
			await add.click()
			await selector(page).waitFor()
			assert.equal(await selector(page).inputValue(), "")
			assert.equal(await page.locator("[data-provider-content]").count(), 0, "Active provider must not prepopulate add setup")
			assert.equal(await page.getByRole("button", { name: "Add provider", exact: true }).count(), 0, "No add action before a provider is chosen")
			await page.getByRole("button", { name: "Back to providers" }).click()
			await edit.click()
			await page.locator('[data-provider-content="AnthropicProvider"]').waitFor()
			assert.equal(await page.getByRole("heading", { name: "Anthropic setup" }).isVisible(), true)
			assert.equal(await page.locator("#api-provider").count(), 0, "Editing must not present a provider picker")
			assert.equal(await page.getByRole("button", { name: /Add provider/ }).count(), 0, "Editing must not suggest adding the existing provider")
			assert.equal(await page.getByText("This provider is added.", { exact: false }).count(), 0)
		} finally { await closePage(page) }
	})

	it("searches and selects using the keyboard, reopens after Escape, adds with feedback, and preserves active selections", async () => {
		const page = await openPage()
		try {
			const before = await activeConfiguration(page)
			await page.getByRole("button", { name: /Add provider/ }).click()
			await selector(page).focus()
			await page.getByRole("listbox").waitFor()
			await selector(page).press("Escape")
			assert.equal(await page.getByRole("listbox").count(), 0)
			await selector(page).press("ArrowDown")
			await page.getByRole("listbox").waitFor()
			await chooseGroqWithKeyboard(page)
			assert.deepEqual(await activeConfiguration(page), before, "Choosing setup provider must not activate it")
			await page.getByRole("button", { name: "Add provider", exact: true }).click()
			await page.getByRole("status").filter({ hasText: /provider is added/i }).waitFor()
			assert.equal(await page.getByRole("button", { name: "Add provider", exact: true }).count(), 0)
			assert.deepEqual(await activeConfiguration(page), before, "Adding setup must preserve active providers and models")
			const requests = await page.evaluate(() => window.fixtureRequests)
			assert.equal(requests.length, 1)
			assert.equal(requests[0].setupOnly, true)
			assert.equal(requests[0].setupProvider, "groq")
			assert.deepEqual(requests[0].updateMask, [])
			await page.getByRole("button", { name: "Back to providers" }).click()
			await page.getByRole("button", { name: "Edit Groq setup" }).waitFor()
			await page.getByRole("button", { name: /Add provider/ }).click()
			assert.equal(await selector(page).inputValue(), "", "Reopening add must start blank")
		} finally { await closePage(page) }
	})

	it("shows save failure feedback without falsely reporting an added provider or changing active selections", async () => {
		const page = await openPage("?empty")
		try {
			const before = await activeConfiguration(page)
			assert.equal(await page.getByText("No providers configured yet.", { exact: false }).isVisible(), true)
			await page.getByRole("button", { name: /Add provider/ }).click()
			await chooseGroqWithKeyboard(page)
			await page.evaluate(() => { window.fixtureFailSave = true })
			await page.getByRole("button", { name: "Add provider", exact: true }).click()
			await page.getByText("Could not save API configuration: Fixture save rejected", { exact: true }).waitFor()
			assert.equal(await page.getByRole("status").count(), 0)
			assert.equal(await page.getByRole("button", { name: "Add provider", exact: true }).isEnabled(), true)
			assert.deepEqual(await activeConfiguration(page), before)
			assert.deepEqual(await page.evaluate(() => window.fixtureStore.getState().configuredApiProviders), [])
		} finally { await closePage(page) }
	})

	it("fits a 320px sidebar for provider lists, long profile details, picker results, and edit/add panels", async () => {
		const page = await openPage("?profiles", 320)
		try {
			await assertNoHorizontalOverflow(page)
			await page.getByRole("button", { name: /Add provider/ }).click()
			await assertNoHorizontalOverflow(page)
			await selector(page).focus()
			await page.getByRole("listbox").waitFor()
			await assertNoHorizontalOverflow(page)
			await chooseGroqWithKeyboard(page)
			await assertNoHorizontalOverflow(page)
			await page.getByRole("button", { name: "Back to providers" }).click()
			await page.getByRole("button", { name: "Edit Anthropic setup" }).click()
			await assertNoHorizontalOverflow(page)
		} finally { await closePage(page) }
	})
})
