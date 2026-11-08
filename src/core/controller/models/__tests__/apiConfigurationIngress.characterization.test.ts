import * as apiModule from "@core/api"
import type { TaskWorkingConfigurationPatch } from "@core/task/runtime/TaskWorkingConfiguration"
import { ApiProvider } from "@shared/proto/dirac/models"
import {
	ModelsApiConfiguration,
	UpdateApiConfigurationPartialRequest,
	UpdateApiConfigurationRequest,
	UpdateApiConfigurationRequestNew,
} from "@shared/proto/dirac/models"
import { expect } from "chai"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { Logger } from "@/shared/services/Logger"
import { applyApiConfigurationTransaction } from "../apiConfigurationTransaction"
import { updateApiConfiguration } from "../updateApiConfiguration"
import { updateApiConfigurationPartial } from "../updateApiConfigurationPartial"
import { updateApiConfigurationProto } from "../updateApiConfigurationProto"

type Harness = ReturnType<typeof createHarness>

function createHarness() {
	const events: string[] = []
	let apiConfiguration: Record<string, unknown> = {
		planModeApiProvider: "anthropic",
		actModeApiProvider: "anthropic",
		planModeApiModelId: "plan-model",
		actModeApiModelId: "act-model",
		openAiCompatibleProfiles: [],
	}
	let workingConfiguration: any = {
		revision: 1,
		settings: { mode: "act", planModeApiProvider: "anthropic", actModeApiProvider: "anthropic" },
		apiConfiguration: { ...apiConfiguration },
		workspaceConfiguration: {},
		executionOptions: {
			terminalReuseEnabled: true,
			vscodeTerminalExecutionMode: "vscodeTerminal",
			multiRootEnabled: false,
		},
	}
	const replacementHandler = { id: "replacement-handler" }
	const task = {
		ulid: "task-ulid",
		getWorkingConfiguration: sinon.stub().callsFake(() => workingConfiguration),
		applyWorkingConfigurationUpdate: sinon
			.stub()
			.callsFake(async (patch: TaskWorkingConfigurationPatch, beforeCommit?: () => void | Promise<void>) => {
				// Mirror the production transaction boundary: candidate validation first,
				// persistence second, synchronous runtime publication last.
				apiModule.buildApiHandler({ ...workingConfiguration.apiConfiguration, ...patch.apiConfiguration }, "act")
				await beforeCommit?.()
				workingConfiguration = {
					...workingConfiguration,
					revision: workingConfiguration.revision + 1,
					settings: { ...workingConfiguration.settings, ...patch.settings },
					apiConfiguration: { ...workingConfiguration.apiConfiguration, ...patch.apiConfiguration },
				}
				events.push("install-handler")
				return workingConfiguration
			}),
	}
	const stateManager = {
		getGlobalSettingsKey: sinon.stub().callsFake((key: string) => {
			if (key === "mode") return "act"
			if (key === "planActSeparateModelsSetting") return true
			if (key === "modelProviderPresets") return []
			return undefined
		}),
		getApiConfiguration: sinon.stub().callsFake(() => ({ ...apiConfiguration })),
		getSystemDefaultSettingsKey: sinon.stub().callsFake((key: string) => apiConfiguration[key]),
		getSecretKey: sinon.stub().callsFake((key: string) => apiConfiguration[key]),
		setApiConfiguration: sinon.stub().callsFake((configuration: Record<string, unknown>) => {
			events.push("persist-api")
			apiConfiguration = { ...apiConfiguration, ...configuration }
		}),
		setGlobalStateBatch: sinon.stub().callsFake((updates: Record<string, unknown>) => {
			events.push("persist-settings")
			apiConfiguration = { ...apiConfiguration, ...updates }
		}),
		setSecretsBatch: sinon.stub().callsFake((updates: Record<string, unknown>) => {
			events.push("persist-secrets")
			apiConfiguration = { ...apiConfiguration, ...updates }
		}),
		setGlobalState: sinon.stub(),
	} as any
	const controller = {
		stateManager,
		task,
		postStateToWebview: sinon.stub().callsFake(async () => {
			events.push("publish-state")
		}),
	} as any
	return { controller, stateManager, task, replacementHandler, events, getWorkingConfiguration: () => workingConfiguration }
}

