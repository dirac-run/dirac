import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import type { ICardHandle } from "../../interfaces/ICardHandle"
import type { TaskConfig } from "../../types/TaskConfig"
import { buildEditorTrait } from "../traits/EditorTraitBuilder"

describe("EditorTraitBuilder review ownership", () => {
	const files = [{ absolutePath: "/a.ts", displayPath: "a.ts", content: "proposal" }]

	function create(routesToOwner: boolean) {
		const showReview = sinon.stub().resolves()
		const config = {
			taskId: "owning-conversation",
			taskMessenger: { routesToOwner },
			services: { diffViewProvider: { showReview } },
			callbacks: {},
		} as unknown as TaskConfig
		return { editor: buildEditorTrait(config), showReview }
	}

	it("passes the owning conversation and exact interaction to the editor", async () => {
		const { editor, showReview } = create(false)
		const card = { id: "permission-card", requiresUserInteraction: true } as ICardHandle

		await editor.showReview(files, card)

		sinon.assert.calledOnceWithExactly(showReview, files, { taskId: "owning-conversation", cardId: "permission-card" })
	})

	for (const routesToOwner of [true, false]) {
		it(`does not expose approval for ${routesToOwner ? "private owner-routed" : "automatically approved"} previews`, async () => {
			const { editor, showReview } = create(routesToOwner)
			// Even a legacy child handle claiming user interaction cannot bypass ownership.
			const card = { id: "private-card", requiresUserInteraction: routesToOwner } as ICardHandle

			await editor.showReview(files, card)

			sinon.assert.calledOnceWithExactly(showReview, files, undefined)
			assert.equal(showReview.firstCall.args[1], undefined)
		})
	}
})
