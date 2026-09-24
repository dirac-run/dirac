import { strict as assert } from "node:assert"
import * as fs from "fs/promises"
import { describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import type { IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { validateStagedTool } from "../builder-validation"
import { SMOKE_ARGS_FILE } from "../constants"

const TOOL_SOURCE = "export async function processCall() { return 'ok' }\n"

async function makeStagedDir(files: Record<string, string>): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-staged-"))
	for (const [name, content] of Object.entries(files)) {
		await fs.writeFile(path.join(dir, name), content, "utf8")
	}
	return dir
}

// Harness never runs when smoke-args is malformed — executeCommand would throw if reached.
function makeEnv(executeCommand?: IToolEnvironment["system"]["executeCommand"]): IToolEnvironment {
	return {
		system: {
			executeCommand: executeCommand ?? (() => Promise.reject(new Error("harness should not run"))),
		},
	} as unknown as IToolEnvironment
}

describe("validateStagedTool smoke-args boundary", () => {
	it("rejects a missing smoke-args.json", async () => {
		const dir = await makeStagedDir({ "tool.ts": TOOL_SOURCE })
		const result = await validateStagedTool(makeEnv(), dir, "workspace")
		assert.ok(result.error?.includes(SMOKE_ARGS_FILE))
	})

	it("rejects malformed smoke-args.json with a payload excerpt", async () => {
		const dir = await makeStagedDir({ "tool.ts": TOOL_SOURCE, [SMOKE_ARGS_FILE]: '{"path": ' })
		const result = await validateStagedTool(makeEnv(), dir, "workspace")
		assert.ok(result.error?.includes("malformed JSON"), `expected malformed-JSON error, got: ${result.error}`)
	})

	it("rejects smoke-args.json that is not a JSON object", async () => {
		const dir = await makeStagedDir({ "tool.ts": TOOL_SOURCE, [SMOKE_ARGS_FILE]: '["not", "object"]' })
		const result = await validateStagedTool(makeEnv(), dir, "workspace")
		assert.ok(result.error?.includes("schema mismatch"), `expected schema error, got: ${result.error}`)
	})

	it("passes valid smoke-args.json through to the harness stage", async () => {
		const dir = await makeStagedDir({ "tool.ts": TOOL_SOURCE, [SMOKE_ARGS_FILE]: '{"path": "x.ts"}' })
		const env = makeEnv(
			(() => Promise.resolve({ userRejected: false, exitCode: 0, output: "", completed: true })) as never,
		)
		const result = await validateStagedTool(env, dir, "workspace")
		// Past smoke-args, the failure must come from tool loading, not arg validation.
		assert.ok(result.error?.includes("failed to compile or load"), `expected load-stage error, got: ${result.error}`)
	})
})
