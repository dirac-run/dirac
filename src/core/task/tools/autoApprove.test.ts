import assert from "node:assert/strict"
import { SETTINGS_DEFAULTS, type Settings } from "@shared/storage/state-keys"
import { DiracDefaultTool } from "@shared/tools"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { AutoApprove, resolveBrowserLaunchPermission, resolveCommandApproval } from "./autoApprove"

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

describe("AutoApprove condensation policy", () => {
	for (const readFiles of [false, true]) {
		for (const readFilesExternally of [false, true]) {
			it(`uses workspace read approval independently of external reads (read: ${readFiles}, external: ${readFilesExternally})`, () => {
				const currentSettings = settings()
				currentSettings.yoloModeToggled = false
				currentSettings.autoApproveAllToggled = false
				currentSettings.autoApprovalSettings.actions.readFiles = readFiles
				currentSettings.autoApprovalSettings.actions.readFilesExternally = readFilesExternally
				const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
				const autoApprove = new AutoApprove(permissions as any, currentSettings, false)

				assert.equal(autoApprove.shouldAutoApproveTool(DiracDefaultTool.CONDENSE), readFiles)
			})
		}
	}

	for (const setting of ["yoloModeToggled", "autoApproveAllToggled"] as const) {
		it(`allows condensation with ${setting} even when read approval is disabled`, () => {
			const currentSettings = settings()
			currentSettings.yoloModeToggled = false
			currentSettings.autoApproveAllToggled = false
			currentSettings[setting] = true
			currentSettings.autoApprovalSettings.actions.readFiles = false
			const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
			const autoApprove = new AutoApprove(permissions as any, currentSettings, false)

			assert.equal(autoApprove.shouldAutoApproveTool(DiracDefaultTool.CONDENSE), true)
		})
	}

	it("keeps child condensation owner-routed despite read and unrestricted approval settings", () => {
		const currentSettings = settings()
		currentSettings.yoloModeToggled = true
		currentSettings.autoApproveAllToggled = true
		currentSettings.autoApprovalSettings.actions.readFiles = true
		const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
		const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)

		assert.equal(autoApprove.shouldAutoApproveTool(DiracDefaultTool.CONDENSE), false)
	})
})

describe("AutoApprove child static policy", () => {
	it("auto-approves only writes before settings, rules or workspace lookup", async () => {
		const permissions = commandPermissionController({ allowed: false, reason: "denied" })
		const settingsSource = sinon.stub().returns(settings())
		const autoApprove = new AutoApprove(permissions as any, settingsSource, false, true)
		const writes = [DiracDefaultTool.FILE_NEW, DiracDefaultTool.EDIT_FILE, DiracDefaultTool.EDIT_AST]

		for (const tool of Object.values(DiracDefaultTool)) {
			const isWrite = writes.includes(tool)
			assert.deepEqual(autoApprove.shouldAutoApproveTool(tool), isWrite ? [true, true] : false)
			for (const filePath of [undefined, "/workspace/file.ts", "/outside/file.ts"]) {
				assert.equal(await autoApprove.shouldAutoApproveToolWithPath(tool, filePath), isWrite)
				assert.equal(await autoApprove.resolveToolPathPermission(tool, filePath), isWrite ? "auto_approve" : "manual_only")
			}
			assert.equal(autoApprove.shouldAutoApproveWithRules(tool, "/workspace/file.ts"), false)
		}
		assert.equal(autoApprove.isUnrestrictedAutoApprove(), false)
		sinon.assert.notCalled(settingsSource)
		sinon.assert.notCalled(permissions.validateTool)
	})

	it("keeps browser launches manual-only despite unrestricted settings and allow rules", () => {
		const currentSettings = settings()
		currentSettings.yoloModeToggled = true
		currentSettings.autoApproveAllToggled = true
		currentSettings.autoApprovalSettings.actions.useBrowser = true
		const permissions = commandPermissionController({ allowed: true, reason: "allowed", matchedPattern: "**" })
		const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)

		assert.equal(resolveBrowserLaunchPermission("https://example.com", autoApprove, permissions as any), "manual_only")
		sinon.assert.notCalled(permissions.validateTool)
	})
})

