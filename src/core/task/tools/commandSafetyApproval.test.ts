import assert from "node:assert/strict"
import { SETTINGS_DEFAULTS, type Settings } from "@shared/storage/state-keys"
import { describe, it } from "mocha"
import sinon from "sinon"
import { AutoApprove, resolveCommandApproval } from "./autoApprove"
import { DEFAULT_COMMAND_CAPABILITIES, mergeCommandCapabilities } from "./utils/CommandSafetyChecker"

// Classify strings only: none of these candidate commands are executed.
describe("command capability approval integration", () => {
	for (const child of [false, true]) {
		function approvalContext(executeCommands = true, currentCapabilities = () => DEFAULT_COMMAND_CAPABILITIES) {
			const settings = structuredClone(SETTINGS_DEFAULTS) as Settings
			settings.yoloModeToggled = false
			settings.autoApproveAllToggled = false
			settings.userApprovedCommands = []
			settings.autoApprovalSettings.actions.executeCommands = executeCommands
			const permissions = {
				assertConfigurationValid: sinon.stub(),
				validateTool: sinon.stub().returns({ allowed: true, reason: "no_config" }),
			}
			return {
				settings,
				permissions,
				approval: new AutoApprove(permissions as any, settings, false, child, currentCapabilities),
			}
		}

		it(`${child ? "child" : "main"} approves known default reads and normalized workspace commands`, () => {
			const { permissions, approval } = approvalContext()
			assert.deepEqual(resolveCommandApproval([
				"ls -la", "@backend:git status", "git log -5 --oneline", "find . -name '*.ts'", "(ls)",
			], false, approval, permissions), { required: false, utilityEligible: false })
			sinon.assert.calledWithExactly(permissions.validateTool, "execute_command", "git status")
		})

		for (const command of ["npm test", "ls > out.txt", "curl https://example.com", "sed -n '1p' input.txt"]) {
			it(`${child ? "child" : "main"} requires approval for a known deficit: ${command}`, () => {
				const { permissions, approval } = approvalContext()
				for (const utility of [false, true]) {
					assert.deepEqual(resolveCommandApproval([command], utility, approval, permissions), {
						required: true, utilityEligible: true,
					})
				}
			})
		}

		for (const command of ["unknown_command_xyz", "ls && unknown_command_xyz", "ls $OPTIONS", "npm test -- --runInBand"]) {
			it(`${child ? "child" : "main"} keeps unknown manual even with grants and explicit patterns: ${command}`, () => {
				const { settings, permissions, approval } = approvalContext(true, () => (1 << 30) - 1)
				settings.userApprovedCommands = [{ command, match: "exact" }]
				permissions.validateTool.returns({ allowed: true, reason: "allowed", matchedPattern: "**" })
				assert.equal(approval.isCommandAutoApproved(command), false)
				for (const utility of [false, true]) {
					assert.deepEqual(resolveCommandApproval([command], utility, approval, permissions), {
						required: true, utilityEligible: false,
					})
				}
			})
		}

		it(`${child ? "child" : "main"} observes grants live without weakening denied rules`, () => {
			let capabilities = DEFAULT_COMMAND_CAPABILITIES
			const { permissions, approval } = approvalContext(true, () => capabilities)
			assert.equal(approval.isCommandAutoApproved("npm test"), false)
			capabilities = mergeCommandCapabilities(capabilities, 1 << 9)
			assert.equal(approval.isCommandAutoApproved("npm test"), true)
			assert.equal(approval.isCommandAutoApproved("rm file.txt"), false)
			assert.deepEqual(resolveCommandApproval(["npm test"], false, approval, permissions), {
				required: false, utilityEligible: false,
			})
			permissions.validateTool.returns({ allowed: false, reason: "denied" })
			assert.deepEqual(resolveCommandApproval(["npm test"], false, approval, permissions), {
				required: true, utilityEligible: false,
			})
		})

		it(`${child ? "child" : "main"} keeps the root automatic-command setting as its master gate`, () => {
			const { permissions, approval } = approvalContext(false, () => (1 << 30) - 1)
			assert.deepEqual(resolveCommandApproval(["npm test"], false, approval, permissions), {
				required: !child, utilityEligible: !child,
			})
		})

		it(`${child ? "child" : "main"} preserves literal user approvals without parser-normalization widening`, () => {
			const { settings, approval } = approvalContext(false)
			settings.userApprovedCommands = [{ command: "npm test", match: "exact" }]
			assert.equal(approval.isCommandAutoApproved("npm test"), true)
			assert.equal(approval.isCommandAutoApproved("(npm test)"), false)
			assert.equal(approval.isCommandAutoApproved("pwd && npm test"), false)
			settings.userApprovedCommands.push({ command: "pwd", match: "exact" })
			assert.equal(approval.isCommandAutoApproved("pwd && npm test"), true)
		})

		for (const setting of ["yoloModeToggled", "autoApproveAllToggled"] as const) {
			it(`${child ? "child" : "main"} preserves explicit unrestricted ${setting} policy for unknown commands`, () => {
				const { settings, permissions, approval } = approvalContext()
				settings[setting] = true
				for (const utility of [false, true]) {
					assert.deepEqual(resolveCommandApproval(["unknown_command_xyz"], utility, approval, permissions), {
						required: child, utilityEligible: false,
					})
				}
			})
		}
	}
})
