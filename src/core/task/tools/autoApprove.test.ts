import assert from "node:assert/strict"
import { SETTINGS_DEFAULTS, type Settings } from "@shared/storage/state-keys"
import { DiracDefaultTool } from "@shared/tools"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { CommandPermissionController } from "@/core/permissions/CommandPermissionController"
import { COMMAND_PERMISSIONS_ENV_VAR } from "@/core/permissions/types"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { AutoApprove, resolveBrowserLaunchPermission, resolveCommandApproval } from "./autoApprove"

function settings(): Settings {
	return structuredClone(SETTINGS_DEFAULTS) as Settings
}

function commandPermissionController(result: { allowed: boolean; reason: string; matchedPattern?: string }) {
	return { assertConfigurationValid: sinon.stub(), validateTool: sinon.stub().returns(result) }
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

	it("keeps child condensation owner-routed with Auto-Approve-All and read approval", () => {
		const currentSettings = settings()
		currentSettings.yoloModeToggled = false
		currentSettings.autoApproveAllToggled = true
		currentSettings.autoApprovalSettings.actions.readFiles = true
		const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
		const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)

		assert.equal(autoApprove.shouldAutoApproveTool(DiracDefaultTool.CONDENSE), false)
	})
})

describe("AutoApprove child static policy", () => {
	afterEach(() => sinon.restore())

	it("keeps non-write paths owner-routed with Auto-Approve-All without consulting rules", async () => {
		const permissions = commandPermissionController({ allowed: false, reason: "denied" })
		const currentSettings = settings()
		currentSettings.yoloModeToggled = false
		currentSettings.autoApproveAllToggled = true
		const settingsSource = sinon.stub().returns(currentSettings)
		const autoApprove = new AutoApprove(permissions as any, settingsSource, false, true)
		const writes = [DiracDefaultTool.FILE_NEW, DiracDefaultTool.EDIT_FILE, DiracDefaultTool.EDIT_AST]

		for (const tool of Object.values(DiracDefaultTool).filter((tool) => !writes.includes(tool))) {
			assert.equal(autoApprove.shouldAutoApproveTool(tool), false)
			assert.equal(await autoApprove.shouldAutoApproveToolWithPath(tool, "/workspace/file.ts"), false)
			assert.equal(await autoApprove.resolveToolPathPermission(tool, "/workspace/file.ts"), "manual_only")
			assert.equal(autoApprove.shouldAutoApproveWithRules(tool, "/workspace/file.ts"), false)
		}
		assert.equal(autoApprove.isUnrestrictedAutoApprove(), false)
		sinon.assert.called(settingsSource)
		sinon.assert.notCalled(permissions.validateTool)
	})

	for (const tool of [DiracDefaultTool.FILE_NEW, DiracDefaultTool.EDIT_FILE, DiracDefaultTool.EDIT_AST]) {
		it(`uses current parent edit settings and exact path rules for child ${tool}`, async () => {
			stubWorkspace()
			const currentSettings = settings()
			currentSettings.autoApprovalSettings.actions.editFiles = false
			currentSettings.autoApprovalSettings.actions.editFilesExternally = false
			const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
			const autoApprove = new AutoApprove(permissions as any, () => currentSettings, false, true)

			assert.deepEqual(autoApprove.shouldAutoApproveTool(tool), [false, false])
			assert.equal(await autoApprove.shouldAutoApproveToolWithPath(tool, "/workspace/file.ts"), false)
			assert.equal(await autoApprove.resolveToolPathPermission(tool, "/workspace/file.ts"), "utility_eligible")
			currentSettings.autoApprovalSettings.actions.editFiles = true
			assert.deepEqual(autoApprove.shouldAutoApproveTool(tool), [true, false])
			assert.equal(await autoApprove.shouldAutoApproveToolWithPath(tool, "/workspace/file.ts"), true)
			assert.equal(await autoApprove.resolveToolPathPermission(tool, "/workspace/file.ts"), "auto_approve")

			permissions.validateTool.withArgs(tool, "/workspace/private.ts").returns({ allowed: false, reason: "denied" })
			assert.equal(await autoApprove.shouldAutoApproveToolWithPath(tool, "/workspace/private.ts"), false)
			assert.equal(await autoApprove.resolveToolPathPermission(tool, "/workspace/private.ts"), "manual_only")
			sinon.assert.calledWithExactly(permissions.validateTool, tool, "/workspace/private.ts")
			currentSettings.autoApprovalSettings.actions.editFiles = false
			assert.equal(await autoApprove.shouldAutoApproveToolWithPath(tool, "/workspace/file.ts"), false)
		})

		it(`honors external-write policy and explicit allow rules for child ${tool}`, async () => {
			stubWorkspace()
			const currentSettings = settings()
			currentSettings.autoApprovalSettings.actions.editFiles = false
			const permissions = commandPermissionController({ allowed: true, reason: "allowed", matchedPattern: "src/**" })
			const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)
			assert.equal(await autoApprove.shouldAutoApproveToolWithPath(tool, "src/file.ts"), true)
			assert.equal(await autoApprove.resolveToolPathPermission(tool, "src/file.ts"), "auto_approve")
			currentSettings.autoApprovalSettings.actions.editFiles = true
			currentSettings.autoApprovalSettings.actions.editFilesExternally = true
			assert.equal(await autoApprove.shouldAutoApproveToolWithPath(tool, "/outside/file.ts"), false)
			assert.equal(await autoApprove.resolveToolPathPermission(tool, "/outside/file.ts"), "manual_only")
		})

		it(`does not let child Auto-Approve-All bypass a denied ${tool} path`, async () => {
			stubWorkspace()
			const currentSettings = settings()
			currentSettings.yoloModeToggled = false
			currentSettings.autoApproveAllToggled = true
			const permissions = commandPermissionController({ allowed: false, reason: "denied" })
			const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)
			assert.equal(await autoApprove.shouldAutoApproveToolWithPath(tool, "/workspace/private.ts"), false)
			assert.equal(await autoApprove.resolveToolPathPermission(tool, "/workspace/private.ts"), "manual_only")
		})
	}

	it("keeps browser launches manual-only with Auto-Approve-All and allow rules", () => {
		const currentSettings = settings()
		currentSettings.yoloModeToggled = false
		currentSettings.autoApproveAllToggled = true
		currentSettings.autoApprovalSettings.actions.useBrowser = true
		const permissions = commandPermissionController({ allowed: true, reason: "allowed", matchedPattern: "**" })
		const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)

		assert.equal(resolveBrowserLaunchPermission("https://example.com", autoApprove, permissions as any), "manual_only")
		sinon.assert.notCalled(permissions.validateTool)
	})
})

