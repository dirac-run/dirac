import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { CardStatus } from "@shared/ExtensionMessage"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import type { IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { DEFAULT_BOUNDED_TOOL_EXECUTION_MS } from "../../../runtime/ToolExecutionDeadline"
import { create, exposure, spec } from "../tool"

const graph = { title: "Architecture", summary: "A semantic graph", nodes: [], edges: [] }

function environment() {
	const card = {
		update: sinon.stub().resolves(),
		finalize: sinon.stub().resolves(),
		waitForInteraction: sinon.stub().rejects(new Error("must not wait")),
	}
	const architecture = {
		openDisplay: sinon
			.stub()
			.callsFake(async (selection) => ({
				available: true,
				selection: { ...selection, taskId: "owner" },
				waitForInput: false,
			})),
		upsertDiagram: sinon.stub().resolves({ name: "example", version: 3 }),
		listDiagrams: sinon.stub().resolves([{ name: "example", versions: [1, 2, 3] }]),
		fetchDiagram: sinon.stub().resolves({ name: "example", version: 3, diagram: graph }),
	}
	const ui = { createCard: sinon.stub().resolves(card) }
	return { env: { ui, architecture, orchestration: { reportFailure: sinon.spy() } } as unknown as IToolEnvironment, card, architecture, ui }
}

async function invoke(input: unknown, fixture = environment()) {
	const result = JSON.parse(await create().processCall(input, fixture.env))
	assert.equal(fixture.ui.createCard.callCount, 1)
	assert.equal(fixture.card.finalize.callCount, 1)
	assert.equal(fixture.card.waitForInteraction.callCount, 0)
	assert.equal(fixture.ui.createCard.firstCall.args[0].actions, undefined)
	for (const call of fixture.card.update.getCalls()) assert.equal(call.args[0].actions, undefined)
	return { ...fixture, result }
}

function isolatedNode(script: string) {
	const result = spawnSync(
		process.execPath,
		["--no-experimental-strip-types", "-r", "ts-node/register/transpile-only", "-r", "tsconfig-paths/register", "-e", script],
		{
			cwd: process.cwd(),
			env: { ...process.env, TS_NODE_PROJECT: "tsconfig.unit-test.json" },
			encoding: "utf8",
			timeout: 20_000,
		},
	)
	assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error))
}

