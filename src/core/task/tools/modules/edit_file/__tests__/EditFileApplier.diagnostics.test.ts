import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import type { IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { EditFileApplier } from "../EditFileApplier"
import type { PreparedFileBatch } from "../types"
import type { EditFormatter } from "../utils/EditFormatter"

const batch: PreparedFileBatch = {
	absolutePath: "/workspace/file.ts",
	displayPath: "file.ts",
	blocks: [],
	prepared: {} as PreparedFileBatch["prepared"],
}

function savedFiles() {
	return new Map([
		[
			batch.absolutePath,
			{
				saveResult: { content: "saved", userEdits: false, autoFormatting: false },
				finalContent: "saved",
				finalLines: ["saved"],
				newLineHashes: ["Anchor"],
				postSaveWarning: undefined,
				userModified: false,
			},
		],
	])
}

describe("EditFileApplier diagnostics availability", () => {
	it("reports unavailable diagnostics while retaining successful edit results", async () => {
		const createResultsResponse = sinon.stub().returns("saved edit")
		const applier = new EditFileApplier({ createResultsResponse } as unknown as EditFormatter)
		const env = { diagnostics: undefined } as unknown as IToolEnvironment

		const results = await applier.finalizeResults(env, [batch], savedFiles())

		assert.deepEqual(results, ["saved edit"])
		sinon.assert.calledOnce(createResultsResponse)
		assert.equal(createResultsResponse.firstCall.args[3].newProblemsMessage, "Diagnostics not available on this host.")
	})

	it("still collects and formats diagnostics on a capable host", async () => {
		const diagnostics = {
			prepare: sinon.stub().resolves(),
			getRaw: sinon.stub().resolves([{ filePath: batch.absolutePath, diagnostics: [{ message: "problem" }] }]),
			formatProblems: sinon.stub().resolves("problem"),
		}
		const createResultsResponse = sinon.stub().returns("saved edit with problem")
		const applier = new EditFileApplier({ createResultsResponse } as unknown as EditFormatter)

		const results = await applier.finalizeResults({ diagnostics } as unknown as IToolEnvironment, [batch], savedFiles())

		assert.deepEqual(results, ["saved edit with problem"])
		sinon.assert.calledOnceWithExactly(diagnostics.prepare, [batch.absolutePath])
		sinon.assert.calledOnceWithExactly(diagnostics.getRaw, [batch.absolutePath])
		sinon.assert.calledOnce(diagnostics.formatProblems)
		assert.match(createResultsResponse.firstCall.args[3].newProblemsMessage, /Found 1 problems.*\nproblem/)
	})
})
