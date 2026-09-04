import { expect } from "chai"
import { describe, it } from "mocha"
import { SyntaxFeedbackProvider } from "../SyntaxFeedbackProvider"

describe("SyntaxFeedbackProvider", () => {
	it("returns empty feedback for unsupported file extensions", async () => {
		const provider = new SyntaxFeedbackProvider()
		const result = await provider.getDiagnosticsFeedback("/workspace/readme.md", "# Hello\n", [])
		expect(result).to.deep.equal({ newProblemsMessage: "", fixedCount: 0 })
	})

	it("returns empty feedback for files with no extension", async () => {
		const provider = new SyntaxFeedbackProvider()
		const result = await provider.getDiagnosticsFeedback("/workspace/LICENSE", "MIT License\n", [])
		expect(result).to.deep.equal({ newProblemsMessage: "", fixedCount: 0 })
	})
})