describe("architecture_diagram isolated tool implementation", () => {
	afterEach(() => sinon.restore())

	it("has exactly five operations and only its authorized skill can expose it", () => {
		assert.deepEqual(exposure, { kind: "skill_only", authorizedSkillIds: ["architecture-board"] })
		assert.equal(spec.parameters?.filter((parameter) => parameter.required).length, 1)
		assert.deepEqual(spec.parameters?.[0].enum, [
			"upsert_diagram",
			"display_diagram",
			"display_comparison",
			"list_diagrams",
			"fetch_diagram",
		])
		assert.deepEqual(create().supportedSurfaces(), ["all"])
	})

	it("headless skill discovery does not import architecture instructions or implementation", () => {
		isolatedNode(`
			const assert = require('node:assert/strict');
			const Module = require('node:module');
			const original = Module._load;
			Module._load = function(request, parent, main) {
				assert.ok(!/architecture-board|ArchitectureStorage|ArchitectureDiagramTool|ArchitectureBoardController/.test(request), request);
				return original.call(this, request, parent, main);
			};
			const skills = require('./src/core/context/instructions/user-instructions/skills');
			const host = require('./src/hosts/host-capabilities');
			host.setHostCapabilities({});
			skills.getOrDiscoverSkills('/unused', { discoveredSkillsCache: skills.BUILTIN_SKILLS }).then(available => {
				assert.equal(available.some(skill => skill.name === 'architecture-board'), false);
			}).catch(error => { console.error(error); process.exitCode = 1; });
		`)
	})

	it("imports no implementation, board storage, or viewer and performs no IO during discovery or construction", () => {
		isolatedNode(`
			const assert = require('node:assert/strict');
			const Module = require('node:module');
			const original = Module._load;
			Module._load = function(request, parent, main) {
				assert.ok(!/ArchitectureDiagramTool|ArchitectureDiagramArguments|core\\/architecture|reactflow|@xyflow|elkjs|architecture-board/.test(request), request);
				return original.call(this, request, parent, main);
			};
			for (const fs of [require('node:fs/promises'), require('node:fs').promises]) {
				for (const method of ['readFile', 'writeFile', 'readdir', 'mkdir', 'stat', 'access']) fs[method] = () => { throw new Error('Unexpected IO: ' + method); };
			}
			const tool = require('./src/core/task/tools/modules/architecture_diagram/tool');
			assert.equal(tool.create().spec(), tool.spec);
			assert.deepEqual(tool.create().supportedSurfaces(), ['all']);
		`)
	})

	it("reports a missing lazy implementation and finalizes its card", () => {
		isolatedNode(`
			const assert = require('node:assert/strict');
			const Module = require('node:module');
			const original = Module._load;
			Module._load = function(request, parent, main) {
				if (request.includes('ArchitectureDiagramTool')) throw new Error('Injected implementation failure');
				return original.call(this, request, parent, main);
			};
			const tool = require('./src/core/task/tools/modules/architecture_diagram/tool').create();
			const statuses = [];
			const card = { update: async () => {}, finalize: async status => statuses.push(status) };
			tool.processCall({ operation: 'list_diagrams' }, { ui: { createCard: async () => card }, orchestration: { reportFailure() {} } }).then(text => {
				const result = JSON.parse(text);
				assert.equal(result.operation, 'list_diagrams');
				assert.equal(result.outcome, 'unavailable');
				assert.match(result.error, /implementation unavailable/);
				assert.equal(result.error.includes('Injected implementation failure'), false);
				assert.deepEqual(statuses, ['error']);
			}).catch(error => { console.error(error); process.exitCode = 1; });
		`)
	})

	it("executes all operations without loading a viewer or importing storage directly", () => {
		isolatedNode(`
			const assert = require('node:assert/strict');
			const Module = require('node:module');
			const original = Module._load;
			Module._load = function(request, parent, main) {
				assert.ok(!/reactflow|@xyflow|elkjs|vscode|core\\/architecture/.test(request), request);
				return original.call(this, request, parent, main);
			};
			const tool = require('./src/core/task/tools/modules/architecture_diagram/tool').create();
			const env = {
				orchestration: { reportFailure() {} },
				ui: { createCard: async () => ({ update: async () => {}, finalize: async () => {} }) },
				architecture: {
					upsertDiagram: async () => ({ name: 'example', version: 1 }),
					listDiagrams: async () => [],
					fetchDiagram: async () => ({ name: 'example', version: 1, diagram: {} })
				}
			};
			Promise.all([
				{ operation: 'upsert_diagram', name: 'example', diagram: '{}' },
				{ operation: 'list_diagrams' },
				{ operation: 'fetch_diagram', name: 'example' },
				{ operation: 'display_diagram', name: 'example' },
				{ operation: 'display_comparison', name: 'example', start_version: 1, end_version: 2 }
			].map(args => tool.processCall(args, env))).catch(error => { console.error(error); process.exitCode = 1; });
		`)
	})

	it("upserts via the environment only and returns the committed identity", async () => {
		const diagram = JSON.stringify(graph)
		const { architecture, result, card } = await invoke({ operation: "upsert_diagram", name: "example", diagram })
		assert.equal(result.name, "example")
		assert.equal(result.version, 3)
		assert.equal(result.saved, true)
		assert.equal(result.outcome, "displayed")
		sinon.assert.calledOnceWithExactly(architecture.openDisplay, { name: "example", mode: "exact", version: 3 })
		sinon.assert.callOrder(architecture.upsertDiagram, architecture.openDisplay)
		sinon.assert.calledOnceWithExactly(architecture.upsertDiagram, "example", diagram)
		sinon.assert.notCalled(architecture.fetchDiagram)
		sinon.assert.calledWithExactly(card.finalize, CardStatus.SUCCESS)
	})

	it("returns the complete environment inventory, including an empty inventory", async () => {
		const fixture = environment()
		const { result } = await invoke({ operation: "list_diagrams" }, fixture)
		assert.deepEqual(result, [{ name: "example", versions: [1, 2, 3] }])
		const empty = environment()
		empty.architecture.listDiagrams.resolves([])
		assert.deepEqual((await invoke({ operation: "list_diagrams" }, empty)).result, [])
	})

	for (const version of [undefined, null, 2]) {
		it(`fetches ${version ?? "latest"} without substituting versions or copying graph content into its card`, async () => {
			const { architecture, result, card } = await invoke({ operation: "fetch_diagram", name: "example", version })
			sinon.assert.calledOnceWithExactly(architecture.fetchDiagram, "example", version ?? undefined)
			assert.deepEqual(result, { name: "example", version: 3, diagram: graph })
			assert.ok(!card.update.firstCall.args[0].body.includes(graph.summary))
		})
	}

	for (const input of [
		{ operation: "display_diagram", name: "example" },
		{ operation: "display_diagram", name: "example", version: 2 },
		{ operation: "display_comparison", name: "example", start_version: 3, end_version: 1 },
	]) {
		it(`returns explicit unavailable display selection for ${JSON.stringify(input)}`, async () => {
			const fixture = environment()
			fixture.env = { ...fixture.env, architecture: { ...fixture.env.architecture!, openDisplay: undefined } }
			const { result, architecture, card } = await invoke(input, fixture)
			const { operation, ...selection } = input
			assert.equal(result.outcome, "unavailable")
			assert.equal(result.operation, operation)
			assert.equal(result.selection.name, selection.name)
			assert.match(result.error, /unavailable/)
			assert.match(result.error, /example/)
			if (Object.keys(input).length === 2) assert.match(result.error, /latest version/)
			for (const method of Object.values(architecture)) sinon.assert.notCalled(method)
			sinon.assert.calledWithExactly(card.finalize, CardStatus.ERROR)
		})
	}

	const invalidInputs: unknown[] = [
		undefined,
		null,
		[],
		"list_diagrams",
		{},
		{ operation: null },
		{ operation: "toString" },
		{ operation: "display" },
		{ operation: "list_diagrams", name: "example" },
		{ operation: "list_diagrams", version: 1 },
		{ operation: "list_diagrams", unknown: null },
		{ operation: "upsert_diagram", diagram: "{}" },
		{ operation: "upsert_diagram", name: null, diagram: "{}" },
		{ operation: "upsert_diagram", name: "example", diagram: null },
		{ operation: "upsert_diagram", name: "example", diagram: {} },
		{ operation: "upsert_diagram", name: "example", diagram: "{}", version: 1 },
		{ operation: "fetch_diagram", name: " " },
		{ operation: "fetch_diagram", name: 5 },
		{ operation: "fetch_diagram", name: "example", diagram: "{}" },
		{ operation: "display_diagram", name: "example", start_version: 1 },
		{ operation: "display_comparison", name: "example", start_version: null, end_version: 1 },
		{ operation: "display_comparison", name: "example", start_version: 1 },
		{ operation: "display_comparison", name: "example", start_version: 1, end_version: 2, version: 1 },
		...[0, -1, 1.5, "1", true, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY].map((version) => ({
			operation: "fetch_diagram",
			name: "example",
			version,
		})),
	]
	for (const [index, input] of invalidInputs.entries()) {
		it(`rejects invalid/incompatible arguments #${index + 1} with a finalized error card`, async () => {
			const { result, architecture, card } = await invoke(input)
			assert.equal(result.outcome, "error")
			assert.ok(result.error.length > 0)
			for (const method of Object.values(architecture)) sinon.assert.notCalled(method)
			sinon.assert.calledWithExactly(card.finalize, CardStatus.ERROR)
		})
	}

	it("accepts unused nullable schema fields without treating null as required input", async () => {
		const result = await invoke({
			operation: "list_diagrams",
			name: null,
			diagram: null,
			version: null,
			start_version: null,
			end_version: null,
		})
		assert.ok(Array.isArray(result.result))
	})

	for (const [operation, method, params] of [
		["upsert_diagram", "upsertDiagram", { name: "example", diagram: "{}" }],
		["list_diagrams", "listDiagrams", {}],
		["fetch_diagram", "fetchDiagram", { name: "example", version: 17 }],
	] as const) {
		it(`returns ${operation} failures explicitly and leaves subsequent calls usable`, async () => {
			const fixture = environment()
			fixture.architecture[method].onFirstCall().rejects(new Error("nodes[0].id: invalid or missing version"))
			const { result } = await invoke({ operation, ...params }, fixture)
			assert.equal(result.operation, operation)
			assert.equal(result.outcome, "error")
			assert.match(result.error, /nodes\[0\]\.id/)
			assert.equal(result.version, undefined)
			const subsequent = JSON.parse(await create().processCall({ operation, ...params }, fixture.env))
			assert.equal(subsequent.outcome, operation === "upsert_diagram" ? "displayed" : undefined)
		})

		it(`reports an absent architecture trait for ${operation}`, async () => {
			const fixture = environment()
			fixture.env = { ...fixture.env, architecture: undefined }
			assert.equal((await invoke({ operation, ...params }, fixture)).result.outcome, "unavailable")
		})
	}

	it("retains publication ownership after timeout and warns that the write may have committed", async () => {
		const clock = sinon.useFakeTimers()
		const fixture = environment()
		let finishPublication!: (result: { name: string; version: number }) => void
		fixture.architecture.upsertDiagram.returns(new Promise((resolve) => { finishPublication = resolve }))
		let settled = false
		const pending = invoke({ operation: "upsert_diagram", name: "example", diagram: "{}" }, fixture)
			.then((result) => { settled = true; return result })
		await clock.tickAsync(DEFAULT_BOUNDED_TOOL_EXECUTION_MS + 1)
		assert.equal(settled, false)
		finishPublication({ name: "example", version: 4 })
		const { result } = await pending
		assert.equal(result.outcome, "timeout")
		assert.match(result.error, /List\/fetch before deciding whether to retry/)
		assert.equal(result.version, undefined)
		sinon.assert.notCalled(fixture.architecture.openDisplay)
	})

	for (const method of ["createCard", "update", "finalize"] as const) {
		it(`does not swallow shared card ${method} failures`, async () => {
			const fixture = environment()
			const error = new Error(`shared ${method} failed`)
			if (method === "createCard") fixture.ui.createCard.rejects(error)
			else fixture.card[method].rejects(error)
			await assert.rejects(
				create().processCall({ operation: "list_diagrams" }, fixture.env),
				(candidate) => candidate === error,
			)
			if (method === "update") sinon.assert.calledOnce(fixture.card.finalize)
		})
	}
})
