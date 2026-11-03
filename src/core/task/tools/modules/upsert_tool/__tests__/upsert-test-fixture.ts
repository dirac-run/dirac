import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import sinon from "sinon"
import { CardStatus } from "@shared/ExtensionMessage"
import { SMOKE_COMPLETION_MARKER } from "../constants"
import type { IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { ToolRegistry } from "../../../registry/ToolRegistry"

export const successfulSmoke = { userRejected: false, output: `=== PASS: ok\n${SMOKE_COMPLETION_MARKER}`, completed: true, exitCode: 0, signal: null }

export function smokeHarnessPath(command: string): string {
	assert.match(command, /^npx tsx '/)
	assert.ok(command.endsWith("'"))
	return command.slice("npx tsx '".length, -1).replaceAll("'\\''", "'")
}

export function toolDefinition(overrides: Record<string, unknown> = {}) {
	return {
		name: "example_tool",
		scope: "workspace",
		description: "Echo a supplied message",
		parameters: [{ name: "message", type: "string", required: true, instruction: "Message to echo" }],
		implementation: 'return args?.message ? `Echo: ${args.message}` : "Usage: provide message"',
		smoke_args: '{"message":"hello"}',
		...overrides,
	}
}

/** Only command authorization and host callbacks are stubbed; disk, compilation and registry stay real. */
export async function createUpsertFixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-upsert-deterministic-"))
	const sandbox = sinon.createSandbox()
	const previousHome = process.env.DIRAC_DIR
	process.env.DIRAC_DIR = path.join(root, "home")
	ToolRegistry.resetInstance()

	const update = sandbox.stub().resolves()
	const finalize = sandbox.stub().resolves()
	const createCard = sandbox.stub().resolves({ update, finalize })
	const executeCommand = sandbox.stub().resolves({ ...successfulSmoke })
	const runSubagent = sandbox.stub().rejects(new Error("upsert_tool must not generate or repair implementations"))
	const withMutationAuthorization = sandbox.stub().callsFake(async (_name: string, mutation: () => Promise<unknown>) => mutation())
	const transitionFromMutation = sandbox.stub().callsFake(async (transition: () => Promise<unknown>) => transition())
	const commitEnabledToolToggles = sandbox.stub().callsFake(async (_ids: string[], commit: () => Promise<void>) => commit())
	const getTaskState = sandbox.stub().returns([])
	const setTaskState = sandbox.stub()
	const env = {
		config: {
			cwd: root,
			taskId: "test-owner",
			callbacks: { withMutationAuthorization, transitionFromMutation, commitEnabledToolToggles },
		},
		ui: { createCard },
		system: { executeCommand },
		orchestration: { runSubagent, getHistory: () => [], getTaskState, setTaskState },
	} as unknown as IToolEnvironment

	return {
		root, env, sandbox, update, finalize, createCard, executeCommand, runSubagent,
		withMutationAuthorization, transitionFromMutation, commitEnabledToolToggles, getTaskState, setTaskState,
		toolDir: (name = "example_tool") => path.join(root, ".dirac", "tools", name),
		buildsDir: path.join(root, ".dirac", "tool-builds"),
		registered: (name = "example_tool") => ToolRegistry.getInstance().getAllTools("test-owner", root).find((tool) => tool.id === name),
		async assertStagingEmpty() {
			assert.deepEqual(await fs.readdir(path.join(root, ".dirac", "tool-builds")), [])
		},
		assertNoReadiness() {
			assert.ok(update.args.every(([params]) => !/\btools ready\b/.test(params.body ?? "")))
			assert.ok(finalize.args.every(([status]) => status !== CardStatus.SUCCESS))
		},
		async dispose() {
			sandbox.restore()
			ToolRegistry.resetInstance()
			if (previousHome === undefined) delete process.env.DIRAC_DIR
			else process.env.DIRAC_DIR = previousHome
			await fs.rm(root, { recursive: true, force: true })
		},
	}
}

export type UpsertFixture = Awaited<ReturnType<typeof createUpsertFixture>>