describe("AutoApprove live child YOLO policy", () => {
	afterEach(() => sinon.restore())

	it("switches reads, writes, browser launches, and condensation with the live owner's YOLO setting", async () => {
		stubWorkspace()
		let currentSettings = settings()
		const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
		const child = new AutoApprove(permissions as any, () => currentSettings, false, true)
		const root = new AutoApprove(permissions as any, () => currentSettings, false)
		const reads = [
			DiracDefaultTool.FILE_READ, DiracDefaultTool.INSPECT_AST, DiracDefaultTool.DIAGNOSTICS_SCAN,
			DiracDefaultTool.LIST_FILES, DiracDefaultTool.SEARCH,
		]
		const writes = [DiracDefaultTool.FILE_NEW, DiracDefaultTool.EDIT_FILE, DiracDefaultTool.EDIT_AST]

		for (const yoloModeToggled of [false, true, false]) {
			currentSettings = settings()
			currentSettings.yoloModeToggled = yoloModeToggled
			currentSettings.autoApproveAllToggled = false
			currentSettings.autoApprovalSettings.actions.readFiles = false
			currentSettings.autoApprovalSettings.actions.editFiles = false
			currentSettings.autoApprovalSettings.actions.useBrowser = false
			assert.equal(child.requiresCounterpartyApproval, !yoloModeToggled)
			assert.equal(child.isUnrestrictedAutoApprove(), yoloModeToggled)

			for (const tool of [...reads, ...writes]) {
				assert.deepEqual(
					child.shouldAutoApproveTool(tool),
					yoloModeToggled ? [true, true] : writes.includes(tool) ? [false, false] : false,
				)
				assert.equal(await child.shouldAutoApproveToolWithPath(tool, "/workspace/file.ts"), yoloModeToggled)
				assert.equal(
					await child.resolveToolPathPermission(tool, "/workspace/file.ts"),
					yoloModeToggled ? "auto_approve" : writes.includes(tool) ? "utility_eligible" : "manual_only",
				)
				if (yoloModeToggled) {
					assert.deepEqual(child.shouldAutoApproveTool(tool), root.shouldAutoApproveTool(tool))
					assert.equal(await child.shouldAutoApproveToolWithPath(tool, "/outside/file.ts"), true)
				}
			}
			assert.equal(child.shouldAutoApproveTool(DiracDefaultTool.CONDENSE), yoloModeToggled)
			assert.equal(child.shouldAutoApproveTool(DiracDefaultTool.BROWSER), yoloModeToggled)
			assert.equal(
				resolveBrowserLaunchPermission("https://example.com", child, permissions as any),
				yoloModeToggled ? "auto_approve" : "manual_only",
			)
		}
	})

	it("preserves root Utility path and browser restrictions in child YOLO", async () => {
		stubWorkspace()
		const currentSettings = settings()
		currentSettings.yoloModeToggled = true
		const permissions = commandPermissionController({ allowed: false, reason: "denied" })
		for (const isSubagent of [false, true]) {
			const autoApprove = new AutoApprove(permissions as any, currentSettings, false, isSubagent)
			assert.equal(await autoApprove.shouldAutoApproveToolWithPath(DiracDefaultTool.EDIT_FILE, "/workspace/private.ts"), true)
			for (const tool of [DiracDefaultTool.FILE_READ, DiracDefaultTool.EDIT_FILE]) {
				assert.equal(await autoApprove.resolveToolPathPermission(tool, "/workspace/private.ts"), "manual_only")
			}
			assert.equal(resolveBrowserLaunchPermission("https://example.com", autoApprove, permissions as any), "manual_only")
			permissions.validateTool.returns({ allowed: true, reason: "no_config" })
			assert.equal(await autoApprove.resolveToolPathPermission(DiracDefaultTool.EDIT_FILE, "/outside/file.ts"), "manual_only")
			permissions.validateTool.returns({ allowed: false, reason: "denied" })
		}
	})

	for (const utilityEnabled of [false, true]) {
		for (const { command, tool, utilityEligible } of [
			{ command: "curl https://example.com", tool: DiracDefaultTool.EXECUTE_COMMAND, utilityEligible: true },
			{ command: "ls > out.txt", tool: DiracDefaultTool.EXECUTE_COMMAND, utilityEligible: true },
			{
				command: "pwd && npm test -- --runInBand 2>&1",
				tool: DiracDefaultTool.EXECUTE_COMMAND,
				utilityEligible: false,
			},
			{ command: "npx tsx test-harness.ts", tool: DiracDefaultTool.UPSERT_TOOL, utilityEligible: false },
		] as const) {
			it(`switches child ${tool} approval for ${command} with live YOLO (Utility: ${utilityEnabled})`, () => {
				const currentSettings = settings()
				currentSettings.autoApproveAllToggled = true
				const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
				const child = new AutoApprove(permissions as any, () => currentSettings, false, true)
				for (const yoloModeToggled of [false, true, false]) {
					currentSettings.yoloModeToggled = yoloModeToggled
					assert.deepEqual(resolveCommandApproval([command], utilityEnabled, child, permissions as any, tool), {
						required: !yoloModeToggled,
						utilityEligible: !yoloModeToggled && utilityEligible,
					})
				}
			})
		}

		it(`preserves root command deny precedence in child YOLO (Utility: ${utilityEnabled})`, () => {
			const currentSettings = settings()
			currentSettings.yoloModeToggled = true
			const permissions = commandPermissionController({ allowed: false, reason: "denied" })
			for (const isSubagent of [false, true]) {
				const autoApprove = new AutoApprove(permissions as any, currentSettings, false, isSubagent)
				for (const tool of [DiracDefaultTool.EXECUTE_COMMAND, DiracDefaultTool.UPSERT_TOOL] as const) {
					assert.deepEqual(
						resolveCommandApproval(["curl https://example.com"], utilityEnabled, autoApprove, permissions as any, tool),
						{ required: utilityEnabled, utilityEligible: false },
					)
				}
			}
		})
	}
})

