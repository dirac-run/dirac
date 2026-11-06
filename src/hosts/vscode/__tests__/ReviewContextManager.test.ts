import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import proxyquire from "proxyquire"
import sinon from "sinon"
import type * as vscode from "vscode"
import { URI } from "vscode-uri"
import type { EditorReviewRequest } from "@shared/editorReview"
import type { TabManager } from "../TabManager"

function createReviewHost() {
	const contexts = new Map<string, boolean>()
	const window = {
		activeTextEditor: undefined as vscode.TextEditor | undefined,
		onDidChangeActiveTextEditor: () => ({ dispose() {} }),
	}
	const executeCommand = sinon.spy(async (command: string, ...args: any[]) => {
		if (command === "setContext") contexts.set(args[0], args[1])
	})
	const { ReviewContextManager } = proxyquire("../ReviewContextManager", {
		vscode: {
			"@noCallThru": true,
			Uri: URI,
			window,
			workspace: { onDidChangeTextDocument: () => ({ dispose() {} }) },
			commands: { executeCommand },
		},
	}) as typeof import("../ReviewContextManager")
	const reviews: InstanceType<typeof ReviewContextManager>[] = []
	function create(owner: string) {
		const tabs = {
			reviewTitle: owner,
			originalUri: (path: string, content: string, cardId?: string) =>
				URI.file(path).with({
					scheme: "dirac-diff",
					query: Buffer.from(content).toString("base64"),
					fragment: `${owner}/${cardId ?? "preview"}`,
				}),
		} as unknown as TabManager
		const review = new ReviewContextManager(tabs)
		reviews.push(review)
		return review
	}
	function preview(index: number): vscode.Uri {
		return executeCommand.getCalls().filter((call) => call.args[0] === "vscode.changes")[index].args[2][0][2]
	}
	function focus(uri: vscode.Uri) {
		window.activeTextEditor = { document: { uri, getText: () => "proposal" } } as vscode.TextEditor
	}
	return {
		ReviewContextManager,
		create,
		preview,
		focus,
		contexts,
		dispose: () => reviews.forEach((review) => review.hideReview()),
	}
}

const files = [{ absolutePath: "/shared.ts", displayPath: "shared.ts", content: "proposal", originalContent: "original" }]

describe("ReviewContextManager exact requests", () => {
	let host: ReturnType<typeof createReviewHost> | undefined
	afterEach(() => host?.dispose())

	it("keeps same-file previews bound to their own request despite focus changes", async () => {
		host = createReviewHost()
		const first = host.create("first-provider")
		const second = host.create("second-provider")
		const firstRequest: EditorReviewRequest = { taskId: "root-one", cardId: "first-card" }
		const secondRequest: EditorReviewRequest = { taskId: "root-two", cardId: "second-card" }
		await first.showReview(files, firstRequest)
		await second.showReview(files, secondRequest)
		const firstPreview = host.preview(0)
		const secondPreview = host.preview(1)

		host.focus(secondPreview)
		assert.deepEqual(host.ReviewContextManager.getRequest(firstPreview), firstRequest)
		assert.deepEqual(host.ReviewContextManager.getRequest(), secondRequest)
		assert.equal(host.ReviewContextManager.getRequest(URI.file("/shared.ts") as vscode.Uri), undefined)
		first.hideReview()
		assert.equal(host.ReviewContextManager.getRequest(firstPreview), undefined)
		assert.deepEqual(host.ReviewContextManager.getRequest(secondPreview), secondRequest)
	})

	it("retires the old preview when an identical operation gets a fresh card", async () => {
		host = createReviewHost()
		const review = host.create("provider")
		await review.showReview(files, { taskId: "root", cardId: "old-card" })
		const oldPreview = host.preview(0)
		await review.showReview(files, { taskId: "root", cardId: "new-card" })
		const newPreview = host.preview(1)

		assert.notEqual(oldPreview.toString(), newPreview.toString())
		assert.equal(host.ReviewContextManager.getRequest(oldPreview), undefined)
		assert.deepEqual(host.ReviewContextManager.getRequest(newPreview), { taskId: "root", cardId: "new-card" })
	})

	it("never makes an informational private preview or ordinary file actionable", async () => {
		host = createReviewHost()
		const review = host.create("private-provider")
		await review.showReview(files)
		host.focus(host.preview(0))
		await review.showReview(files)

		assert.equal(host.ReviewContextManager.getRequest(), undefined)
		assert.equal(host.contexts.get("dirac.isFileUnderReview"), false)
		assert.equal(host.contexts.get("dirac.isFileModified"), false)
	})

	it("rejects an unidentified approval request", async () => {
		host = createReviewHost()
		await assert.rejects(host.create("provider").showReview(files, { taskId: "root", cardId: "" }), /exact task and card/)
	})
})
