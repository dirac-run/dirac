import assert from "node:assert/strict"
import fs from "node:fs/promises"
import * as disk from "@core/storage/disk"
import { StateManager } from "@core/storage/StateManager"
import { getModelsCache, type ModelCache, setModelsCache } from "@core/storage/StateManagerModelCache"
import { unbiasedModels } from "@shared/api"
import * as fsUtils from "@utils/fs"
import axios, { AxiosError } from "axios"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import type { Controller } from "@/core/controller"
import { refreshUnbiasedModelsRpc } from "@/core/controller/models/refreshUnbiasedModelsRpc"
import { Logger } from "@/shared/services/Logger"
import { fetchUnbiasedModels, getCachedUnbiasedModels } from "../unbiased-models"

const fixture = {
	id: "pareto-26.10-preview",
	name: "Pareto 26.10 Preview",
	description: "Preview model",
	context_length: 1_048_576,
	top_provider: { max_completion_tokens: 131_072 },
	architecture: { input_modalities: ["text", "image"] },
	pricing: { prompt: "0.0000008", completion: "0.0000032", input_cache_read: "0.00000003" },
	supported_parameters: ["tools", "tool_choice", "max_tokens"],
}

describe("Unbiased model discovery", () => {
	let get: sinon.SinonStub
	let write: sinon.SinonStub
	let warning: sinon.SinonStub
	let stateManager: StateManager
	let clock: sinon.SinonFakeTimers

	beforeEach(() => {
		clock = sinon.useFakeTimers({ now: 1_000, toFake: ["Date"] })
		const cache: ModelCache = {}
		stateManager = {
			getModelsCache: (provider: string) => getModelsCache(cache, provider),
			setModelsCache: (provider, models) => setModelsCache(cache, provider, models),
			getApiConfiguration: () => ({ unbiasedApiKey: "saved-private-key" }),
		} as StateManager
		sinon.stub(StateManager, "isInitialized").returns(true)
		sinon.stub(StateManager, "get").returns(stateManager)
		sinon.stub(disk, "ensureCacheDirectoryExists").resolves("/tmp/unbiased-discovery")
		sinon.stub(fsUtils, "fileExistsAtPath").resolves(false)
		write = sinon.stub(fs, "writeFile").resolves()
		warning = sinon.stub(Logger, "warn")
		get = sinon.stub(axios, "get").resolves({ data: { data: [fixture] } })
	})

	afterEach(() => sinon.restore())

	it("authenticates, converts token limits/capabilities/prices, and writes normalized metadata", async () => {
		const models = await fetchUnbiasedModels("private-key")
		assert.equal(get.firstCall.args[0], "https://api.unbiased.ai/v1/models")
		assert.equal(get.firstCall.args[1].headers.Authorization, "Bearer private-key")
		assert.equal(get.firstCall.args[1].timeout, 10_000)
		assert.deepEqual(models[fixture.id], {
			name: fixture.name,
			description: fixture.description,
			contextWindow: 1_048_576,
			maxTokens: 131_072,
			supportsImages: true,
			supportsTools: true,
			supportsStrictTools: false,
			supportsReasoning: false,
			supportsReasoningEffort: false,
			thinkingConfig: undefined,
			supportsPromptCache: true,
			inputPrice: 0.8,
			outputPrice: 3.2,
			cacheReadsPrice: 0.03,
			cacheWritesPrice: undefined,
		})
		assert.equal(write.firstCall.args[0], "/tmp/unbiased-discovery/unbiased_models.json")
		assert.deepEqual(JSON.parse(write.firstCall.args[1]), JSON.parse(JSON.stringify(models)))
		assert.deepEqual(getCachedUnbiasedModels("private-key"), models)
	})

	it("keeps free prices at zero and absent prices unknown", async () => {
		get.resolves({ data: { data: [{ ...fixture, pricing: { prompt: "0", completion: "0" } }] } })
		const info = (await fetchUnbiasedModels("private-key"))[fixture.id]
		assert.equal(info.inputPrice, 0)
		assert.equal(info.outputPrice, 0)
		assert.equal(info.cacheReadsPrice, undefined)
		assert.equal(info.supportsPromptCache, false)
	})

	it("skips unauthenticated discovery without preventing a later authenticated fetch", async () => {
		assert.deepEqual(await fetchUnbiasedModels(undefined), unbiasedModels)
		assert.equal(getCachedUnbiasedModels(undefined), undefined)
		sinon.assert.notCalled(get)
		assert.ok((await fetchUnbiasedModels("new-key"))[fixture.id])
		sinon.assert.calledOnce(get)
	})

	it("deduplicates concurrent calls and honors the existing one-hour TTL", async () => {
		const first = fetchUnbiasedModels("private-key")
		assert.equal(fetchUnbiasedModels("private-key"), first)
		await first
		await fetchUnbiasedModels("private-key")
		sinon.assert.calledOnce(get)
		clock.tick(60 * 60 * 1_000 + 1)
		assert.equal(getCachedUnbiasedModels("private-key"), undefined)
		await fetchUnbiasedModels("private-key")
		sinon.assert.calledTwice(get)
	})

	it("fetches again for a replacement credential and keeps catalogs isolated", async () => {
		await fetchUnbiasedModels("first-key")
		get.resolves({ data: { data: [{ ...fixture, id: "pareto" }] } })
		await fetchUnbiasedModels("second-key")
		sinon.assert.calledTwice(get)
		assert.equal(getCachedUnbiasedModels("first-key")?.pareto, undefined)
		assert.ok(getCachedUnbiasedModels("second-key")?.pareto)
	})

	it("uses disk fallback on authentication failure without logging credentials", async () => {
		const failure = new AxiosError("authentication failed", "ERR_BAD_REQUEST", {
			headers: { Authorization: "Bearer private-key" },
		} as any)
		failure.response = { status: 401 } as any
		get.rejects(failure)
		;(fsUtils.fileExistsAtPath as sinon.SinonStub).resolves(true)
		sinon.stub(fs, "readFile").resolves(JSON.stringify(unbiasedModels))
		assert.deepEqual(await fetchUnbiasedModels("private-key"), unbiasedModels)
		assert.deepEqual(getCachedUnbiasedModels("private-key"), unbiasedModels)
		assert.match(warning.firstCall.args[0], /HTTP 401/)
		assert.ok(!JSON.stringify(warning.args).includes("private-key"))
		sinon.assert.notCalled(write)
	})

	it("falls back to static Pareto metadata on a failed or malformed response", async () => {
		get.resolves({ data: { data: [{ ...fixture, pricing: { prompt: "invalid" } }] } })
		assert.deepEqual(await fetchUnbiasedModels("private-key"), unbiasedModels)
		sinon.assert.notCalled(write)
		sinon.assert.calledOnce(warning)
	})

	it("uses the effective configured key and preserves names/tools through the RPC", async () => {
		const response = await refreshUnbiasedModelsRpc({ stateManager } as Controller, {})
		assert.equal(get.firstCall.args[1].headers.Authorization, "Bearer saved-private-key")
		assert.equal(response.models[fixture.id].name, fixture.name)
		assert.equal(response.models[fixture.id].supportsTools, true)
		assert.equal(response.models[fixture.id].contextWindow, 1_048_576)
		assert.equal(response.models[fixture.id].inputPrice, 0.8)
	})
})
