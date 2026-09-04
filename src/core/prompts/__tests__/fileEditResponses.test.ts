import { strict as assert } from "node:assert"
import * as path from "node:path"
import { describe, it } from "mocha"
import "@utils/path"
import { formatResponse } from "@core/formatResponse"

describe("file edit responses", () => {
	it("reports a clean save without boilerplate or absent diagnostics", () => {
		assert.equal(formatResponse.fileEditWithoutUserChanges("src/file.ts", undefined, undefined), "Saved src/file.ts.")
		assert.equal(formatResponse.fileEditWithoutUserChanges("src/file.ts", "", ""), "Saved src/file.ts.")
	})

	it("retains formatting details and diagnostics only when supplied", () => {
		assert.equal(
			formatResponse.fileEditWithoutUserChanges("file.ts", "-old\n+formatted", "Diagnostics: 2 problems."),
			"Saved file.ts.\n\nAuto-formatting:\n-old\n+formatted\n\nDiagnostics: 2 problems.",
		)
	})

	it("retains user edits with a concise preservation notice", () => {
		assert.equal(
			formatResponse.fileEditWithUserChanges("file.ts", "-old\n+user change", undefined, undefined),
			"Saved file.ts.\n\nUser changes (preserve these):\n-old\n+user change",
		)
	})

	it("retains all additional save information together", () => {
		assert.equal(
			formatResponse.fileEditWithUserChanges("file.ts", "user diff", "format diff", "Diagnostics: 1 problem."),
			"Saved file.ts.\n\nUser changes (preserve these):\nuser diff\n\nAuto-formatting:\nformat diff\n\nDiagnostics: 1 problem.",
		)
	})

	it("limits external-change instructions to the affected files", () => {
		const result = formatResponse.fileContextWarning(["one.ts", "two.ts"])
		assert.ok(result.includes(path.resolve("one.ts").toPosix()))
		assert.ok(result.includes(path.resolve("two.ts").toPosix()))
		assert.ok(result.includes("Externally modified files:"))
		assert.ok(result.includes("Read the current state before modifying these files"))
		assert.ok(result.includes("include_anchors: true"))
		assert.ok(!/CRITICAL|After any edit/.test(result))
	})
})
