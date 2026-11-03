import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { CardStatus } from "@shared/ExtensionMessage"
import { ToolRegistry } from "../../../registry/ToolRegistry"
import { UserToolLoader } from "../../../discovery/UserToolLoader"
import { HostProvider } from "@hosts/host-provider"
import { UpsertTool } from "../UpsertTool"
import { createUpsertFixture, smokeHarnessPath, successfulSmoke, toolDefinition, type UpsertFixture } from "./upsert-test-fixture"

describe("UpsertTool deterministic installation", () => {
	let fixture: UpsertFixture
	beforeEach(async () => { fixture = await createUpsertFixture() })
	afterEach(async () => { await fixture.dispose() })

	it("validates the supplied body once, installs it, and enables a real loaded tool", async () => {
		const definition = toolDefinition({ implementation: 'return `${env.config.cwd}: ${args?.message ?? "usage"}`' })
		fixture.executeCommand.callsFake(async (command: string, options: unknown) => {
			assert.deepEqual(options, { timeout: 60_000 })
			const harnessPath = smokeHarnessPath(command)
			assert.equal(path.basename(harnessPath), "test-harness.ts")
			const stagingDir = path.dirname(harnessPath)
			assert.equal(path.dirname(stagingDir), fixture.buildsDir)
			assert.deepEqual(JSON.parse(await fs.readFile(path.join(stagingDir, "smoke-args.json"), "utf8")), JSON.parse(definition.smoke_args))
			const source = await fs.readFile(path.join(stagingDir, "tool.ts"), "utf8")
			assert.ok(source.includes(definition.implementation))
			assert.equal(fixture.registered(), undefined, "no registration before authorized validation")
			await assert.rejects(fs.access(fixture.toolDir()))
			return { ...successfulSmoke }
		})

		const result = await new UpsertTool().processCall({ tools: [definition] }, fixture.env)
		assert.match(result, /✓.*example_tool.*ready/)
		sinon.assert.calledOnce(fixture.executeCommand)
		sinon.assert.notCalled(fixture.runSubagent)
		const installed = fixture.registered()!
		assert.ok(installed, "real loader/registry must produce an executable tool")
		assert.equal(installed.modulePath, path.join(fixture.toolDir(), "tool.ts"))
		assert.deepEqual(installed.spec.parameters, definition.parameters)
		assert.equal(await installed.factory().processCall({ message: "installed" }, fixture.env), `${fixture.root}: installed`)
		assert.equal(ToolRegistry.getInstance().isEnabled(definition.name), true)
		sinon.assert.calledOnceWithExactly(fixture.withMutationAuthorization, "upsert_tool", sinon.match.func)
		sinon.assert.calledOnceWithExactly(fixture.commitEnabledToolToggles, [definition.name], sinon.match.func)
		sinon.assert.callOrder(fixture.withMutationAuthorization, fixture.executeCommand, fixture.transitionFromMutation, fixture.commitEnabledToolToggles)
		sinon.assert.calledWithExactly(fixture.finalize, CardStatus.SUCCESS)
		await fixture.assertStagingEmpty()
	})

	it("returns invalid implementation syntax to the parent without generation or retry", async () => {
		const result = await new UpsertTool().processCall({ tools: [toolDefinition({ implementation: "return (" })] }, fixture.env)
		assert.match(result, /❌ Validation errors/)
		assert.match(result, /implementation.*body.*expected/i)
		assert.doesNotMatch(result, /✓|is ready/)
		sinon.assert.notCalled(fixture.executeCommand)
		sinon.assert.notCalled(fixture.withMutationAuthorization)
		sinon.assert.notCalled(fixture.runSubagent)
		assert.equal(fixture.registered(), undefined)
		assert.deepEqual(await fs.readdir(fixture.root), [])
		sinon.assert.notCalled(fixture.createCard)
	})

	const smokeFailures = [
		{ label: "user rejection", result: { ...successfulSmoke, userRejected: true }, error: /rejected/i },
		{ label: "nonzero exit", result: { ...successfulSmoke, exitCode: 7, output: "fixture assertion failed" }, error: /7.*fixture assertion failed/ },
		{ label: "incomplete command", result: { ...successfulSmoke, completed: false }, error: /complete/i },
		{ label: "missing completion evidence", result: { userRejected: false, exitCode: 0, output: "no completion flag" }, error: /complete/i },
		{ label: "missing exit status", result: { userRejected: false, completed: true, output: "no exit code" }, error: /exit|status|success/i },
		{ label: "null exit status", result: { ...successfulSmoke, exitCode: null }, error: /exit|status|success/i },
		{ label: "terminated command", result: { ...successfulSmoke, signal: "SIGTERM" }, error: /signal|SIGTERM|terminat/i },
		{ label: "zero exit without harness completion marker", result: { ...successfulSmoke, output: "=== PASS: first call only" }, error: /completion|marker|harness.*complete/i },
	]
	for (const failure of smokeFailures) {
		it(`returns ${failure.label} for a parent decision, without autonomous retry`, async () => {
			fixture.executeCommand.resolves(failure.result)
			const result = await new UpsertTool().processCall({ tools: [toolDefinition()] }, fixture.env)
			assert.match(result, /❌.*example_tool.*failed/)
			assert.match(result, failure.error)
			assert.doesNotMatch(result, /✓|is ready/)
			sinon.assert.calledOnce(fixture.executeCommand)
			sinon.assert.notCalled(fixture.runSubagent)
			assert.equal(fixture.registered(), undefined)
			await assert.rejects(fs.access(fixture.toolDir()))
			await fixture.assertStagingEmpty()
			sinon.assert.calledWithExactly(fixture.finalize, CardStatus.ERROR)
		})
	}

	it("surfaces a thrown command failure without retrying or installing", async () => {
		fixture.executeCommand.rejects(new Error("authorization service unavailable"))
		const result = await new UpsertTool().processCall({ tools: [toolDefinition()] }, fixture.env)
		assert.match(result, /❌.*example_tool.*authorization service unavailable/)
		sinon.assert.calledOnce(fixture.executeCommand)
		sinon.assert.notCalled(fixture.runSubagent)
		assert.equal(fixture.registered(), undefined)
		await fixture.assertStagingEmpty()
	})

	it("keeps the old source and registry after failed update; a repaired parent call succeeds", async () => {
		const tool = new UpsertTool()
		await tool.processCall({ tools: [toolDefinition({ implementation: 'return "old version"' })] }, fixture.env)
		const previous = fixture.registered()!
		const oldSource = await fs.readFile(previous.modulePath, "utf8")
		fixture.executeCommand.resolves({ ...successfulSmoke, exitCode: 1, output: "Please fix the supplied body" })
		const failed = await tool.processCall({ tools: [toolDefinition({ implementation: 'throw new Error("broken update")' })] }, fixture.env)
		assert.match(failed, /❌.*example_tool.*Please fix the supplied body/)
		assert.doesNotMatch(failed, /✓|is ready/)
		assert.equal(fixture.registered(), previous)
		assert.equal(await fs.readFile(previous.modulePath, "utf8"), oldSource)
		assert.equal(await previous.factory().processCall({}, fixture.env), "old version")
		assert.equal(ToolRegistry.getInstance().isEnabled(previous.id), true)
		await fixture.assertStagingEmpty()

		fixture.executeCommand.resolves({ ...successfulSmoke })
		const repaired = await tool.processCall({ tools: [toolDefinition({ implementation: 'return "parent repaired"' })] }, fixture.env)
		assert.match(repaired, /✓.*example_tool.*ready/)
		assert.notEqual(fixture.registered(), previous)
		assert.equal(await fixture.registered()!.factory().processCall({}, fixture.env), "parent repaired")
		assert.notEqual(await fs.readFile(previous.modulePath, "utf8"), oldSource)
		assert.equal(fixture.executeCommand.callCount, 3, "one command per explicit parent call")
		sinon.assert.notCalled(fixture.runSubagent)
		await fixture.assertStagingEmpty()
	})

	it("reports mixed results and enables only the successful tool", async () => {
		fixture.executeCommand.callsFake(async (command: string) => command.includes("broken_tool-")
			? { ...successfulSmoke, exitCode: 1, output: "broken smoke fixture" }
			: { ...successfulSmoke })
		const result = await new UpsertTool().processCall({
			tools: [
				toolDefinition({ name: "good_tool" }),
				toolDefinition({ name: "broken_tool" }),
			]
		}, fixture.env)
		assert.match(result, /✓.*good_tool.*ready/)
		assert.match(result, /❌.*broken_tool.*broken smoke fixture/)
		assert.doesNotMatch(result, /✓.*broken_tool/)
		assert.ok(fixture.registered("good_tool"))
		assert.equal(fixture.registered("broken_tool"), undefined)
		sinon.assert.calledTwice(fixture.executeCommand)
		sinon.assert.notCalled(fixture.runSubagent)
		sinon.assert.calledOnceWithExactly(fixture.commitEnabledToolToggles, ["good_tool"], sinon.match.func)
		sinon.assert.calledWithExactly(fixture.finalize, CardStatus.ERROR)
		await fixture.assertStagingEmpty()
	})

	it("rejects a balanced-brace module escape before loader-side host code runs, even if smoke would be rejected", async () => {
		const marker = path.join(fixture.root, "host-import-executed.txt")
		const implementation = [
			'return "escaped"',
			"        },",
			"    }",
			"}",
			'import { writeFileSync } from "node:fs"',
			`writeFileSync(${JSON.stringify(marker)}, "unexpected host execution")`,
			"export function reopened() {",
			"    return {",
			"        async processCall() {",
			'return "reopened"',
		].join("\n")
		fixture.executeCommand.resolves({ ...successfulSmoke, userRejected: true })
		const result = await new UpsertTool().processCall({ tools: [toolDefinition({ implementation })] }, fixture.env)
		assert.match(result, /❌/)
		assert.match(result, /implementation|body|syntax|module/i)
		assert.doesNotMatch(result, /is ready/)
		await assert.rejects(fs.access(marker))
		sinon.assert.notCalled(fixture.executeCommand)
		sinon.assert.notCalled(fixture.runSubagent)
		assert.equal(fixture.registered(), undefined)
	})

	it("updates a disabled existing tool without enabling it or claiming it is ready", async () => {
		const tool = new UpsertTool()
		await tool.processCall({ tools: [toolDefinition({ implementation: 'return "previous"' })] }, fixture.env)
		ToolRegistry.getInstance().disable("example_tool")
		fixture.sandbox.resetHistory()
		const result = await tool.processCall({ tools: [toolDefinition({ implementation: 'return "updated but disabled"' })] }, fixture.env)
		assert.match(result, /installed|updated/i)
		assert.match(result, /disabled|not enabled/i)
		assert.doesNotMatch(result, /\bready\b/i)
		assert.equal(ToolRegistry.getInstance().isEnabled("example_tool"), false)
		assert.equal(await fixture.registered()!.factory().processCall({}, fixture.env), "updated but disabled")
		sinon.assert.calledOnceWithExactly(fixture.commitEnabledToolToggles, [], sinon.match.func)
		sinon.assert.calledOnce(fixture.executeCommand)
		assert.ok(fixture.update.args.every(([params]) => !/1\/1 tools ready/.test(params.body ?? "")))
		await fixture.assertStagingEmpty()
	})

	it("does not stage or validate anything when mutation authorization is denied", async () => {
		fixture.withMutationAuthorization.rejects(new Error("mutation authorization denied"))
		await assert.rejects(new UpsertTool().processCall({ tools: [toolDefinition()] }, fixture.env), /mutation authorization denied/)
		sinon.assert.notCalled(fixture.executeCommand)
		sinon.assert.notCalled(fixture.transitionFromMutation)
		sinon.assert.notCalled(fixture.commitEnabledToolToggles)
		sinon.assert.notCalled(fixture.runSubagent)
		assert.equal(fixture.registered(), undefined)
		await assert.rejects(fs.access(fixture.toolDir()))
		await assert.rejects(fs.access(fixture.buildsDir))
		fixture.assertNoReadiness()
		sinon.assert.calledWithExactly(fixture.finalize, CardStatus.ERROR)
	})

	for (const phase of ["transition", "toggle commit"] as const) {
		for (const updating of [false, true]) {
			it(`rolls back ${updating ? "an update" : "a new tool"} when ${phase} fails, never claiming readiness`, async () => {
				const tool = new UpsertTool()
				if (updating) await tool.processCall({ tools: [toolDefinition({ implementation: 'return "old version"' })] }, fixture.env)
				const previous = fixture.registered()
				const previousSource = updating ? await fs.readFile(fixture.toolDir() + "/tool.ts", "utf8") : undefined
				fixture.sandbox.resetHistory()
				const callback = phase === "transition" ? fixture.transitionFromMutation : fixture.commitEnabledToolToggles
				callback.callsFake(async () => {
					assert.ok(fixture.registered(), "activation happened before transaction failure")
					throw new Error(`${phase} failed`)
				})
				await assert.rejects(tool.processCall({ tools: [toolDefinition({ implementation: 'return "uncommitted"' })] }, fixture.env), new RegExp(`${phase} failed`))
				assert.equal(fixture.registered(), previous)
				assert.equal(ToolRegistry.getInstance().isEnabled("example_tool"), updating)
				if (updating) {
					assert.equal(await fs.readFile(path.join(fixture.toolDir(), "tool.ts"), "utf8"), previousSource)
					assert.equal(await previous!.factory().processCall({}, fixture.env), "old version")
				} else await assert.rejects(fs.access(fixture.toolDir()))
				fixture.assertNoReadiness()
				sinon.assert.calledWithExactly(fixture.finalize, CardStatus.ERROR)
				sinon.assert.notCalled(fixture.setTaskState)
				sinon.assert.calledOnce(fixture.executeCommand)
				await fixture.assertStagingEmpty()
			})
		}
	}

	it("restores old source and leaves registry untouched when a builtin conflicts at activation", async () => {
		const tool = new UpsertTool()
		await tool.processCall({ tools: [toolDefinition({ implementation: 'return "previous"' })] }, fixture.env)
		const previous = fixture.registered()!
		const oldSource = await fs.readFile(previous.modulePath, "utf8")
		const registry = ToolRegistry.getInstance()
		registry.registerBuiltin({ ...previous, source: "builtin", modulePath: "builtin:example_tool" })
		const inventory = registry.getAllTools("test-owner", fixture.root)
		const version = registry.getVersion()
		fixture.sandbox.resetHistory()
		const result = await tool.processCall({ tools: [toolDefinition({ implementation: 'return "conflicting update"' })] }, fixture.env)
		assert.match(result, /failed activation.*conflict/)
		assert.doesNotMatch(result, /✓|is ready/)
		assert.deepEqual(registry.getAllTools("test-owner", fixture.root), inventory)
		assert.equal(registry.getVersion(), version)
		assert.equal(await fs.readFile(previous.modulePath, "utf8"), oldSource)
		sinon.assert.calledOnce(fixture.executeCommand)
		await fixture.assertStagingEmpty()
	})

	for (const missingTool of [false, true]) {
		it(`rolls back a promoted update when the final loader ${missingTool ? "returns no tool" : "fails"}`, async () => {
			const tool = new UpsertTool()
			await tool.processCall({ tools: [toolDefinition({ implementation: 'return "previous"' })] }, fixture.env)
			const previous = fixture.registered()!
			const oldSource = await fs.readFile(previous.modulePath, "utf8")
			const load = UserToolLoader.loadWithDiagnostics.bind(UserToolLoader)
			fixture.sandbox.stub(UserToolLoader, "loadWithDiagnostics").callsFake(async (directory, scope) => {
				if (directory === fixture.toolDir()) return missingTool ? {} : { error: "controlled promoted load failure" }
				return load(directory, scope)
			})
			fixture.sandbox.resetHistory()
			const result = await tool.processCall({ tools: [toolDefinition({ implementation: 'return "new body"' })] }, fixture.env)
			assert.match(result, /failed activation.*promoted tool failed to load/)
			assert.doesNotMatch(result, /✓|is ready/)
			assert.equal(fixture.registered(), previous)
			assert.equal(await fs.readFile(previous.modulePath, "utf8"), oldSource)
			assert.equal(ToolRegistry.getInstance().isEnabled(previous.id), true)
			sinon.assert.calledOnce(fixture.executeCommand)
			await fixture.assertStagingEmpty()
		})
	}

	it("restores task bookkeeping, old task source and owner registry when setTaskState fails", async () => {
		fixture.sandbox.stub(HostProvider, "get").returns({ globalStorageFsPath: fixture.root } as HostProvider)
		let taskScopedToolIds = ["earlier_tool"]
		fixture.getTaskState.callsFake(() => taskScopedToolIds)
		fixture.setTaskState.callsFake((_key: string, ids: string[]) => { taskScopedToolIds = ids })
		const tool = new UpsertTool()
		const installed = await tool.processCall({ tools: [toolDefinition({ scope: "task", implementation: 'return "previous task tool"' })] }, fixture.env)
		assert.match(installed, /✓.*example_tool.*ready/)
		assert.doesNotMatch(installed, /disabled/)
		const previous = fixture.registered()!
		assert.equal(previous.ownerTaskId, "test-owner")
		assert.deepEqual(taskScopedToolIds, ["earlier_tool", "example_tool"])
		const oldSource = await fs.readFile(previous.modulePath, "utf8")
		fixture.sandbox.resetHistory()
		fixture.setTaskState.onFirstCall().callsFake((_key: string, ids: string[]) => {
			taskScopedToolIds = ids
			throw new Error("task bookkeeping persistence failed")
		})
		await assert.rejects(tool.processCall({
			tools: [
				toolDefinition({ scope: "task", implementation: 'return "uncommitted task update"' }),
				toolDefinition({ scope: "task", name: "new_task_tool" }),
			]
		}, fixture.env), /task bookkeeping persistence failed/)
		assert.deepEqual(taskScopedToolIds, ["earlier_tool", "example_tool"])
		assert.equal(fixture.registered(), previous)
		assert.equal(fixture.registered("new_task_tool"), undefined)
		assert.equal(await fs.readFile(previous.modulePath, "utf8"), oldSource)
		assert.equal(await previous.factory().processCall({}, fixture.env), "previous task tool")
		await assert.rejects(fs.access(path.join(path.dirname(path.dirname(previous.modulePath)), "new_task_tool")))
		assert.deepEqual(await fs.readdir(path.join(fixture.root, "tasks", "test-owner", "tool-builds")), [])
		fixture.assertNoReadiness()
		sinon.assert.calledTwice(fixture.setTaskState)
		sinon.assert.calledTwice(fixture.executeCommand)
	})

	it("rolls back every activation when a batch toggle commit fails", async () => {
		fixture.commitEnabledToolToggles.rejects(new Error("batch toggle commit failed"))
		await assert.rejects(new UpsertTool().processCall({ tools: [toolDefinition({ name: "first_tool" }), toolDefinition({ name: "second_tool" })] }, fixture.env), /batch toggle commit failed/)
		for (const name of ["first_tool", "second_tool"]) {
			assert.equal(fixture.registered(name), undefined)
			assert.equal(ToolRegistry.getInstance().isEnabled(name), false)
			await assert.rejects(fs.access(fixture.toolDir(name)))
		}
		fixture.assertNoReadiness()
		await fixture.assertStagingEmpty()
	})
})