describe("resolveCommandApproval child static policy", () => {
	for (const utilityEnabled of [false, true]) {
		for (const executeCommands of [false, true]) {
			it(`requires every command and shell segment to be statically approved (Utility: ${utilityEnabled}, executeCommands: ${executeCommands})`, () => {
				const currentSettings = settings()
				currentSettings.autoApprovalSettings.actions.executeCommands = executeCommands
				const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
				const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)

				assert.deepEqual(resolveCommandApproval(["ls -la", "@backend:git status", "pwd && echo hello"], utilityEnabled, autoApprove, permissions as any), {
					required: false, utilityEligible: false,
				})
				for (const commands of [["ls", "curl https://example.com"], ["pwd && curl https://example.com"], ["ls > out.txt"]]) {
					assert.deepEqual(resolveCommandApproval(commands, utilityEnabled, autoApprove, permissions as any), {
						required: true, utilityEligible: true,
					})
				}
				sinon.assert.calledWithExactly(permissions.validateTool, "execute_command", "git status")
			})
		}

		it(`honors user-approved command segments with safe-command settings disabled (Utility: ${utilityEnabled})`, () => {
			const currentSettings = settings()
			currentSettings.autoApprovalSettings.actions.executeCommands = false
			currentSettings.userApprovedCommands = [{ command: "npm test", match: "prefix" }]
			const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
			const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)

			assert.deepEqual(resolveCommandApproval(["pwd && npm test -- --runInBand 2>&1"], utilityEnabled, autoApprove, permissions as any), {
				required: false, utilityEligible: false,
			})
			assert.deepEqual(resolveCommandApproval(["npm test && curl https://example.com"], utilityEnabled, autoApprove, permissions as any), {
				required: true, utilityEligible: true,
			})
		})

		it(`honors explicit command allow rules (Utility: ${utilityEnabled})`, () => {
			const currentSettings = settings()
			currentSettings.autoApprovalSettings.actions.executeCommands = false
			const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
			permissions.validateTool.withArgs("execute_command", "npm run build").returns({ allowed: true, reason: "allowed", matchedPattern: "npm run build" })
			const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)

			assert.deepEqual(resolveCommandApproval(["ls", "npm run build"], utilityEnabled, autoApprove, permissions as any), {
				required: false, utilityEligible: false,
			})
		})

		it(`keeps deny rules manual-only before safe or user-approved shortcuts (Utility: ${utilityEnabled})`, () => {
			const currentSettings = settings()
			currentSettings.yoloModeToggled = true
			currentSettings.userApprovedCommands = [{ command: "npm test", match: "exact" }]
			const permissions = commandPermissionController({ allowed: false, reason: "denied" })
			const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)
			const commandCheck = sinon.spy(autoApprove, "isCommandAutoApproved")

			for (const command of ["ls", "npm test"]) {
				assert.deepEqual(resolveCommandApproval([command], utilityEnabled, autoApprove, permissions as any), {
					required: true, utilityEligible: false,
				})
			}
			sinon.assert.notCalled(commandCheck)
		})

		it(`does not inherit blanket YOLO or Auto-Approve-All command bypasses (Utility: ${utilityEnabled})`, () => {
			for (const setting of ["yoloModeToggled", "autoApproveAllToggled"] as const) {
				const currentSettings = settings()
				currentSettings[setting] = true
				const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
				const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)

				assert.deepEqual(resolveCommandApproval(["curl https://example.com"], utilityEnabled, autoApprove, permissions as any), {
					required: true, utilityEligible: true,
				})
			}
		})

		it(`keeps upsert smoke commands manual-only before static approval (Utility: ${utilityEnabled})`, () => {
			const currentSettings = settings()
			currentSettings.yoloModeToggled = true
			currentSettings.userApprovedCommands = [{ command: "npx tsx", match: "prefix" }]
			const permissions = commandPermissionController({ allowed: true, reason: "allowed", matchedPattern: "**" })
			const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)
			const commandCheck = sinon.spy(autoApprove, "isCommandAutoApproved")

			assert.deepEqual(resolveCommandApproval(["npx tsx test-harness.ts"], utilityEnabled, autoApprove, permissions as any, DiracDefaultTool.UPSERT_TOOL), {
				required: true, utilityEligible: false,
			})
			sinon.assert.notCalled(commandCheck)
			sinon.assert.notCalled(permissions.validateTool)
		})
	}

	it("preserves root safe-command settings and legacy unrestricted precedence", () => {
		const currentSettings = settings()
		currentSettings.autoApprovalSettings.actions.executeCommands = false
		const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
		const autoApprove = new AutoApprove(permissions as any, currentSettings, false)

		assert.deepEqual(resolveCommandApproval(["ls"], true, autoApprove, permissions as any), { required: true, utilityEligible: true })
		currentSettings.yoloModeToggled = true
		permissions.validateTool.returns({ allowed: false, reason: "denied" })
		assert.deepEqual(resolveCommandApproval(["curl https://example.com"], false, autoApprove, permissions as any), { required: false, utilityEligible: false })
		assert.deepEqual(resolveCommandApproval(["curl https://example.com"], true, autoApprove, permissions as any), { required: true, utilityEligible: false })
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