describe("invalid configuration blocks unrestricted automatic authorization", () => {
	for (const flag of ["autoApproveAllToggled", "yoloModeToggled"] as const) {
		for (const utilityEnabled of [false, true]) {
			it(`blocks ${flag} commands and paths with Utility ${utilityEnabled}`, async () => {
				expectLoggerErrors()
				const original = process.env[COMMAND_PERMISSIONS_ENV_VAR]
				process.env[COMMAND_PERMISSIONS_ENV_VAR] = "{invalid"
				const permissions = new CommandPermissionController()
				try {
					const currentSettings = settings()
					currentSettings[flag] = true
					const approval = new AutoApprove(permissions, currentSettings, false)
					assert.throws(
						() => resolveCommandApproval(["npm test"], utilityEnabled, approval, permissions),
						/Invalid .* configuration/,
					)
					assert.throws(() => approval.isUnrestrictedAutoApprove(), /Invalid .* configuration/)
					assert.throws(
						() => approval.shouldAutoApproveTool(DiracDefaultTool.EXECUTE_COMMAND),
						/Invalid .* configuration/,
					)
					await assert.rejects(
						approval.shouldAutoApproveToolWithPath(DiracDefaultTool.EDIT_FILE, "src/index.ts"),
						/Invalid .* configuration/,
					)
				} finally {
					if (original === undefined) delete process.env[COMMAND_PERMISSIONS_ENV_VAR]
					else process.env[COMMAND_PERMISSIONS_ENV_VAR] = original
					await permissions.dispose()
				}
			})
		}
	}
})

