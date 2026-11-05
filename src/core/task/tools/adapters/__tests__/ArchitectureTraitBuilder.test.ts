import { strict as assert } from "node:assert"
import { setHostCapabilities } from "@hosts/host-capabilities"
import type { TaskExecutionProfile } from "@core/task/TaskExecutionProfile"
import { expect } from "chai"
import proxyquire from "proxyquire"
import sinon from "sinon"
import { buildArchitectureTrait } from "../traits/ArchitectureTraitBuilder"

function config(executionProfile: TaskExecutionProfile) {
	return {
		taskId: "owner",
		foreground: executionProfile !== "tasklet",
		canWaitForInput: true,
		resolveTaskDirectory: () => "/tasks/owner",
	}
}

describe("architecture environment capability", () => {
	beforeEach(() =>
		setHostCapabilities({
			architectureViewer: {
				prepare: async () => { },
				createPanel: async () => {
					throw new Error("not used")
				},
			},
		}),
	)
	afterEach(() => setHostCapabilities(undefined))

	it("is absent for private workers but available to foreground Task and Goal profiles", () => {
		expect(buildArchitectureTrait(config("tasklet"))).to.equal(undefined)
		for (const profile of ["standalone", "goal_coordinator", "goal_followup"] as const) {
			expect(buildArchitectureTrait(config(profile))).to.have.keys(
				"upsertDiagram",
				"listDiagrams",
				"fetchDiagram",
				"openDisplay",
			)
		}
	})

	it("construction does not load storage; methods use only the owning task identity", async () => {
		const construct = sinon.spy()
		const upsertDiagram = sinon.stub().resolves({ name: "tools", version: 1 })
		const listDiagrams = sinon.stub().resolves([])
		const fetchDiagram = sinon.stub().resolves({ name: "tools", version: 1 })
		class Store {
			constructor(taskId: string, directory: string) {
				construct(taskId, directory)
			}
			upsertDiagram = upsertDiagram
			listDiagrams = listDiagrams
			fetchDiagram = fetchDiagram
		}
		const module = proxyquire("../traits/ArchitectureTraitBuilder", {
			"@core/architecture/ArchitectureStorage": { ArchitectureStorage: Store, "@noCallThru": true },
		}) as { buildArchitectureTrait: typeof buildArchitectureTrait }
		const trait = module.buildArchitectureTrait(config("standalone"))!
		expect(construct.called).to.equal(false)
		await trait.upsertDiagram("tools", "{}")
		await trait.listDiagrams()
		await trait.fetchDiagram("tools", 1)
		expect(construct.args).to.deep.equal([
			["owner", "/tasks/owner"],
			["owner", "/tasks/owner"],
			["owner", "/tasks/owner"],
		])
		expect(upsertDiagram.firstCall.args).to.deep.equal(["tools", "{}"])
		expect(fetchDiagram.firstCall.args).to.deep.equal(["tools", 1])
	})

	it("delegates owning selections to the host in either input mode without loading storage", async () => {
		const openSelection = sinon.stub().resolves()
		const prepare = sinon.stub().rejects(new Error("the host owns preparation"))
		const createPanel = sinon.stub().rejects(new Error("the host owns panel creation"))
		const resolveTaskDirectory = sinon.stub().throws(new Error("display must not access storage directly"))
		setHostCapabilities({ architectureViewer: { prepare, createPanel, openSelection } })
		for (const canWaitForInput of [true, false]) {
			const trait = buildArchitectureTrait({
				...config("goal_coordinator"),
				canWaitForInput,
				resolveTaskDirectory,
			})!
			for (const selection of [
				{ name: "tools", mode: "latest" as const },
				{ name: "tools", mode: "exact" as const, version: 1 },
				{ name: "tools", mode: "comparison" as const, startVersion: 1, endVersion: 2 },
			]) {
				openSelection.resetHistory()
				assert.deepEqual(await trait.openDisplay!(selection), {
					available: true,
					selection: { taskId: "owner", ...selection },
					waitForInput: canWaitForInput,
				})
				sinon.assert.calledOnceWithExactly(openSelection, { taskId: "owner", ...selection })
			}
			const failure = new Error("host could not open selection")
			openSelection.rejects(failure)
			await assert.rejects(trait.openDisplay!({ name: "tools", mode: "latest" }), (error) => error === failure)
			openSelection.resolves()
		}
		sinon.assert.notCalled(resolveTaskDirectory)
		sinon.assert.notCalled(prepare)
		sinon.assert.notCalled(createPanel)
	})

	it("reports unavailable display when the host has no open-selection implementation", async () => {
		const trait = buildArchitectureTrait(config("standalone"))!
		const result = await trait.openDisplay!({ name: "tools", mode: "latest" })
		assert.equal(result.available, false)
	})

	it("the entire capability is absent headlessly regardless of input policy, without loading storage", () => {
		const resolveTaskDirectory = () => {
			throw new Error("no storage access expected")
		}
		setHostCapabilities({})
		for (const canWaitForInput of [true, false]) {
			assert.equal(buildArchitectureTrait({ ...config("standalone"), canWaitForInput, resolveTaskDirectory }), undefined)
		}
	})

	it("a retained trait refuses storage access after its viewer capability is removed", async () => {
		const resolveTaskDirectory = sinon.stub().throws(new Error("no storage access expected"))
		const trait = buildArchitectureTrait({ ...config("standalone"), resolveTaskDirectory })!
		setHostCapabilities({})
		await assert.rejects(trait.listDiagrams(), /viewer is unavailable/)
		await assert.rejects(trait.fetchDiagram("tools", 1), /viewer is unavailable/)
		await assert.rejects(trait.upsertDiagram("tools", "{}"), /viewer is unavailable/)
		sinon.assert.notCalled(resolveTaskDirectory)
	})
})
