import { Empty } from "@shared/proto/dirac/common"
import { expect } from "chai"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as sinon from "sinon"
import { Logger } from "@/shared/services/Logger"
import * as refreshBasetenModels from "../../models/refreshBasetenModels"
import * as refreshGithubCopilotModels from "../../models/refreshGithubCopilotModels"
import * as refreshGroqModels from "../../models/refreshGroqModels"
import * as refreshLiteLlmModels from "../../models/refreshLiteLlmModels"
import * as refreshOpenRouterModels from "../../models/refreshOpenRouterModels"
import * as subscribeToOpenRouterModels from "../../models/subscribeToOpenRouterModels"
import { initializeWebview } from "../initializeWebview"

// Flush all pending microtasks and macrotasks from fire-and-forget .then() chains
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 10))

interface MockController {
	readOpenRouterModels: sinon.SinonStub
	postStateToWebview: sinon.SinonStub
	getStateToPostToWebview: sinon.SinonStub
	stateManager: {
		getApiConfiguration: sinon.SinonStub
		getGlobalSettingsKey: sinon.SinonStub
		setGlobalState: sinon.SinonStub
		setGlobalStateBatch: sinon.SinonStub
		getSecretKey: sinon.SinonStub
	}
}

function createMockController(
	opts: {
		apiConfiguration?: Record<string, any>
		planActSeparate?: boolean
		currentMode?: string
		cachedModels?: Record<string, any> | undefined
		secrets?: Record<string, any>
	} = {},
): MockController {
	const { apiConfiguration = {}, planActSeparate = false, currentMode = "act", cachedModels = undefined, secrets = {} } = opts
	return {
		readOpenRouterModels: sinon.stub().resolves(cachedModels),
		postStateToWebview: sinon.stub().resolves(),
		getStateToPostToWebview: sinon.stub().resolves({ telemetrySetting: "enabled" }),
		stateManager: {
			getApiConfiguration: sinon.stub().returns(apiConfiguration),
			getGlobalSettingsKey: sinon.stub((key: string) => {
				if (key === "planActSeparateModelsSetting") return planActSeparate
				if (key === "mode") return currentMode
				if (key === "liteLlmBaseUrl") return secrets.liteLlmBaseUrl
				return undefined
			}),
			setGlobalState: sinon.stub(),
			setGlobalStateBatch: sinon.stub(),
			getSecretKey: sinon.stub((key: string) => secrets[key]),
		},
	} as any
}

