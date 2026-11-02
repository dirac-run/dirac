import assert from "node:assert/strict"
import { describe, it } from "mocha"
import sinon from "sinon"
import { createCardFromMessenger } from "../traits/UiTraitBuilder"
import type { CardParams, PermissionOperation } from "../../interfaces/ICardHandle"
import type { TaskConfig } from "../../types/TaskConfig"

describe("Tasklet permission metadata", () => {
	async function forward(params: CardParams) {
		const createCard = sinon.stub().resolves({})
		const config = { taskMessenger: { routesToOwner: true, createCard },
			toolUse: { name: "some_tool", params: { input: "original" } } } as unknown as TaskConfig
		await createCardFromMessenger(config, params, [])
		return createCard.firstCall.args[0]
	}

	it("classifies unannotated tool approval as permission, never ordinary input", async () => {
		const result = await forward({ header: "Permission", requireApproval: true })
		assert.deepEqual(result.permissionOperation, { kind: "tool", manualOnly: false })
		assert.deepEqual(result.toolCall, { name: "some_tool", arguments: { input: "original" } })
	})

	it("keeps explicit operational choices and questions outside security grants", async () => {
		for (const params of [{ requireApproval: true, operationalInput: true }, { requireFeedback: true }]) {
			const result = await forward({ header: "Input", ...params })
			assert.equal(result.permissionOperation, undefined)
		}
	})

	it("retains runtime-resolved normalized commands and affected files", async () => {
		const operations: PermissionOperation[] = [
			{ kind: "commands", commands: ["python3 <<'EOF_EXACT'\nprint('hi')\nEOF_EXACT"] },
			{ kind: "paths", paths: ["src/definition.ts", "other/reference.ts"] },
			{ kind: "browser", url: "https://example.com" },
		]
		for (const permissionOperation of operations) {
			const result = await forward({ header: "Permission", requireApproval: true, permissionOperation })
			assert.deepEqual(result.permissionOperation, permissionOperation)
		}
	})
})
