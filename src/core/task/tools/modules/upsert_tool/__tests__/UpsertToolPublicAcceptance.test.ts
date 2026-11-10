import { executeToolInvocation } from "../../../__tests__/helpers/executeToolInvocation"
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import type { ToolUse } from "@core/assistant-message"
import { CardStatus } from "@shared/ExtensionMessage"
import { createMockTaskConfig } from "../../../__tests__/helpers/mockTaskConfig"
import type { ICardHandle } from "../../../interfaces/IToolEnvironment"
import type { ToolEnvironmentFactory } from "../../../interfaces/ToolEnvironmentFactory"
import { ToolRegistry } from "../../../registry/ToolRegistry"
import { ToolExecutorCoordinator } from "../../../ToolExecutorCoordinator"
import { create } from "../tool"
import { createUpsertFixture, smokeHarnessPath, successfulSmoke, toolDefinition, type UpsertFixture } from "./upsert-test-fixture"

describe("upsert_tool public coordinator acceptance (controlled smoke-command results)", () => {
	let fixture: UpsertFixture
	beforeEach(async () => { fixture = await createUpsertFixture() })
	afterEach(async () => { await fixture.dispose() })

	it("returns a failed update to the parent, keeps the old tool callable, and installs only an explicit parent repair", async () => {
		const { config, context } = createMockTaskConfig({
			cwd: fixture.root,
			overrides: { taskId: "test-owner", autoApprover: fixture.env.config.autoApprover },
			serviceOverrides: { commandPermissionController: fixture.env.config.services.commandPermissionController },
			callbackOverrides: fixture.env.config.callbacks,
		})
		const save = fixture.sandbox.spy(context, "save")
		const environmentFactory: ToolEnvironmentFactory = {
			create(toolConfig) {
				const cards: ICardHandle[] = []
				return {
					...fixture.env,
					config: toolConfig,
					context,
					ui: {
						...fixture.env.ui,
						async createCard(params) {
							await fixture.createCard(params)
							const card = {
								id: `acceptance-${cards.length}`,
								status: params.status ?? CardStatus.RUNNING,
								update: fixture.update,
								async finalize(status: CardStatus) {
									await fixture.finalize(status)
									card.status = status
								},
							}
							cards.push(card as unknown as ICardHandle)
							return card as unknown as ICardHandle
						},
					},
					getCustomMetadata: () => ({}),
					getCreatedCards: () => cards,
				}
			},
		}
		const coordinator = new ToolExecutorCoordinator(environmentFactory)
		coordinator.registerModularTool(create())
		config.coordinator = coordinator
		const parentUpsert = (definition: ReturnType<typeof toolDefinition>) => executeToolInvocation(coordinator, config, {
			// ToolUse's legacy parameter union does not yet include upsert_tool's tools field.
			type: "tool_use", name: "upsert_tool", params: { tools: [definition] } as ToolUse["params"], isNativeToolCall: true,
		})
		const invokeEnabledTool = (message: string) => {
			// Model the next request's inventory binding explicitly, not automatic coordinator refresh.
			const nextRequest = coordinator.createEmptySibling()
			for (const tool of ToolRegistry.getInstance().getEnabledTools(config.taskId, fixture.root)) {
				nextRequest.registerModularTool(tool.factory(config))
			}
			assert.equal(nextRequest.has("example_tool"), true)
			return executeToolInvocation(nextRequest, config, {
				type: "tool_use", name: "example_tool", params: { message }, isNativeToolCall: true,
			})
		}
		const definitions = [
			toolDefinition({ implementation: 'return `old: ${args.message}`' }),
			toolDefinition({ implementation: 'throw new Error("broken parent update")' }),
			toolDefinition({ implementation: 'return `repaired: ${args.message} at ${env.config.cwd}`' }),
		]
		// Only command execution is controlled here; staged loading, promotion and registration are real.
		fixture.executeCommand.callsFake(async (command: string, options: unknown) => {
			const index = fixture.executeCommand.callCount - 1
			const stagingDir = path.dirname(smokeHarnessPath(command))
			assert.equal(path.dirname(stagingDir), fixture.buildsDir)
			assert.deepEqual(options, { timeout: 60_000 })
			assert.ok((await fs.readFile(path.join(stagingDir, "tool.ts"), "utf8")).includes(definitions[index].implementation))
			assert.equal(await fs.readFile(path.join(stagingDir, "smoke-args.json"), "utf8"), definitions[index].smoke_args)
			return index === 1
				? { ...successfulSmoke, exitCode: 1, output: "controlled smoke failure: broken parent update" }
				: { ...successfulSmoke }
		})

		assert.match(await parentUpsert(definitions[0]) as string, /✓.*example_tool.*ready/)
		const previous = fixture.registered()!
		assert.ok(previous, "installation must register a real loaded tool")
		assert.equal(previous.modulePath, path.join(fixture.toolDir(), "tool.ts"))
		const oldSource = await fs.readFile(previous.modulePath, "utf8")
		assert.equal(await invokeEnabledTool("before update"), "old: before update")

		const parentFailure = await parentUpsert(definitions[1]) as string
		assert.match(parentFailure, /❌.*example_tool.*failed validation.*controlled smoke failure: broken parent update/)
		assert.match(parentFailure, /Repair implementation or smoke_args and call upsert_tool again/)
		assert.doesNotMatch(parentFailure, /✓|\bready\b/)
		assert.equal(fixture.executeCommand.callCount, 2, "no autonomous retry before the parent repairs")
		assert.equal(fixture.registered(), previous)
		assert.equal(await fs.readFile(previous.modulePath, "utf8"), oldSource)
		assert.equal(ToolRegistry.getInstance().isEnabled("example_tool"), true)
		assert.equal(await invokeEnabledTool("after failure"), "old: after failure")
		await fixture.assertStagingEmpty()

		// A distinct parent dispatch supplies the corrected body; the installer never generates it.
		assert.match(await parentUpsert(definitions[2]) as string, /✓.*example_tool.*ready/)
		assert.notEqual(fixture.registered(), previous)
		assert.notEqual(await fs.readFile(previous.modulePath, "utf8"), oldSource)
		assert.equal(await invokeEnabledTool("through public dispatch"), `repaired: through public dispatch at ${fixture.root}`)
		assert.equal(fixture.executeCommand.callCount, 3, "one validation command per explicit parent upsert")
		sinon.assert.notCalled(fixture.runSubagent)
		assert.deepEqual(fixture.finalize.args.map(([status]) => status), [CardStatus.SUCCESS, CardStatus.ERROR, CardStatus.SUCCESS])
		assert.equal(save.callCount, 6, "all three upserts and three real tool invocations use coordinator persistence")
		await fixture.assertStagingEmpty()
	})
})