function expectHandlerCommitBeforePublication(harness: Harness): void {
	expect(harness.task.applyWorkingConfigurationUpdate.calledOnce).to.equal(true)
	expect(harness.events.indexOf("install-handler")).to.be.greaterThan(-1)
	expect(harness.events.indexOf("install-handler")).to.be.lessThan(harness.events.indexOf("publish-state"))
}

describe("API configuration active-task ingress characterization", () => {
	let buildApiHandler: sinon.SinonStub

	beforeEach(() => {
		sinon.stub(Logger, "error")
		buildApiHandler = sinon.stub(apiModule, "buildApiHandler")
	})

	afterEach(() => sinon.restore())

	it("the masked options/secrets endpoint persists both groups and commits one active revision", async () => {
		const harness = createHarness()
		buildApiHandler.returns(harness.replacementHandler as any)
		const request = UpdateApiConfigurationRequestNew.create({
			updates: {
				options: { actModeApiProvider: ApiProvider.ANTHROPIC, actModeApiModelId: "next-model" } as any,
				secrets: { apiKey: "next-secret" } as any,
			},
			updateMask: ["options.actModeApiModelId", "secrets.apiKey"],
		})

		await updateApiConfiguration(harness.controller, request)

		expect(
			harness.stateManager.setApiConfiguration.calledOnceWithExactly({
				actModeApiModelId: "next-model",
				apiKey: "next-secret",
			}),
		).to.equal(true)
		expectHandlerCommitBeforePublication(harness)
		expect(harness.events.indexOf("persist-secrets")).to.be.lessThan(harness.events.indexOf("install-handler"))
		expect(harness.events.indexOf("persist-settings")).to.be.lessThan(harness.events.indexOf("install-handler"))
	})

	it("the partial endpoint persists only addressed fields and commits one active revision", async () => {
		const harness = createHarness()
		buildApiHandler.returns(harness.replacementHandler as any)
		const request = UpdateApiConfigurationPartialRequest.create({
			apiConfiguration: ModelsApiConfiguration.create({ actModeApiModelId: "partial-model" }),
			updateMask: ["actModeApiModelId"],
		})

		await updateApiConfigurationPartial(harness.controller, request)

		expect(harness.stateManager.setApiConfiguration.calledOnce).to.equal(true)
		expect(harness.stateManager.setApiConfiguration.firstCall.args[0]).to.deep.equal({
			actModeApiModelId: "partial-model",
		})
		expectHandlerCommitBeforePublication(harness)
		expect(harness.events.indexOf("persist-api")).to.be.lessThan(harness.events.indexOf("install-handler"))
	})

	it("the legacy endpoint persists its converted configuration and commits one active revision", async () => {
		const harness = createHarness()
		buildApiHandler.returns(harness.replacementHandler as any)
		const request = UpdateApiConfigurationRequest.create({
			apiConfiguration: ModelsApiConfiguration.create({
				planModeApiProvider: ApiProvider.ANTHROPIC,
				actModeApiProvider: ApiProvider.ANTHROPIC,
				planModeApiModelId: "legacy-plan",
				actModeApiModelId: "legacy-act",
			}),
		})

		await updateApiConfigurationProto(harness.controller, request)

		expect(harness.stateManager.setApiConfiguration.calledOnce).to.equal(true)
		expectHandlerCommitBeforePublication(harness)
		expect(harness.events.indexOf("persist-api")).to.be.lessThan(harness.events.indexOf("install-handler"))
	})

	it("validates before persistence and leaves the Task revision unchanged on candidate failure", async () => {
		const harness = createHarness()
		buildApiHandler.throws(new Error("invalid candidate"))
		const original = harness.getWorkingConfiguration()

		let error: unknown
		try {
			await updateApiConfigurationPartial(
				harness.controller,
				UpdateApiConfigurationPartialRequest.create({
					apiConfiguration: ModelsApiConfiguration.create({ actModeApiModelId: "invalid" }),
					updateMask: ["actModeApiModelId"],
				}),
			)
		} catch (caught) {
			error = caught
		}

		expect((error as Error).message).to.equal("invalid candidate")
		expect(harness.stateManager.setApiConfiguration.called).to.equal(false)
		expect(harness.controller.postStateToWebview.called).to.equal(false)
		expect(harness.getWorkingConfiguration()).to.equal(original)
	})

	it("rejects an invalid active provider candidate before persistence", async () => {
		const harness = createHarness()
		const persist = sinon.stub()

		await applyApiConfigurationTransaction(
			harness.controller,
			{ ...harness.getWorkingConfiguration().apiConfiguration, actModeApiProvider: "dify" } as any,
			persist,
			"act",
			{ actModeApiProvider: "dify" },
		).should.be.rejectedWith("Dify requires both an API key and base URL")

		sinon.assert.notCalled(persist)
		sinon.assert.notCalled(harness.task.applyWorkingConfigurationUpdate)
	})

	it("leaves the Task revision unchanged when persistence fails", async () => {
		const harness = createHarness()
		buildApiHandler.returns(harness.replacementHandler as any)
		harness.stateManager.setApiConfiguration.throws(new Error("persistence failed"))
		const original = harness.getWorkingConfiguration()

		let error: unknown
		try {
			await updateApiConfigurationPartial(
				harness.controller,
				UpdateApiConfigurationPartialRequest.create({
					apiConfiguration: ModelsApiConfiguration.create({ actModeApiModelId: "next" }),
					updateMask: ["actModeApiModelId"],
				}),
			)
		} catch (caught) {
			error = caught
		}

		expect((error as Error).message).to.equal("API and mode persistence rollback failed")
		expect(harness.getWorkingConfiguration()).to.equal(original)
		expect(harness.events).not.to.include("install-handler")
		expect(harness.controller.postStateToWebview.called).to.equal(false)
	})

	it("rolls back an API write that throws after mutating addressed fields", async () => {
		const harness = createHarness()
		buildApiHandler.returns(harness.replacementHandler as any)
		const original = harness.getWorkingConfiguration()
		const before = harness.stateManager.getApiConfiguration()
		let persisted = before
			; (harness.stateManager.getApiConfiguration as sinon.SinonStub).callsFake(() => ({ ...persisted }))
		harness.stateManager.getSystemDefaultSettingsKey.callsFake((key: string) => persisted[key])
		harness.stateManager.getSecretKey.callsFake((key: string) => persisted[key])
		harness.stateManager.setApiConfiguration.onFirstCall().callsFake((configuration: Record<string, unknown>) => {
			persisted = { ...persisted, ...configuration }
			throw new Error("write failed after mutation")
		})
		harness.stateManager.setApiConfiguration.onSecondCall().callsFake((configuration: Record<string, unknown>) => {
			persisted = { ...persisted, ...configuration }
		})

		await updateApiConfigurationPartial(
			harness.controller,
			UpdateApiConfigurationPartialRequest.create({
				apiConfiguration: ModelsApiConfiguration.create({ actModeApiModelId: "transient-model" }),
				updateMask: ["actModeApiModelId"],
			}),
		).should.be.rejectedWith("write failed after mutation")

		expect(harness.stateManager.setApiConfiguration.secondCall.args[0]).to.include({ actModeApiModelId: "act-model" })
		expect(persisted.actModeApiModelId).to.equal("act-model")
		expect(harness.getWorkingConfiguration()).to.equal(original)
		expect(harness.controller.postStateToWebview.called).to.equal(false)
	})
})
