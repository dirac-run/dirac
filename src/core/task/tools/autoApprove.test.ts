import assert from "node:assert/strict"
import { SETTINGS_DEFAULTS, type Settings } from "@shared/storage/state-keys"
import { DiracDefaultTool } from "@shared/tools"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { AutoApprove } from "./autoApprove"

function settings(): Settings {
	return structuredClone(SETTINGS_DEFAULTS) as Settings
}

function commandPermissionController(result: { allowed: boolean; reason: string; matchedPattern?: string }) {
	return { validateTool: sinon.stub().returns(result) }
}

function stubWorkspace(workspacePath = "/workspace"): void {
	sinon.stub(HostProvider, "workspace").value({
		getWorkspacePaths: sinon.stub().callsFake(async () => ({ paths: [workspacePath] })),
	})
}

describe("AutoApprove counterparty interception", () => {
	it("blocks every automatic approval path before settings, rules or workspace lookup", async () => {
		const currentSettings = settings()
		currentSettings.yoloModeToggled = true
		currentSettings.autoApproveAllToggled = true
		currentSettings.userApprovedCommands = [{ command: "npm test", match: "exact" }]
		const permissions = commandPermissionController({ allowed: true, reason: "allowed", matchedPattern: "**" })
		const settingsSource = sinon.stub().returns(currentSettings)
		const autoApprove = new AutoApprove(permissions as any, settingsSource, false, true)

		for (const tool of Object.values(DiracDefaultTool)) {
			assert.equal(autoApprove.shouldAutoApproveTool(tool), false)
			assert.equal(await autoApprove.shouldAutoApproveToolWithPath(tool, "/workspace/file.ts"), false)
			assert.equal(await autoApprove.resolveToolPathPermission(tool, "/workspace/file.ts"), "manual_only")
			assert.equal(autoApprove.shouldAutoApproveWithRules(tool, "/workspace/file.ts"), false)
		}
		assert.equal(autoApprove.isCommandAutoApproved("npm test"), false)
		assert.equal(autoApprove.isCommandAutoApproved("ls"), false)
		assert.equal(autoApprove.isUnrestrictedAutoApprove(), false)
		sinon.assert.notCalled(settingsSource)
		sinon.assert.notCalled(permissions.validateTool)
	})
})

describe("AutoApprove.resolveToolPathPermission", () => {
	afterEach(() => sinon.restore())

	it("keeps external writes manual-only in unrestricted mode", async () => {
		stubWorkspace()
		const currentSettings = settings()
		currentSettings.yoloModeToggled = true
		const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
		const autoApprove = new AutoApprove(permissions as any, currentSettings, false)

		assert.equal(await autoApprove.resolveToolPathPermission(DiracDefaultTool.FILE_NEW, "/outside/file.ts"), "manual_only")
		sinon.assert.notCalled(permissions.validateTool)
	})

	it("keeps explicit deny rules manual-only in unrestricted mode", async () => {
		const currentSettings = settings()
		currentSettings.autoApproveAllToggled = true
		const permissions = commandPermissionController({ allowed: false, reason: "denied" })
		const autoApprove = new AutoApprove(permissions as any, currentSettings, false)

		assert.equal(await autoApprove.resolveToolPathPermission(DiracDefaultTool.EXECUTE_COMMAND, undefined), "manual_only")
	})

	it("marks residual local writes as Utility-eligible", async () => {
		stubWorkspace()
		const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
		const autoApprove = new AutoApprove(permissions as any, settings(), false)

		assert.equal(await autoApprove.resolveToolPathPermission(DiracDefaultTool.EDIT_FILE, "src/index.ts"), "utility_eligible")
	})

	it("auto-approves local writes matched by an explicit allow rule", async () => {
		stubWorkspace()
		const permissions = commandPermissionController({
			allowed: true,
			reason: "allowed",
			matchedPattern: "src/**",
		})
		const autoApprove = new AutoApprove(permissions as any, settings(), false)

		assert.equal(await autoApprove.resolveToolPathPermission(DiracDefaultTool.EDIT_FILE, "src/index.ts"), "auto_approve")
	})

	it("preserves legacy YOLO approval for external writes", async () => {
		stubWorkspace()
		const currentSettings = settings()
		currentSettings.yoloModeToggled = true
		const permissions = commandPermissionController({ allowed: false, reason: "denied" })
		const autoApprove = new AutoApprove(permissions as any, currentSettings, false)

		assert.equal(await autoApprove.shouldAutoApproveToolWithPath(DiracDefaultTool.FILE_NEW, "/outside/file.ts"), true)
		sinon.assert.notCalled(permissions.validateTool)
	})

	it("preserves legacy Auto-Approve-All precedence over permission rules", async () => {
		const currentSettings = settings()
		currentSettings.autoApproveAllToggled = true
		const permissions = commandPermissionController({ allowed: false, reason: "denied" })
		const autoApprove = new AutoApprove(permissions as any, currentSettings, false)

		assert.equal(await autoApprove.shouldAutoApproveToolWithPath(DiracDefaultTool.EXECUTE_COMMAND, undefined), true)
		sinon.assert.notCalled(permissions.validateTool)
	})

	it("preserves the legacy external-write prompt outside unrestricted modes", async () => {
		stubWorkspace()
		const permissions = commandPermissionController({ allowed: true, reason: "allowed", matchedPattern: "**" })
		const autoApprove = new AutoApprove(permissions as any, settings(), false)

		assert.equal(await autoApprove.shouldAutoApproveToolWithPath(DiracDefaultTool.FILE_NEW, "/outside/file.ts"), false)
		sinon.assert.notCalled(permissions.validateTool)
	})
})
