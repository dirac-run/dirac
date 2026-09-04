import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import "@utils/path"
import type { IToolEnvironment, SaveResult } from "../../interfaces/IToolEnvironment"
import { WriteToFileTool } from "./WriteToFileTool"

function createEnvironment(problemCount: number): IToolEnvironment {
	return {
		config: { isSubagentExecution: false },
		editor: { reset: sinon.stub().resolves() },
		diagnostics: {
			prepare: sinon.stub().resolves(),
			getRaw: sinon
				.stub()
				.resolves([
					{
						filePath: "/workspace/file.ts",
						diagnostics: Array.from({ length: problemCount }, () => ({ message: "problem" })),
					},
				]),
		},
		telemetry: { captureCustomMetadata: sinon.stub() },
	} as unknown as IToolEnvironment
}

const cleanSave: SaveResult = { content: "saved", userEdits: false, autoFormatting: false }

describe("WriteToFileTool results", () => {
	it("does not count an empty diagnostic file group as a problem", async () => {
		const result = await new WriteToFileTool()["finalizeResults"](
			createEnvironment(0),
			"/workspace/file.ts",
			"file.ts",
			true,
			cleanSave,
			true,
		)
		assert.equal(result, "Saved file.ts.")
	})

	it("counts diagnostics within the file group", async () => {
		const result = await new WriteToFileTool()["finalizeResults"](
			createEnvironment(3),
			"/workspace/file.ts",
			"file.ts",
			true,
			cleanSave,
			true,
		)
		assert.equal(result, "Saved file.ts.\n\nDiagnostics: 3 problem(s) in file.ts.")
	})

	it("reports boolean save metadata as annotations rather than diffs", async () => {
		const result = await new WriteToFileTool()["finalizeResults"](
			createEnvironment(0),
			"/workspace/file.ts",
			"file.ts",
			true,
			{ ...cleanSave, userEdits: true, autoFormatting: true },
			true,
		)
		assert.equal(
			result,
			"Saved file.ts.\n\nUser changes (preserve these):\nUser made manual changes in the editor.\n\nAuto-formatting:\nApplied by the editor.",
		)
	})
})
