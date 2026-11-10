import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CardStatus } from "@shared/ExtensionMessage"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { setHostCapabilities } from "@hosts/host-capabilities"
import { ArchitectureBoardController } from "./ArchitectureBoardController"
import { buildArchitectureTrait } from "@core/task/tools/adapters/traits/ArchitectureTraitBuilder"
import type { ICardHandle } from "@core/task/tools/interfaces/ICardHandle"
import type { ArchitectureDiagramEnvironment } from "@core/task/tools/modules/architecture_diagram/ArchitectureDiagramEnvironment"
import { create } from "@core/task/tools/modules/architecture_diagram/tool"

const diagram = {
	title: "Tool boundary",
	summary: "Tools use environment capabilities, not host implementations.",
	nodes: [{ id: "tool", kind: "component", label: "Tool" }],
	edges: [],
}

describe("architecture_diagram through the real architecture trait and storage", () => {
	let taskDirectory: string
	let env: ArchitectureDiagramEnvironment
	let boards: ArchitectureBoardController
	let createPanel: sinon.SinonStub
	let openSelection: sinon.SinonSpy
	const panels: Array<{ reveal: sinon.SinonStub; refresh: sinon.SinonStub; dispose: sinon.SinonStub }> = []
	const cards: Array<{ update: sinon.SinonStub; finalize: sinon.SinonStub }> = []

	beforeEach(async () => {
		taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-architecture-tool-"))
		cards.length = 0
		panels.length = 0
		boards = new ArchitectureBoardController(
			(taskId) => assert.equal(taskId, path.basename(taskDirectory)),
			() => taskDirectory,
		)
		createPanel = sinon.stub().callsFake(async () => {
			const panel = { reveal: sinon.stub(), refresh: sinon.stub().resolves(), dispose: sinon.stub() }
			panels.push(panel)
			return panel
		})
		openSelection = sinon.spy((selection: unknown) => boards.open(selection))
		setHostCapabilities({ architectureViewer: { prepare: async () => { }, createPanel, openSelection } })
		env = {
			orchestration: { reportFailure: sinon.spy() },
			architecture: buildArchitectureTrait({
				taskId: path.basename(taskDirectory),
				foreground: true,
				canWaitForInput: false,
				resolveTaskDirectory: () => taskDirectory,
			}),
			ui: {
				createCard: async () => {
					const card = { update: sinon.stub().resolves(), finalize: sinon.stub().resolves() }
					cards.push(card)
					return card as unknown as ICardHandle
				},
			},
		}
	})

	afterEach(async () => {
		boards.dispose()
		setHostCapabilities(undefined)
		await fs.rm(taskDirectory, { recursive: true, force: true })
		for (const card of cards) sinon.assert.calledOnce(card.finalize)
	})

	async function call(input: unknown) {
		return JSON.parse(await create().processCall(input, env))
	}

	it("publishes and opens revisions, then recovers latest and exact semantic content", async () => {
		assert.deepEqual(await fs.readdir(taskDirectory), [])
		assert.deepEqual(await call({ operation: "list_diagrams" }), [])
		assert.deepEqual(await fs.readdir(taskDirectory), [])
		const saved = await call({ operation: "upsert_diagram", name: "tools", diagram: JSON.stringify(diagram) })
		assert.equal(saved.name, "tools")
		assert.equal(saved.version, 1)
		assert.equal(saved.saved, true)
		assert.equal(saved.outcome, "displayed")
		const revised = { ...diagram, summary: "Retain the environment boundary." }
		const versions = [
			await call({ operation: "upsert_diagram", name: "tools", diagram: JSON.stringify(revised) }),
			await call({ operation: "upsert_diagram", name: "tools", diagram: JSON.stringify(revised) }),
		]
		assert.deepEqual(
			versions.map((value) => value.version),
			[2, 3],
		)
		await call({ operation: "upsert_diagram", name: "api", diagram: JSON.stringify(diagram) })
		assert.deepEqual(await call({ operation: "list_diagrams" }), [
			{ name: "api", versions: [1] },
			{ name: "tools", versions: [1, 2, 3] },
		])
		assert.deepEqual(await call({ operation: "fetch_diagram", name: "tools" }), {
			name: "tools",
			version: 3,
			diagram: revised,
		})
		assert.deepEqual(await call({ operation: "fetch_diagram", name: "tools", version: 1 }), {
			name: "tools",
			version: 1,
			diagram,
		})
		for (const card of cards) sinon.assert.calledWithExactly(card.finalize, CardStatus.SUCCESS)
	})

	it("automatically opens the committed version and allows reopening without another publication", async () => {
		const saved = await call({ operation: "upsert_diagram", name: "tools", diagram: JSON.stringify(diagram) })
		assert.equal(saved.outcome, "displayed")
		sinon.assert.calledOnce(createPanel)
		sinon.assert.calledOnce(panels[0].reveal)
		sinon.assert.calledOnceWithExactly(openSelection, {
			taskId: path.basename(taskDirectory),
			name: "tools",
			mode: "exact",
			version: 1,
		})
		const result = await call({ operation: "display_diagram", name: "tools", version: 1 })
		assert.equal(result.outcome, "displayed")
		assert.equal(result.response, undefined)
		sinon.assert.calledOnce(createPanel)
		sinon.assert.calledTwice(panels[0].reveal)
		for (const card of cards) {
			sinon.assert.calledWithMatch(card.update, {
				architectureReference: { taskId: path.basename(taskDirectory), name: "tools", mode: "exact", version: 1 },
				requireFeedback: false,
			})
			sinon.assert.calledOnceWithExactly(card.finalize, CardStatus.SUCCESS)
		}
		assert.deepEqual(await call({ operation: "list_diagrams" }), [{ name: "tools", versions: [1] }])
	})

	it("opens different names in independent panels, including concurrent saves", async () => {
		const results = await Promise.all(
			["tools", "api"].map((name) => call({ operation: "upsert_diagram", name, diagram: JSON.stringify(diagram) })),
		)
		assert.deepEqual(
			results.map(({ name, version, outcome }) => ({ name, version, outcome })),
			[
				{ name: "tools", version: 1, outcome: "displayed" },
				{ name: "api", version: 1, outcome: "displayed" },
			],
		)
		sinon.assert.calledTwice(createPanel)
		assert.deepEqual(
			createPanel
				.getCalls()
				.map((entry) => entry.args[0].name)
				.sort(),
			["api", "tools"],
		)
		for (const panel of panels) sinon.assert.calledOnce(panel.reveal)
	})

	it("recovers a saved diagram after opening fails without creating a duplicate version", async () => {
		createPanel.onFirstCall().rejects(new Error("panel failed"))
		const saved = await call({ operation: "upsert_diagram", name: "tools", diagram: JSON.stringify(diagram) })
		assert.equal(saved.outcome, "error")
		assert.equal(saved.saved, true)
		assert.equal(saved.version, 1)
		assert.match(saved.error, /Retry display_diagram/)
		const reopened = await call({ operation: "display_diagram", name: saved.name, version: saved.version })
		assert.equal(reopened.outcome, "displayed")
		assert.deepEqual(await call({ operation: "list_diagrams" }), [{ name: "tools", versions: [1] }])
	})

	it("reports invalid/missing/corrupt content locally, preserves semantic history, and leaves later operations usable", async () => {
		const invalid = await call({ operation: "upsert_diagram", name: "tools", diagram: "{}" })
		assert.equal(invalid.outcome, "error")
		assert.match(invalid.error, /title/)
		assert.equal(
			(await call({ operation: "upsert_diagram", name: "../outside", diagram: JSON.stringify(diagram) })).outcome,
			"error",
		)
		assert.deepEqual(await call({ operation: "list_diagrams" }), [])
		sinon.assert.notCalled(openSelection)
		sinon.assert.notCalled(createPanel)
		await call({ operation: "upsert_diagram", name: "tools", diagram: JSON.stringify(diagram) })
		const missing = await call({ operation: "fetch_diagram", name: "tools", version: 2 })
		assert.equal(missing.outcome, "error")
		assert.equal(missing.version, undefined)
		await fs.writeFile(path.join(taskDirectory, "architecture/tools/v1.review.json"), "{broken")
		assert.deepEqual((await call({ operation: "fetch_diagram", name: "tools" })).diagram, diagram)
		assert.equal((await call({ operation: "upsert_diagram", name: "tools", diagram: JSON.stringify(diagram) })).version, 2)
		await fs.writeFile(path.join(taskDirectory, "architecture/tools/v2.json"), "{}")
		const corrupt = await call({ operation: "fetch_diagram", name: "tools" })
		assert.equal(corrupt.outcome, "error")
		assert.equal(corrupt.error.includes(taskDirectory), false)
		assert.deepEqual((await call({ operation: "fetch_diagram", name: "tools", version: 1 })).diagram, diagram)
		assert.deepEqual(await call({ operation: "list_diagrams" }), [{ name: "tools", versions: [1, 2] }])
		assert.equal((await call({ operation: "display_diagram", name: "tools" })).outcome, "error")
	})
})
