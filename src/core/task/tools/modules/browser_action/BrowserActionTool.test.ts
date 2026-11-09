import assert from "node:assert/strict"
import { describe, it } from "mocha"
import sinon from "sinon"
import "should"
import { browser_action_spec, BrowserActionTool } from "./BrowserActionTool"

function createPermissionEnvironment() {
	const validateTool = sinon.stub().returns({ allowed: true, reason: "no_config" })
	const isUnrestrictedAutoApprove = sinon.stub().returns(false)
	const shouldAutoApproveTool = sinon.stub().returns(false)
	return {
		env: {
			config: {
				autoApprover: { isUnrestrictedAutoApprove, shouldAutoApproveTool },
				services: { commandPermissionController: { assertConfigurationValid: sinon.stub(), validateTool } },
			},
		},
		validateTool,
		isUnrestrictedAutoApprove,
		shouldAutoApproveTool,
	}
}

describe("BrowserActionTool", () => {
	it("intercepts browser permissions before unrestricted and matching-rule approvals", () => {
		const tool = new BrowserActionTool()
		const { env, validateTool, isUnrestrictedAutoApprove, shouldAutoApproveTool } = createPermissionEnvironment()
			; (env.config.autoApprover as any).requiresCounterpartyApproval = true
		isUnrestrictedAutoApprove.returns(true)
		validateTool.returns({ allowed: true, reason: "allowed", matchedPattern: "**" })

		assert.equal((tool as any).resolveLaunchPermission(env, "https://example.com"), "manual_only")
		sinon.assert.notCalled(validateTool)
		sinon.assert.notCalled(isUnrestrictedAutoApprove)
		sinon.assert.notCalled(shouldAutoApproveTool)
	})

	it("strips the data URL prefix and preserves the screenshot media type", async () => {
		const tool = new BrowserActionTool()
		const blocks = await (tool as any).formatBrowserActionResult(
			"launch",
			{
				currentUrl: "https://example.com",
				logs: "",
				screenshot: "data:image/png;base64,cG5nLWJ5dGVz",
			},
			undefined,
		)

		blocks[1].should.deepEqual({
			type: "image",
			source: {
				type: "base64",
				media_type: "image/png",
				data: "cG5nLWJ5dGVz",
			},
		})
	})

	it("constrains actions with an enum", () => {
		const action = browser_action_spec.parameters?.find((parameter) => parameter.name === "action")

		assert.ok(action)
		assert.deepEqual(action.enum, ["launch", "click", "type", "scroll_down", "scroll_up", "close"])
	})

	it("keeps explicit browser deny rules manual-only even in unrestricted mode", () => {
		const tool = new BrowserActionTool()
		const { env, validateTool, isUnrestrictedAutoApprove } = createPermissionEnvironment()
		validateTool.returns({ allowed: false, reason: "denied" })
		isUnrestrictedAutoApprove.returns(true)

		assert.equal((tool as any).resolveLaunchPermission(env, "https://example.com"), "manual_only")
	})

	it("auto-approves browser URLs matched by an explicit allow rule", () => {
		const tool = new BrowserActionTool()
		const { env, validateTool } = createPermissionEnvironment()
		validateTool.returns({ allowed: true, reason: "allowed", matchedPattern: "https://example.com/*" })

		assert.equal((tool as any).resolveLaunchPermission(env, "https://example.com/page"), "auto_approve")
	})

	it("keeps unmatched browser launches Utility-eligible", () => {
		const tool = new BrowserActionTool()
		const { env } = createPermissionEnvironment()

		assert.equal((tool as any).resolveLaunchPermission(env, "https://example.com"), "utility_eligible")
	})
	it("preserves the legacy browser prompt when Utility handling is disabled", async () => {
		const tool = new BrowserActionTool()
		const permissionCard = {
			waitForInteraction: sinon.stub().resolves({ action: "approve" }),
			update: sinon.stub().resolves(),
			finalize: sinon.stub().resolves(),
		}
		const createCard = sinon.stub().resolves(permissionCard)
		const launch = sinon.stub().resolves({ currentUrl: "https://example.com", logs: "", screenshot: "" })
		const resolveLaunchPermission = sinon.stub(tool as any, "resolveLaunchPermission").returns("auto_approve")
		const env = {
			config: {
				autoApprover: {
					isUnrestrictedAutoApprove: sinon.stub().returns(true),
					shouldAutoApproveTool: sinon.stub().returns(true),
				},
				services: {
					commandPermissionController: { assertConfigurationValid: sinon.stub(), validateTool: sinon.stub().returns({ allowed: true, reason: "allowed" }) },
				},
			},
			ui: { createCard, upsertText: sinon.stub().resolves() },
			browser: { launch, close: sinon.stub().resolves() },
			orchestration: { getTaskState: sinon.stub().returns(0), setTaskState: sinon.stub() },
		}

		await tool.processCall({ action: "launch", url: "https://example.com" }, env as any)

		sinon.assert.notCalled(resolveLaunchPermission)
		sinon.assert.calledWithMatch(createCard, { requireApproval: true })
		sinon.assert.calledOnce(permissionCard.waitForInteraction)
		sinon.assert.calledOnce(launch)
	})
})