describe("resolveCommandApproval child static policy", () => {
	for (const utilityEnabled of [false, true]) {
		for (const executeCommands of [false, true]) {
			it(`requires every command and shell segment to be statically approved (Utility: ${utilityEnabled}, executeCommands: ${executeCommands})`, () => {
				const currentSettings = settings()
				currentSettings.autoApprovalSettings.actions.executeCommands = executeCommands
				const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
				const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)

				assert.deepEqual(
					resolveCommandApproval(
						["ls -la", "@backend:git status", "pwd && echo hello", "nl -ba src/index.ts | head -220"],
						utilityEnabled,
						autoApprove,
						permissions as any,
					),
					{
						required: false,
						utilityEligible: false,
					},
				)
				for (const commands of [
					["ls", "curl https://example.com"],
					["pwd && curl https://example.com"],
					["ls > out.txt"],
				]) {
					assert.deepEqual(resolveCommandApproval(commands, utilityEnabled, autoApprove, permissions as any), {
						required: true,
						utilityEligible: true,
					})
				}
				sinon.assert.calledWithExactly(permissions.validateTool, "execute_command", "git status")
			})
		}

		it(`does not salvage an unknown compound through user-approved segments (Utility: ${utilityEnabled})`, () => {
			const currentSettings = settings()
			currentSettings.autoApprovalSettings.actions.executeCommands = false
			currentSettings.userApprovedCommands = [{ command: "npm test", match: "prefix" }]
			const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
			const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)

			assert.deepEqual(
				resolveCommandApproval(["pwd && npm test -- --runInBand 2>&1"], utilityEnabled, autoApprove, permissions as any),
				{
					required: true,
					utilityEligible: false,
				},
			)
			assert.deepEqual(
				resolveCommandApproval(["npm test && curl https://example.com"], utilityEnabled, autoApprove, permissions as any),
				{
					required: true,
					utilityEligible: true,
				},
			)
		})

		it(`honors explicit command allow rules (Utility: ${utilityEnabled})`, () => {
			const currentSettings = settings()
			currentSettings.autoApprovalSettings.actions.executeCommands = false
			const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
			permissions.validateTool
				.withArgs("execute_command", "npm test")
				.returns({ allowed: true, reason: "allowed", matchedPattern: "npm test" })
			const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)

			assert.deepEqual(resolveCommandApproval(["ls", "npm test"], utilityEnabled, autoApprove, permissions as any), {
				required: false,
				utilityEligible: false,
			})
		})

		it(`keeps deny rules manual-only before safe or user-approved shortcuts (Utility: ${utilityEnabled})`, () => {
			const currentSettings = settings()
			currentSettings.yoloModeToggled = false
			currentSettings.autoApproveAllToggled = true
			currentSettings.userApprovedCommands = [{ command: "npm test", match: "exact" }]
			const permissions = commandPermissionController({ allowed: false, reason: "denied" })
			const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)
			const commandCheck = sinon.spy(autoApprove, "isCommandAutoApproved")

			for (const command of ["ls", "npm test"]) {
				assert.deepEqual(resolveCommandApproval([command], utilityEnabled, autoApprove, permissions as any), {
					required: true,
					utilityEligible: false,
				})
			}
			sinon.assert.notCalled(commandCheck)
		})

		it(`does not inherit blanket Auto-Approve-All command bypasses (Utility: ${utilityEnabled})`, () => {
			const currentSettings = settings()
			currentSettings.yoloModeToggled = false
			currentSettings.autoApproveAllToggled = true
			const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
			const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)

			assert.deepEqual(
				resolveCommandApproval(["curl https://example.com"], utilityEnabled, autoApprove, permissions as any),
				{ required: true, utilityEligible: true },
			)
		})

		it(`keeps upsert smoke commands manual-only before static approval (Utility: ${utilityEnabled})`, () => {
			const currentSettings = settings()
			currentSettings.yoloModeToggled = false
			currentSettings.autoApproveAllToggled = true
			currentSettings.userApprovedCommands = [{ command: "npx tsx", match: "prefix" }]
			const permissions = commandPermissionController({ allowed: true, reason: "allowed", matchedPattern: "**" })
			const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)
			const commandCheck = sinon.spy(autoApprove, "isCommandAutoApproved")

			assert.deepEqual(
				resolveCommandApproval(
					["npx tsx test-harness.ts"],
					utilityEnabled,
					autoApprove,
					permissions as any,
					DiracDefaultTool.UPSERT_TOOL,
				),
				{
					required: true,
					utilityEligible: false,
				},
			)
			sinon.assert.notCalled(commandCheck)
			sinon.assert.notCalled(permissions.validateTool)
		})
	}

	it("does not widen exact command entries through shell expansion or parser normalization", () => {
		const currentSettings = settings()
		currentSettings.userApprovedCommands = [
			{ command: "ls", match: "exact" },
			{ command: "npm test", match: "exact" },
		]
		const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
		const autoApprove = new AutoApprove(permissions as any, currentSettings, false, true)
		for (const command of ["ls $OPTIONS", 'ls "$OPTIONS"', "npm test $OPTIONS", "ls *.ts", "ls `pwd`", "ls $(pwd)"]) {
			assert.equal(autoApprove.isCommandAutoApproved(command), false, command)
		}
		assert.equal(autoApprove.isCommandAutoApproved("npm test"), true)
		assert.equal(autoApprove.isCommandAutoApproved("pwd && npm test"), false)
		assert.equal(autoApprove.isCommandAutoApproved("(ls)"), true)
	})

	it("preserves root safe-command settings and legacy unrestricted precedence", () => {
		const currentSettings = settings()
		currentSettings.autoApprovalSettings.actions.executeCommands = false
		const permissions = commandPermissionController({ allowed: true, reason: "no_config" })
		const autoApprove = new AutoApprove(permissions as any, currentSettings, false)

		assert.deepEqual(resolveCommandApproval(["ls"], true, autoApprove, permissions as any), {
			required: true,
			utilityEligible: true,
		})
		currentSettings.yoloModeToggled = true
		permissions.validateTool.returns({ allowed: false, reason: "denied" })
		assert.deepEqual(resolveCommandApproval(["curl https://example.com"], false, autoApprove, permissions as any), {
			required: false,
			utilityEligible: false,
		})
		assert.deepEqual(resolveCommandApproval(["curl https://example.com"], true, autoApprove, permissions as any), {
			required: true,
			utilityEligible: false,
		})
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