describe("UpsertTool request validation", () => {
	let fixture: UpsertFixture
	beforeEach(async () => { fixture = await createUpsertFixture() })
	afterEach(async () => { await fixture.dispose() })

	const invalidRequests: { label: string; args: unknown; error: RegExp }[] = [
		{ label: "missing args", args: undefined, error: /tools/ },
		{ label: "null args", args: null, error: /tools/ },
		{ label: "missing tools", args: {}, error: /tools/ },
		{ label: "empty tools", args: { tools: [] }, error: /non-empty/ },
		{ label: "non-array tools", args: { tools: {} }, error: /array/ },
		{ label: "null definition", args: { tools: [null] }, error: /tools\[0\].*object/ },
		{ label: "array definition", args: { tools: [[]] }, error: /tools\[0\].*object/ },
		{ label: "duplicate names", args: { tools: [toolDefinition(), toolDefinition()] }, error: /duplicate.*example_tool/ },
	]
	const invalidFields: { label: string; overrides: Record<string, unknown>; error: RegExp }[] = [
		{ label: "missing name", overrides: { name: undefined }, error: /name/ },
		{ label: "unsafe name", overrides: { name: "../outside" }, error: /name/ },
		{ label: "non-string name", overrides: { name: {} }, error: /name/ },
		{ label: "invalid scope", overrides: { scope: "session" }, error: /scope/ },
		{ label: "missing description", overrides: { description: undefined }, error: /description/ },
		{ label: "blank description", overrides: { description: "  " }, error: /description/ },
		{ label: "non-array parameters", overrides: { parameters: {} }, error: /parameters/ },
		{ label: "missing implementation", overrides: { implementation: undefined }, error: /implementation/ },
		{ label: "blank implementation", overrides: { implementation: " \n\t" }, error: /implementation/ },
		{ label: "non-string implementation", overrides: { implementation: {} }, error: /implementation/ },
		{ label: "obsolete requirements only", overrides: { implementation: undefined, requirements: "Generate this for me" }, error: /implementation/ },
		{ label: "missing smoke_args", overrides: { smoke_args: undefined }, error: /smoke_args/ },
		{ label: "null smoke_args", overrides: { smoke_args: null }, error: /smoke_args/ },
		{ label: "array smoke_args", overrides: { smoke_args: [] }, error: /smoke_args/ },
		{ label: "object smoke_args", overrides: { smoke_args: {} }, error: /smoke_args/ },
		{ label: "empty smoke_args", overrides: { smoke_args: "" }, error: /smoke_args/ },
		{ label: "malformed smoke JSON", overrides: { smoke_args: '{"message":' }, error: /smoke_args/ },
		{ label: "JSON array smoke args", overrides: { smoke_args: "[]" }, error: /smoke_args/ },
		{ label: "JSON null smoke args", overrides: { smoke_args: "null" }, error: /smoke_args/ },
		{ label: "JSON scalar smoke args", overrides: { smoke_args: "7" }, error: /smoke_args/ },
		{ label: "null parameter", overrides: { parameters: [null] }, error: /parameters\[0\]/ },
		{ label: "missing parameter name", overrides: { parameters: [{ type: "string", required: true, instruction: "Value" }] }, error: /parameters\[0\].*name/ },
		{ label: "unsupported parameter type", overrides: { parameters: [{ name: "message", type: "function", required: true, instruction: "Value" }] }, error: /parameters\[0\].*type/ },
		{ label: "non-boolean parameter required", overrides: { parameters: [{ name: "message", type: "string", required: "true", instruction: "Value" }] }, error: /parameters\[0\].*required/ },
		{ label: "missing parameter instruction", overrides: { parameters: [{ name: "message", type: "string", required: true }] }, error: /parameters\[0\].*instruction/ },
	]
	for (const entry of invalidFields) invalidRequests.push({ label: entry.label, args: { tools: [toolDefinition(entry.overrides)] }, error: entry.error })

	for (const entry of invalidRequests) {
		it(`rejects ${entry.label} before authorization or filesystem mutation`, async () => {
			const result = await new UpsertTool().processCall(entry.args, fixture.env)
			assert.match(result, /❌/)
			assert.match(result, entry.error)
			sinon.assert.notCalled(fixture.withMutationAuthorization)
			sinon.assert.notCalled(fixture.createCard)
			sinon.assert.notCalled(fixture.executeCommand)
			sinon.assert.notCalled(fixture.runSubagent)
			assert.deepEqual(await fs.readdir(fixture.root), [])
		})
	}

	it("accepts tools without parameters and an empty smoke object", async () => {
		const result = await new UpsertTool().processCall({ tools: [toolDefinition({ parameters: [], smoke_args: "{}", implementation: 'return "pure result"' })] }, fixture.env)
		assert.match(result, /✓.*example_tool.*ready/)
		sinon.assert.calledOnce(fixture.executeCommand)
		assert.equal(await fixture.registered()!.factory().processCall({}, fixture.env), "pure result")
	})
})
