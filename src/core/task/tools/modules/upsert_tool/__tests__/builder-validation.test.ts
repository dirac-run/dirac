import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, it } from "mocha"
import { CardStatus } from "@shared/ExtensionMessage"
import { DiracAskResponse } from "@shared/WebviewMessage"
import type { IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { createCardFromMessenger } from "../../../adapters/traits/UiTraitBuilder"
import { validateStagedTool } from "../builder-validation"
import { buildManifest, SMOKE_ARGS_FILE } from "../constants"
import { buildToolSource, writeTestHarness } from "../scaffold-generator"
import { createUpsertFixture, successfulSmoke, type UpsertFixture } from "./upsert-test-fixture"

const execFileAsync = promisify(execFile)

describe("validateStagedTool smoke-args boundary", () => {
	let fixture: UpsertFixture
	beforeEach(async () => { fixture = await createUpsertFixture() })
	afterEach(async () => { await fixture.dispose() })

	async function staged(smokeArgs?: string, implementation = 'return args?.message ?? "usage"') {
		const directory = path.join(fixture.root, "staging")
		await fs.mkdir(directory)
		await fs.writeFile(path.join(directory, "dirac-tool.json"), JSON.stringify(buildManifest("example_tool", "workspace", "Example", [])))
		await fs.writeFile(path.join(directory, "tool.ts"), buildToolSource("example_tool", "Example", [], implementation))
		await writeTestHarness(directory)
		if (smokeArgs !== undefined) await fs.writeFile(path.join(directory, SMOKE_ARGS_FILE), smokeArgs)
		return directory
	}

	it("rejects a missing smoke-args.json before running a command", async () => {
		const result = await validateStagedTool(fixture.env, await staged(), "workspace")
		assert.ok(result.error?.includes(SMOKE_ARGS_FILE))
		assert.equal(fixture.executeCommand.callCount, 0)
	})

	it("rejects malformed smoke-args.json with a payload excerpt", async () => {
		const result = await validateStagedTool(fixture.env, await staged('{"path": '), "workspace")
		assert.match(result.error ?? "", /malformed JSON/)
		assert.match(result.error ?? "", /path/)
		assert.equal(fixture.executeCommand.callCount, 0)
	})

	for (const value of ['["not", "object"]', "null", '"text"', "3"]) {
		it(`rejects non-object smoke-args.json: ${value}`, async () => {
			const result = await validateStagedTool(fixture.env, await staged(value), "workspace")
			assert.match(result.error ?? "", /schema mismatch/)
			assert.equal(fixture.executeCommand.callCount, 0)
		})
	}

	it("loads the real tool and runs exactly one command for valid smoke args", async () => {
		const result = await validateStagedTool(fixture.env, await staged('{"message":"hello"}'), "workspace")
		assert.equal(result.error, undefined)
		assert.ok(result.tool)
		assert.equal(await result.tool.factory().processCall({ message: "loaded" }, fixture.env), "loaded")
		assert.equal(fixture.executeCommand.callCount, 1)
	})

	it("waits for approval of the exact smoke command before execution", async () => {
		fixture.autoApprover.isCommandAutoApproved.returns(false)
		let approve!: (interaction: { action: DiracAskResponse }) => void
		let showPermission!: () => void
		const permissionShown = new Promise<void>((resolve) => { showPermission = resolve })
		fixture.waitForInteraction.callsFake(() => new Promise((resolve) => {
			approve = resolve
			showPermission()
		}))
		const directory = await staged("{}")
		const validation = validateStagedTool(fixture.env, directory, "workspace")
		await permissionShown
		assert.equal(fixture.executeCommand.callCount, 0)
		const params = fixture.createCard.firstCall.args[0]
		assert.equal(params.requireApproval, true)
		assert.deepEqual(params.permissionOperation, { kind: "commands", commands: [`npx tsx '${path.join(directory, "test-harness.ts")}'`] })
		approve({ action: DiracAskResponse.APPROVE })
		assert.equal((await validation).error, undefined)
		assert.equal(fixture.executeCommand.firstCall.args[0], params.permissionOperation.commands[0])
		assert.equal(fixture.finalize.firstCall.args[0], CardStatus.SUCCESS)
	})

	it("does not execute the smoke implementation after permission rejection", async () => {
		fixture.autoApprover.isCommandAutoApproved.returns(false)
		fixture.waitForInteraction.resolves({ action: DiracAskResponse.REJECT })
		const result = await validateStagedTool(fixture.env, await staged("{}"), "workspace")
		assert.match(result.error ?? "", /rejected/)
		assert.equal(fixture.executeCommand.callCount, 0)
		assert.equal(fixture.finalize.firstCall.args[0], CardStatus.CANCELLED)
	})

	it("requires a command decision from the tasklet owner even when local policy approves", async () => {
		fixture.autoApprover.requiresCounterpartyApproval = true
		fixture.waitForInteraction.resolves({ action: DiracAskResponse.REJECT })
		fixture.env.config.taskMessenger = {
			routesToOwner: true, createCard: fixture.createCard,
		} as unknown as IToolEnvironment["config"]["taskMessenger"]
		fixture.env.config.toolUse = { name: "upsert_tool", params: { tools: [] } }
		fixture.env.ui.createCard = (params) => createCardFromMessenger(fixture.env.config, params, [])
		const result = await validateStagedTool(fixture.env, await staged("{}"), "workspace")
		assert.match(result.error ?? "", /rejected/)
		assert.equal(fixture.autoApprover.isCommandAutoApproved.callCount, 0)
		assert.equal(fixture.executeCommand.callCount, 0)
		const forwarded = fixture.createCard.firstCall.args[0]
		assert.equal(forwarded.permissionOperation.kind, "commands")
		assert.deepEqual(forwarded.toolCall, { name: "upsert_tool", arguments: { tools: [] } })
	})

	for (const staticallyApproved of [false, true]) {
		it(`keeps child smoke approval manual-only with Utility enabled (static approval: ${staticallyApproved})`, async () => {
			fixture.autoApprover.requiresCounterpartyApproval = true
			fixture.autoApprover.isUnrestrictedAutoApprove.returns(true)
			fixture.autoApprover.isCommandAutoApproved.returns(staticallyApproved)
			fixture.commandPermissionController.validateTool.returns({ allowed: true, reason: "allowed", matchedPattern: "**" })
			fixture.env.config.permissionDecisionBinding = {} as NonNullable<IToolEnvironment["config"]["permissionDecisionBinding"]>
			fixture.waitForInteraction.resolves({ action: DiracAskResponse.REJECT })

			const result = await validateStagedTool(fixture.env, await staged("{}"), "workspace")

			assert.match(result.error ?? "", /rejected/)
			assert.equal(fixture.createCard.firstCall.args[0].permissionRequestKind, "manual_tool")
			assert.equal(fixture.autoApprover.isCommandAutoApproved.callCount, 0)
			assert.equal(fixture.commandPermissionController.validateTool.callCount, 0)
			assert.equal(fixture.executeCommand.callCount, 0)
		})
	}

	it("keeps deterministic command restrictions manual-only with Utility enabled", async () => {
		fixture.env.config.permissionDecisionBinding = {} as NonNullable<IToolEnvironment["config"]["permissionDecisionBinding"]>
		fixture.commandPermissionController.validateTool.returns({ allowed: false, reason: "denied" })
		fixture.waitForInteraction.resolves({ action: DiracAskResponse.REJECT })
		await validateStagedTool(fixture.env, await staged("{}"), "workspace")
		assert.equal(fixture.createCard.firstCall.args[0].permissionRequestKind, "manual_tool")
		assert.equal(fixture.executeCommand.callCount, 0)
	})

	it("rejects invalid syntax without executing the smoke command", async () => {
		const result = await validateStagedTool(fixture.env, await staged("{}", "return ("), "workspace")
		assert.match(result.error ?? "", /failed to compile or load/)
		assert.equal(fixture.executeCommand.callCount, 0)
	})

	it("bounds smoke failure output while preserving the exit status", async () => {
		fixture.executeCommand.resolves({ ...successfulSmoke, exitCode: 9, output: "useful failure detail " + "x".repeat(5000) })
		const result = await validateStagedTool(fixture.env, await staged("{}"), "workspace")
		assert.match(result.error ?? "", /9.*useful failure detail/)
		assert.ok(result.error!.length < 4200)
	})

	// No shell execution, package install, or network: only an already-installed local tsx
	// and fixed, pure tool bodies. The normal authorization stub is replaced in this test only.
	for (const scenario of [
		{ label: "success", implementation: 'return args?.message ? `real smoke: ${args.message}` : "Usage: message"', error: undefined },
		{ label: "runtime exception", implementation: 'throw new Error("pure fixture runtime failure")', error: /pure fixture runtime failure/ },
		{ label: "non-string result", implementation: "return 42 as any", error: /must return a string/ },
		{ label: "premature zero exit", implementation: "process.exit(0)", error: /completion|marker|harness.*complete/i },
		{ label: "zero exit during empty-args check", implementation: 'if (!args?.message) process.exit(0); return "first call passed"', error: /completion|marker|harness.*complete/i },
	]) {
		it(`runs the actual safe smoke harness via local tsx: ${scenario.label}`, async function () {
			let tsxCli: string
			try { tsxCli = process.env.DIRAC_TEST_TSX_CLI ?? require.resolve("tsx/cli") } catch { this.skip(); return }
			this.timeout(15_000)
			const directory = await staged('{"message":"hello"}', scenario.implementation)
			let commands = 0
			const env = {
				...fixture.env,
				system: {
					executeCommand: async () => {
						commands++
						try {
							const { stdout, stderr } = await execFileAsync(process.execPath, [tsxCli, path.join(directory, "test-harness.ts")], { cwd: directory, timeout: 10_000 })
							return { ...successfulSmoke, output: stdout + stderr }
						} catch (error: any) {
							return { userRejected: false, completed: true, exitCode: error.code, signal: error.signal, output: `${error.stdout}${error.stderr}` }
						}
					},
				},
			} as unknown as IToolEnvironment
			const result = await validateStagedTool(env, directory, "workspace")
			assert.equal(commands, 1)
			if (scenario.error) assert.match(result.error ?? "", scenario.error)
			else {
				assert.equal(result.error, undefined)
				assert.ok(result.tool)
			}
		})
	}
})
