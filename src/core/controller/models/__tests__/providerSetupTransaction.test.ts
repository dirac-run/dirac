import { expect } from "chai"
import { describe, it } from "mocha"
import sinon from "sinon"
import type { ApiConfiguration } from "@shared/api"
import { applyProviderSetupTransaction } from "../apiConfigurationTransaction"
import { updateApiConfigurationPartial } from "../updateApiConfigurationPartial"
import { UpdateApiConfigurationPartialRequest } from "@shared/proto/dirac/models"

function harness(active = false) {
	let defaults: Record<string, unknown> = { addedApiProviders: [], openAiBaseUrl: "old-url" }
	let working: any = {
		settings: { mode: "act" },
		apiConfiguration: { actModeApiProvider: "anthropic", actModeApiModelId: "task-model" },
	}
	const stateManager = {
		getSystemDefaultSettingsKey: sinon.stub().callsFake((key: string) => defaults[key]),
		getSecretKey: sinon.stub().callsFake((key: string) => defaults[key]),
		getApiConfiguration: sinon.stub().callsFake(() => ({ ...defaults, ...working.apiConfiguration })),
		setApiConfiguration: sinon.stub().callsFake((patch: Record<string, unknown>) => { defaults = { ...defaults, ...patch } }),
		setGlobalState: sinon.stub().callsFake((key: string, value: unknown) => { defaults[key] = value }),
	}
	const task = {
		getWorkingConfiguration: () => working,
		applyWorkingConfigurationUpdate: sinon.stub().callsFake(async (patch: any, persist: () => Promise<void>) => {
			await persist()
			working = { ...working, apiConfiguration: { ...working.apiConfiguration, ...patch.apiConfiguration } }
			return working
		}),
	}
	const controller = { stateManager, ...(active ? { task } : {}), postStateToWebview: sinon.stub().resolves() } as any
	return { controller, task, stateManager, defaults: () => defaults, working: () => working }
}

describe("provider setup transaction", () => {
	it("accepts explicit keyless membership with an empty mask without reinstalling the active runtime", async () => {
		const h = harness(true)
		await updateApiConfigurationPartial(h.controller, UpdateApiConfigurationPartialRequest.create({
			setupOnly: true, setupProvider: "lmstudio", apiConfiguration: {}, updateMask: [],
		}))
		expect(h.defaults().addedApiProviders).to.deep.equal(["lmstudio"])
		sinon.assert.notCalled(h.task.applyWorkingConfigurationUpdate)
		sinon.assert.notCalled(h.stateManager.setApiConfiguration)
	})

	it("saves keyless setup before an application provider/model exists", async () => {
		const h = harness()
		await applyProviderSetupTransaction(h.controller, { openAiBaseUrl: "http://localhost:1234/v1" }, undefined, "openai")
		expect(h.defaults()).to.deep.equal({ addedApiProviders: ["openai"], openAiBaseUrl: "http://localhost:1234/v1" })
		sinon.assert.notCalled(h.task.applyWorkingConfigurationUpdate)
	})

	it("publishes addressed setup to the active runtime without changing its model or persisting task overrides", async () => {
		const h = harness(true)
		await updateApiConfigurationPartial(h.controller, UpdateApiConfigurationPartialRequest.create({
			setupOnly: true,
			apiConfiguration: { openRouterApiKey: "new-key" },
			updateMask: ["openRouterApiKey"],
		}))
		expect(h.working().apiConfiguration).to.deep.equal({
			actModeApiProvider: "anthropic", actModeApiModelId: "task-model", openRouterApiKey: "new-key",
		})
		sinon.assert.calledOnceWithExactly(h.stateManager.setApiConfiguration, { openRouterApiKey: "new-key" })
		expect(h.defaults()).not.to.have.property("actModeApiModelId")
	})

	for (const field of ["actModeApiProvider", "planModeApiModelId", "geminiActModeThinkingLevel", "lmStudioModelId", "utilityModelSelection"]) {
		it(`rejects selection/non-setup field ${field} before persistence`, async () => {
			const h = harness()
			let error: unknown
			try { await applyProviderSetupTransaction(h.controller, { [field]: "not-setup" } as ApiConfiguration) } catch (caught) { error = caught }
			expect(String(error)).to.contain("Provider setup cannot update")
			sinon.assert.notCalled(h.stateManager.setApiConfiguration)
		})
	}

	it("rolls back addressed defaults and membership after a membership write fails", async () => {
		const h = harness(true)
		const before = h.working()
		h.stateManager.setGlobalState.onFirstCall().callsFake(() => { throw new Error("membership failed") })
		let error: unknown
		try { await applyProviderSetupTransaction(h.controller, { openAiBaseUrl: "new-url" }, undefined, "openai") } catch (caught) { error = caught }
		expect(String(error)).to.contain("membership failed")
		expect(h.defaults()).to.deep.equal({ addedApiProviders: [], openAiBaseUrl: "old-url" })
		expect(h.working()).to.equal(before)
		sinon.assert.calledWithExactly(h.stateManager.setGlobalState, "addedApiProviders", [])
	})

	it("does not persist setup when the active runtime rejects the candidate", async () => {
		const h = harness(true)
		h.task.applyWorkingConfigurationUpdate.rejects(new Error("invalid runtime setup"))
		let error: unknown
		try { await applyProviderSetupTransaction(h.controller, { openAiBaseUrl: "new-url" }) } catch (caught) { error = caught }
		expect(String(error)).to.contain("invalid runtime setup")
		sinon.assert.notCalled(h.stateManager.setApiConfiguration)
	})
})