describe("initializeWebview", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		sandbox.stub(refreshOpenRouterModels, "refreshOpenRouterModels").resolves({})
		sandbox.stub(refreshGroqModels, "refreshGroqModels").resolves({})
		sandbox.stub(refreshBasetenModels, "refreshBasetenModels").resolves({})
		sandbox.stub(refreshGithubCopilotModels, "refreshGithubCopilotModels").resolves({})
		sandbox.stub(refreshLiteLlmModels, "refreshLiteLlmModels").resolves({})
		sandbox.stub(subscribeToOpenRouterModels, "sendOpenRouterModelsEvent").resolves()
	})

	afterEach(() => {
		sandbox.restore()
	})

	it("returns an Empty response on successful initialization", async () => {
		const controller = createMockController()
		const result = await initializeWebview(controller as any, {} as any)
		expect(result).to.deep.equal(Empty.create({}))
	})

	it("posts cached OpenRouter models to the webview when available", async () => {
		const controller = createMockController({ cachedModels: { "model-a": { name: "A" } } })
		await initializeWebview(controller as any, {} as any)
		expect((subscribeToOpenRouterModels.sendOpenRouterModelsEvent as sinon.SinonStub).calledOnce).to.be.true
	})

	it("does not post cached models when none are cached", async () => {
		const controller = createMockController({ cachedModels: undefined })
		await initializeWebview(controller as any, {} as any)
		expect((subscribeToOpenRouterModels.sendOpenRouterModelsEvent as sinon.SinonStub).called).to.be.false
	})

	it("fetches state to configure telemetry based on the current setting", async () => {
		const controller = createMockController()
		await initializeWebview(controller as any, {} as any)
		await flushAsync()
		// initializeWebview calls getStateToPostToWebview to read telemetrySetting, then updates telemetry
		expect(controller.getStateToPostToWebview.calledOnce).to.be.true
	})

	it("refreshes LiteLLM models only when both baseUrl and apiKey are set", async () => {
		const controller = createMockController({ secrets: { liteLlmBaseUrl: "http://x", liteLlmApiKey: "key" } })
		await initializeWebview(controller as any, {} as any)
		expect((refreshLiteLlmModels.refreshLiteLlmModels as sinon.SinonStub).calledOnce).to.be.true
	})

	it("skips LiteLLM refresh when credentials are missing", async () => {
		const controller = createMockController()
		await initializeWebview(controller as any, {} as any)
		expect((refreshLiteLlmModels.refreshLiteLlmModels as sinon.SinonStub).called).to.be.false
	})

	it("updates OpenRouter model info in shared mode when models match", async () => {
		const models = { "or-1": { name: "OR1", supportsPromptCache: false } }
		;(refreshOpenRouterModels.refreshOpenRouterModels as sinon.SinonStub).resolves(models)
		const controller = createMockController({
			apiConfiguration: { planModeOpenRouterModelId: "or-1", actModeOpenRouterModelId: "or-1" },
		})
		await initializeWebview(controller as any, {} as any)
		await flushAsync()
		expect(controller.stateManager.setGlobalStateBatch.calledOnce).to.be.true
		expect(controller.postStateToWebview.called).to.be.true
	})

	it("updates OpenRouter model info in separate mode for the current mode only", async () => {
		const models = { "or-1": { name: "OR1", supportsPromptCache: false } }
		;(refreshOpenRouterModels.refreshOpenRouterModels as sinon.SinonStub).resolves(models)
		const controller = createMockController({
			apiConfiguration: { actModeOpenRouterModelId: "or-1" },
			planActSeparate: true,
			currentMode: "act",
		})
		await initializeWebview(controller as any, {} as any)
		await flushAsync()
		expect(controller.stateManager.setGlobalState.calledWith("actModeOpenRouterModelInfo", models["or-1"])).to.be.true
	})

	it("does not update OpenRouter model info when no model id matches", async () => {
		const models = { "or-1": { name: "OR1", supportsPromptCache: false } }
		;(refreshOpenRouterModels.refreshOpenRouterModels as sinon.SinonStub).resolves(models)
		const controller = createMockController({
			apiConfiguration: { planModeOpenRouterModelId: "or-2", actModeOpenRouterModelId: "or-2" },
		})
		await initializeWebview(controller as any, {} as any)
		await flushAsync()
		expect(controller.stateManager.setGlobalStateBatch.called).to.be.false
	})

	it("updates Groq model info in shared mode when models match", async () => {
		const models = { "groq-1": { name: "G1", supportsPromptCache: false } }
		;(refreshGroqModels.refreshGroqModels as sinon.SinonStub).resolves(models)
		const controller = createMockController({
			apiConfiguration: { planModeGroqModelId: "groq-1", actModeGroqModelId: "groq-1" },
		})
		await initializeWebview(controller as any, {} as any)
		await flushAsync()
		expect(controller.stateManager.setGlobalStateBatch.calledOnce).to.be.true
	})

	it("updates Baseten model info in shared mode when models match", async () => {
		const models = { "bas-1": { name: "B1", supportsPromptCache: false } }
		;(refreshBasetenModels.refreshBasetenModels as sinon.SinonStub).resolves(models)
		const controller = createMockController({
			apiConfiguration: { planModeBasetenModelId: "bas-1", actModeBasetenModelId: "bas-1" },
		})
		await initializeWebview(controller as any, {} as any)
		await flushAsync()
		expect(controller.stateManager.setGlobalStateBatch.calledOnce).to.be.true
		expect(controller.postStateToWebview.called).to.be.true
	})

	it("updates GithubCopilot model info in shared mode when models match", async () => {
		const models = { "gh-1": { name: "GH1", supportsPromptCache: false } }
		;(refreshGithubCopilotModels.refreshGithubCopilotModels as sinon.SinonStub).resolves(models)
		const controller = createMockController({
			apiConfiguration: { planModeGithubCopilotModelId: "gh-1", actModeGithubCopilotModelId: "gh-1" },
		})
		await initializeWebview(controller as any, {} as any)
		await flushAsync()
		expect(controller.stateManager.setGlobalStateBatch.calledOnce).to.be.true
	})

	it("returns Empty and logs error when an exception is thrown", async () => {
		const controller = createMockController()
		controller.readOpenRouterModels = sinon.stub().rejects(new Error("boom"))
		const errorStub = sandbox.stub(Logger, "error").returns()
		const result = await initializeWebview(controller as any, {} as any)
		expect(result).to.deep.equal(Empty.create({}))
		expect(errorStub.calledOnce).to.be.true
	})

	it("skips all model refresh callbacks when refresh returns empty models", async () => {
		const controller = createMockController()
		await initializeWebview(controller as any, {} as any)
		await flushAsync()
		expect(controller.stateManager.setGlobalState.called).to.be.false
		expect(controller.stateManager.setGlobalStateBatch.called).to.be.false
	})
})
